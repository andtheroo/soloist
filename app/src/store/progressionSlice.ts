import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import { gainHeart, HeartsState, initialHearts, loseHeart, refillHearts } from '../game/hearts';
import { applyLessonResult, SkillProgress } from '../game/skillTree';
import { applyActivity, initialStreak, MAX_FREEZES, reconcileStreak, StreakState } from '../game/streak';
import type { XpBreakdown } from '../game/xp';
import type { SkillNodeDef } from '../types/chart';

/**
 * Long-lived, persisted learner progression (Duolingo loop):
 *   session -> XP -> daily goal -> streak -> crowns -> unlocks, with hearts as the stakes.
 * Reducers are pure: callers supply `day` (local date key) and `now` (epoch ms) and the
 * skill definition, so this slice never reads clocks or catalogs.
 */
export interface LessonRecord {
  completions: number;
  bestAccuracy: number;
  bestStars: number;
}

export interface SessionRecord {
  at: number; // epoch ms
  day: string;
  kind: 'lesson' | 'practice';
  skillId: string | null;
  lessonId: string | null;
  chartId: string | null;
  accuracy: number;
  stars: number;
  xp: number;
  meanOffsetMs: number;
}

export interface ProgressionState {
  totalXp: number;
  xpByDay: Record<string, number>; // pruned to the last 60 days
  dailyGoalXp: number;
  streak: StreakState;
  hearts: HeartsState;
  skills: Record<string, SkillProgress>;
  lessons: Record<string, LessonRecord>;
  history: SessionRecord[]; // newest last, capped
  lastLevelUp: { skillId: string; level: number } | null;
}

export const initialProgression: ProgressionState = {
  totalXp: 0,
  xpByDay: {},
  dailyGoalXp: 20,
  streak: initialStreak,
  hearts: initialHearts(0),
  skills: {},
  lessons: {},
  history: [],
  lastLevelUp: null,
};

export interface SessionCompletedPayload {
  day: string;
  now: number;
  skill: SkillNodeDef;
  lessonId: string;
  accuracy: number;
  stars: number;
  passed: boolean;
  meanOffsetMs: number;
  xp: XpBreakdown;
}

export interface PracticeCompletedPayload {
  day: string;
  now: number;
  skillId: string | null;
  chartId: string;
  bestAccuracy: number;
  meanOffsetMs: number;
  xp: XpBreakdown;
}

const HISTORY_CAP = 200;

function addXp(state: ProgressionState, day: string, xp: number) {
  state.totalXp += xp;
  state.xpByDay[day] = (state.xpByDay[day] ?? 0) + xp;
  const keys = Object.keys(state.xpByDay).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete state.xpByDay[k];
}

function pushHistory(state: ProgressionState, r: SessionRecord) {
  state.history.push(r);
  if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
}

const progressionSlice = createSlice({
  name: 'progression',
  initialState: initialProgression,
  reducers: {
    sessionCompleted(state, { payload: p }: PayloadAction<SessionCompletedPayload>) {
      addXp(state, p.day, p.xp.total);
      // Any completed micro-session keeps the streak alive (showing up is the habit we
      // reward; passing is what earns crowns).
      state.streak = applyActivity(state.streak, p.day);

      const rec = state.lessons[p.lessonId] ?? { completions: 0, bestAccuracy: 0, bestStars: 0 };
      state.lessons[p.lessonId] = {
        completions: rec.completions + 1,
        bestAccuracy: Math.max(rec.bestAccuracy, p.accuracy),
        bestStars: Math.max(rec.bestStars, p.stars),
      };

      const { progress, leveledUp } = applyLessonResult(
        p.skill, state.skills[p.skill.id], p.lessonId, p.passed, p.accuracy,
      );
      state.skills[p.skill.id] = progress;
      state.lastLevelUp = leveledUp ? { skillId: p.skill.id, level: progress.level } : null;

      pushHistory(state, {
        at: p.now, day: p.day, kind: 'lesson', skillId: p.skill.id, lessonId: p.lessonId, chartId: null,
        accuracy: p.accuracy, stars: p.stars, xp: p.xp.total, meanOffsetMs: p.meanOffsetMs,
      });
    },

    /** Practice earns a little XP, keeps the streak, and wins back one heart. */
    practiceCompleted(state, { payload: p }: PayloadAction<PracticeCompletedPayload>) {
      if (p.xp.total <= 0) return;
      addXp(state, p.day, p.xp.total);
      state.streak = applyActivity(state.streak, p.day);
      state.hearts = gainHeart(state.hearts, p.now);
      pushHistory(state, {
        at: p.now, day: p.day, kind: 'practice', skillId: p.skillId, lessonId: null, chartId: p.chartId,
        accuracy: p.bestAccuracy, stars: 0, xp: p.xp.total, meanOffsetMs: p.meanOffsetMs,
      });
    },

    heartLost(state, { payload }: PayloadAction<{ now: number }>) {
      state.hearts = loseHeart(state.hearts, payload.now);
    },

    /** Dispatch on app foreground / day change: refills hearts, reconciles streaks. */
    dayChanged(state, { payload }: PayloadAction<{ day: string; now: number }>) {
      state.streak = reconcileStreak(state.streak, payload.day);
      state.hearts = refillHearts(state.hearts, payload.now);
    },

    /** Onboarding placement: skip skills the player already knows (1 crown each). */
    placementApplied(state, { payload }: PayloadAction<{ skillIds: string[] }>) {
      for (const id of payload.skillIds) {
        const cur = state.skills[id];
        if (!cur || cur.level < 1) state.skills[id] = { level: 1, lessonsPassedAtLevel: [], bestAccuracy: cur?.bestAccuracy ?? 0 };
      }
    },

    streakFreezePurchased(state, { payload }: PayloadAction<{ costXp: number }>) {
      // Freezes are bought with XP for the MVP (no currency system yet).
      if (state.streak.freezes >= MAX_FREEZES || state.totalXp < payload.costXp) return;
      state.streak.freezes += 1;
      state.totalXp -= payload.costXp;
    },

    dailyGoalSet(state, { payload }: PayloadAction<number>) {
      state.dailyGoalXp = payload;
    },

    levelUpAcknowledged(state) {
      state.lastLevelUp = null;
    },

    progressionReset: () => initialProgression,
  },
});

export const progressionActions = progressionSlice.actions;
export default progressionSlice.reducer;

// ---------- selectors (take the slice) ----------
export const selectXpToday = (s: ProgressionState, day: string) => s.xpByDay[day] ?? 0;
export const selectDailyGoalProgress = (s: ProgressionState, day: string) =>
  Math.min(1, selectXpToday(s, day) / s.dailyGoalXp);
export const selectCrowns = (s: ProgressionState) =>
  Object.values(s.skills).reduce((a, p) => a + p.level, 0);
export const selectRecentTiming = (s: ProgressionState, n = 10) => {
  const recent = s.history.slice(-n).filter((h) => h.accuracy > 0);
  if (!recent.length) return null;
  return {
    accuracy: recent.reduce((a, h) => a + h.accuracy, 0) / recent.length,
    meanOffsetMs: recent.reduce((a, h) => a + h.meanOffsetMs, 0) / recent.length,
  };
};
