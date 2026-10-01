import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { GradeSummary } from '../grading/types';
import type { Exercise } from '../types/chart';

/**
 * The 3-minute micro-session state machine (not persisted).
 *
 *  idle ─request─▶ loading ─loaded─▶ ready ─countIn─▶ countIn ─start─▶ playing ⇄ paused
 *                     │                                                 │
 *                     └──────▶ error                     exerciseFinished
 *                                                                        ▼
 *                        playing ◀─nextExercise── exerciseReview ──(budget spent)──▶ complete
 *
 * The time budget counts *active playing time* only; the current exercise always
 * finishes (never cut a learner off mid-riff), then the session wraps up.
 */
export type SessionPhase =
  | 'idle' | 'loading' | 'ready' | 'countIn' | 'playing' | 'paused' | 'exerciseReview' | 'complete' | 'error';

export interface ExerciseResult {
  exerciseId: string;
  summary: GradeSummary;
  activeMs: number;
}

export interface SessionState {
  phase: SessionPhase;
  lessonId: string | null;
  skillId: string | null;
  exercises: Exercise[];
  exerciseIndex: number;
  budgetMs: number;
  activeMs: number;
  exerciseActiveMs: number;
  results: ExerciseResult[];
  live: { combo: number; score: number; hits: number; judged: number };
  error: string | null;
  endedReason: 'finished' | 'budget' | 'hearts' | 'quit' | null;
}

export const DEFAULT_BUDGET_MS = 180_000;

const initialState: SessionState = {
  phase: 'idle',
  lessonId: null,
  skillId: null,
  exercises: [],
  exerciseIndex: 0,
  budgetMs: DEFAULT_BUDGET_MS,
  activeMs: 0,
  exerciseActiveMs: 0,
  results: [],
  live: { combo: 0, score: 0, hits: 0, judged: 0 },
  error: null,
  endedReason: null,
};

const resetLive = (s: SessionState) => {
  s.live = { combo: 0, score: 0, hits: 0, judged: 0 };
  s.exerciseActiveMs = 0;
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    sessionRequested(state, { payload }: PayloadAction<{ lessonId: string; skillId: string }>) {
      Object.assign(state, initialState, { phase: 'loading', ...payload });
    },
    sessionLoaded(state, { payload }: PayloadAction<{ exercises: Exercise[]; budgetMs?: number }>) {
      if (state.phase !== 'loading') return;
      state.exercises = payload.exercises;
      state.budgetMs = payload.budgetMs ?? DEFAULT_BUDGET_MS;
      state.phase = payload.exercises.length ? 'ready' : 'error';
      if (!payload.exercises.length) state.error = 'Lesson has no exercises';
    },
    sessionFailed(state, { payload }: PayloadAction<string>) {
      state.phase = 'error';
      state.error = payload;
    },
    countInStarted(state) {
      if (state.phase === 'ready' || state.phase === 'exerciseReview') state.phase = 'countIn';
    },
    playbackStarted(state) {
      if (state.phase === 'countIn' || state.phase === 'paused') state.phase = 'playing';
    },
    paused(state) {
      if (state.phase === 'playing') state.phase = 'paused';
    },
    /** Driven by the audio pump with real elapsed audio time. */
    tick(state, { payload }: PayloadAction<{ deltaMs: number }>) {
      if (state.phase !== 'playing') return;
      const d = Math.max(0, Math.min(payload.deltaMs, 1000)); // ignore giant gaps (app suspended)
      state.activeMs += d;
      state.exerciseActiveMs += d;
    },
    /** combo/score are absolute (from the grader); hits/judged are increments. */
    gradesRecorded(state, { payload }: PayloadAction<{ combo: number; score: number; hits: number; judged: number }>) {
      state.live.combo = payload.combo;
      state.live.score = payload.score;
      state.live.hits += payload.hits;
      state.live.judged += payload.judged;
    },
    exerciseFinished(state, { payload }: PayloadAction<GradeSummary>) {
      if (state.phase !== 'playing' && state.phase !== 'paused') return;
      state.results.push({
        exerciseId: state.exercises[state.exerciseIndex].id,
        summary: payload,
        activeMs: state.exerciseActiveMs,
      });
      const more = state.exerciseIndex + 1 < state.exercises.length;
      const timeLeft = state.activeMs < state.budgetMs;
      // Review screen shows after every exercise (retry is offered there); the session
      // completes from the review when nothing is left.
      state.phase = 'exerciseReview';
      if (!more || !timeLeft) state.endedReason = more ? 'budget' : 'finished';
    },
    nextExercise(state) {
      if (state.phase !== 'exerciseReview') return;
      if (state.endedReason) {
        state.phase = 'complete';
        return;
      }
      state.exerciseIndex += 1;
      resetLive(state);
      state.phase = 'countIn';
    },
    /** "Retry" from the review screen — replaces the last result. */
    exerciseRetried(state) {
      if (state.phase !== 'exerciseReview' || state.activeMs >= state.budgetMs) return;
      state.results.pop();
      state.endedReason = null;
      resetLive(state);
      state.phase = 'countIn';
    },
    /** Out of hearts or the player quit: keep what was earned so far. */
    sessionEndedEarly(state, { payload }: PayloadAction<'hearts' | 'quit'>) {
      state.endedReason = payload;
      state.phase = state.results.length ? 'complete' : 'idle';
    },
    sessionReset: () => initialState,
  },
});

export const sessionActions = sessionSlice.actions;
export default sessionSlice.reducer;

export const selectCanRetry = (s: SessionState) => s.activeMs < s.budgetMs;
export const selectTimeRemainingMs = (s: SessionState) => Math.max(0, s.budgetMs - s.activeMs);
export const selectCurrentExercise = (s: SessionState): Exercise | undefined => s.exercises[s.exerciseIndex];
export const selectSessionAccuracy = (s: SessionState) =>
  s.results.length ? s.results.reduce((a, r) => a + r.summary.accuracy, 0) / s.results.length : 0;
