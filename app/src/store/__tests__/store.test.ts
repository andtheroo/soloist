import { HEART_REFILL_MS, MAX_HEARTS } from '../../game/hearts';
import type { GradeSummary } from '../../grading/types';
import type { SkillNodeDef } from '../../types/chart';
import { progressionActions, selectCrowns, selectDailyGoalProgress } from '../progressionSlice';
import { makeStore } from '../rootReducer';
import { selectTimeRemainingMs, sessionActions } from '../sessionSlice';
import { settingsActions } from '../settingsSlice';
import { finishPractice, finishSession } from '../thunks';

const skill: SkillNodeDef = { id: 'basics', title: 'Basics', prerequisites: [], lessonIds: ['b1'], maxLevel: 3 };
const summary = (accuracy: number, meanOffsetMs = 0): GradeSummary => ({
  totalNotes: 10,
  counts: { perfect: 10, great: 0, good: 0, miss: 0, wrongPitch: 0 },
  accuracy, score: 1000, maxCombo: 10, meanOffsetMs, stdDevOffsetMs: 5,
  tendency: 'on-time', strayOnsets: 0,
  stars: accuracy >= 0.95 ? 3 : accuracy >= 0.8 ? 2 : accuracy >= 0.6 ? 1 : 0,
  passed: accuracy >= 0.6,
});
const exercises = [1, 2, 3].map((i) => ({ id: `e${i}`, title: `Ex ${i}`, chartId: `c${i}`, songId: `s${i}` }));

function startSession(store: ReturnType<typeof makeStore>, exs = exercises) {
  const d = store.dispatch;
  d(sessionActions.sessionRequested({ lessonId: 'b1', skillId: 'basics' }));
  d(sessionActions.sessionLoaded({ exercises: exs }));
  d(sessionActions.countInStarted());
  d(sessionActions.playbackStarted());
}

describe('micro-session state machine', () => {
  it('runs countIn -> playing -> review -> next and respects the 3-minute budget', () => {
    const store = makeStore();
    const d = store.dispatch;
    startSession(store);
    for (let i = 0; i < 100; i++) d(sessionActions.tick({ deltaMs: 900 })); // 90 s
    d(sessionActions.exerciseFinished(summary(0.9)));
    expect(store.getState().session.phase).toBe('exerciseReview');
    expect(store.getState().session.endedReason).toBe(null);
    expect(selectTimeRemainingMs(store.getState().session)).toBe(90_000);

    d(sessionActions.nextExercise());
    d(sessionActions.playbackStarted());
    d(sessionActions.tick({ deltaMs: 60_000 })); // clamped: app was suspended
    expect(store.getState().session.activeMs).toBe(91_000);
    for (let i = 0; i < 100; i++) d(sessionActions.tick({ deltaMs: 900 }));
    d(sessionActions.exerciseFinished(summary(0.97)));
    // Budget spent: review first, then the session wraps up (exercise 3 skipped).
    expect(store.getState().session.endedReason).toBe('budget');
    d(sessionActions.nextExercise());
    expect(store.getState().session.phase).toBe('complete');
    expect(store.getState().session.results).toHaveLength(2);
  });

  it('ignores ticks while paused', () => {
    const store = makeStore();
    startSession(store);
    store.dispatch(sessionActions.paused());
    store.dispatch(sessionActions.tick({ deltaMs: 500 }));
    expect(store.getState().session.activeMs).toBe(0);
  });

  it('ends early when out of hearts but keeps results', () => {
    const store = makeStore();
    startSession(store);
    store.dispatch(sessionActions.exerciseFinished(summary(0.3)));
    store.dispatch(sessionActions.sessionEndedEarly('hearts'));
    expect(store.getState().session.phase).toBe('complete');
    expect(store.getState().session.endedReason).toBe('hearts');
  });
});

