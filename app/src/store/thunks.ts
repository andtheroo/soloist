import { createAsyncThunk } from '@reduxjs/toolkit';

import { toDayKey } from '../game/streak';
import { computePracticeXp, computeSessionXp, XpBreakdown } from '../game/xp';
import type { GradeSummary } from '../grading/types';
import type { SkillNodeDef } from '../types/chart';
import { progressionActions } from './progressionSlice';
import type { RootState } from './rootReducer';

export interface FinishSessionArgs {
  skill: SkillNodeDef;
  now?: Date; // injectable for tests
  /** Optional server sync; failures never block local progress. */
  report?: (payload: unknown) => Promise<void>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Closes the Duolingo loop after a micro-session:
 *   results -> XP breakdown -> progression (XP, streak, crowns, history) -> server report.
 */
export const finishSession = createAsyncThunk<
  { xp: XpBreakdown; leveledUp: boolean },
  FinishSessionArgs,
  { state: RootState }
>('session/finish', async ({ skill, now = new Date(), report }, { getState, dispatch }) => {
  const { session, progression } = getState();
  if (!session.lessonId || session.results.length === 0) {
    return { xp: { lines: [], total: 0 }, leveledUp: false };
  }
  const outcomes = session.results.map((r) => ({
    accuracy: r.summary.accuracy,
    stars: r.summary.stars,
    passed: r.summary.passed,
  }));
  const xp = computeSessionXp({
    exercises: outcomes,
    firstCompletion: !progression.lessons[session.lessonId],
    streakDays: progression.streak.current,
  });
  // A lesson only counts toward a crown if every exercise was played and passed.
  const allPlayed = session.results.length === session.exercises.length;
  const passed = allPlayed && outcomes.every((o) => o.passed);

  dispatch(
    progressionActions.sessionCompleted({
      day: toDayKey(now),
      now: now.getTime(),
      skill,
      lessonId: session.lessonId,
      accuracy: mean(outcomes.map((o) => o.accuracy)),
      stars: Math.min(...outcomes.map((o) => o.stars)),
      passed,
      meanOffsetMs: mean(session.results.map((r) => r.summary.meanOffsetMs)),
      xp,
    }),
  );

  report?.({
    lessonId: session.lessonId,
    results: session.results,
    activeMs: session.activeMs,
    clientXp: xp.total,
    at: now.toISOString(),
  })?.catch(() => {
    /* best effort: the mock server is optional for progress */
  });

  return { xp, leveledUp: getState().progression.lastLevelUp !== null };
});

export interface FinishPracticeArgs {
  chartId: string;
  skillId: string | null;
  passes: GradeSummary[];
  now?: Date;
}

/** Practice session: XP for at least one full loop pass, plus one heart back. */
export const finishPractice = createAsyncThunk<{ xp: XpBreakdown }, FinishPracticeArgs, { state: RootState }>(
  'practice/finish',
  async ({ chartId, skillId, passes, now = new Date() }, { dispatch }) => {
    const xp = computePracticeXp(passes.map((p) => p.accuracy));
    if (xp.total > 0) {
      dispatch(
        progressionActions.practiceCompleted({
          day: toDayKey(now),
          now: now.getTime(),
          skillId,
          chartId,
          bestAccuracy: Math.max(...passes.map((p) => p.accuracy)),
          meanOffsetMs: mean(passes.map((p) => p.meanOffsetMs)),
          xp,
        }),
      );
    }
    return { xp };
  },
);