describe('finishSession thunk', () => {
  it('awards XP, extends streak, earns a crown, records history', async () => {
    const store = makeStore();
    const d = store.dispatch;
    startSession(store, exercises.slice(0, 1));
    d(sessionActions.exerciseFinished(summary(1, -14)));

    const report = jest.fn().mockResolvedValue(undefined);
    const now = new Date(2026, 8, 27, 20);
    const res = await d(finishSession({ skill, now, report })).unwrap();

    expect(res.xp.total).toBe(10 + 10 + 5 + 5); // base + accuracy + flawless + new lesson
    expect(res.leveledUp).toBe(true);
    const p = store.getState().progression;
    expect(p.totalXp).toBe(30);
    expect(p.streak.current).toBe(1);
    expect(p.skills.basics.level).toBe(1);
    expect(selectCrowns(p)).toBe(1);
    expect(selectDailyGoalProgress(p, '2026-09-27')).toBe(1);
    expect(p.history).toHaveLength(1);
    expect(p.history[0]).toMatchObject({ kind: 'lesson', lessonId: 'b1', meanOffsetMs: -14 });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('a lesson cut short by the budget does not earn a crown', async () => {
    const store = makeStore();
    startSession(store); // 3 exercises
    store.dispatch(sessionActions.exerciseFinished(summary(1)));
    store.dispatch(sessionActions.sessionEndedEarly('quit'));
    const res = await store.dispatch(finishSession({ skill })).unwrap();
    expect(res.leveledUp).toBe(false);
    expect(res.xp.total).toBeGreaterThan(0);
  });
});

describe('hearts, practice and placement', () => {
  it('loses hearts, refills over time, and practice earns one back', async () => {
    const store = makeStore();
    const t0 = 1_000_000;
    store.dispatch(progressionActions.heartLost({ now: t0 }));
    store.dispatch(progressionActions.heartLost({ now: t0 + 1000 }));
    expect(store.getState().progression.hearts.hearts).toBe(MAX_HEARTS - 2);
    store.dispatch(progressionActions.dayChanged({ day: '2026-09-27', now: t0 + HEART_REFILL_MS + 5 }));
    expect(store.getState().progression.hearts.hearts).toBe(MAX_HEARTS - 1);

    const res = await store
      .dispatch(finishPractice({ chartId: 'pent-up', skillId: 'pentatonic', passes: [summary(0.7), summary(0.92)] }))
      .unwrap();
    expect(res.xp.total).toBe(3 + 5);
    expect(store.getState().progression.hearts.hearts).toBe(MAX_HEARTS);
    expect(store.getState().progression.history[0].kind).toBe('practice');
  });

  it('practice with no completed pass gives nothing', async () => {
    const store = makeStore();
    const res = await store.dispatch(finishPractice({ chartId: 'x', skillId: null, passes: [] })).unwrap();
    expect(res.xp.total).toBe(0);
    expect(store.getState().progression.totalXp).toBe(0);
  });

  it('placement grants one crown per skipped skill', () => {
    const store = makeStore();
    store.dispatch(progressionActions.placementApplied({ skillIds: ['basics', 'rhythm'] }));
    expect(store.getState().progression.skills.rhythm.level).toBe(1);
    expect(selectCrowns(store.getState().progression)).toBe(2);
  });

  it('streak freeze purchase is capped and costs XP', () => {
    const store = makeStore({
      progression: { ...makeStore().getState().progression, totalXp: 500 },
    });
    for (let i = 0; i < 5; i++) store.dispatch(progressionActions.streakFreezePurchased({ costXp: 100 }));
    expect(store.getState().progression.streak.freezes).toBe(2);
    expect(store.getState().progression.totalXp).toBe(300);
  });
});

describe('settings', () => {
  it('normalises the server URL', () => {
    const store = makeStore();
    store.dispatch(settingsActions.serverUrlSet(' 192.168.1.20:4000/ '));
    expect(store.getState().settings.serverUrl).toBe('http://192.168.1.20:4000');
    store.dispatch(settingsActions.serverUrlSet(''));
    expect(store.getState().settings.serverUrl).toBe(null);
  });

  it('nudges calibration in 0.1 ms steps', () => {
    const store = makeStore();
    store.dispatch(settingsActions.calibrationSaved(12.34));
    store.dispatch(settingsActions.calibrationNudged(-5));
    expect(store.getState().settings.calibrationOffsetMs).toBe(7.3);
  });
});
