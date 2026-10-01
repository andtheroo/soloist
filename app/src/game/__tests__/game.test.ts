import type { SkillNodeDef } from '../../types/chart';
import {
  applyLessonResult, computeTiers, guideGainForLevel, lessonSpeedForLevel, placementSkills, recommendNext,
  skillStatus, validateTree,
} from '../skillTree';
import { addDays, applyActivity, dayDiff, initialStreak, reconcileStreak, streakStatus, toDayKey } from '../streak';
import { computePracticeXp, computeSessionXp, levelFromXp, xpForLevel } from '../xp';
import { gainHeart, HEART_REFILL_MS, loseHeart, MAX_HEARTS, msUntilNextHeart, refillHearts } from '../hearts';
import { readTuner } from '../tuning';

describe('streak', () => {
  it('computes day keys and diffs across month/DST boundaries', () => {
    expect(toDayKey(new Date(2026, 2, 8, 23, 30))).toBe('2026-03-08');
    expect(dayDiff('2026-02-28', '2026-03-01')).toBe(1);
    expect(dayDiff('2026-03-07', '2026-03-09')).toBe(2); // US DST change on 03-08
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('extends on consecutive days and ignores repeat sessions on the same day', () => {
    let s = applyActivity(initialStreak, '2026-09-01');
    s = applyActivity(s, '2026-09-01');
    s = applyActivity(s, '2026-09-02');
    expect(s.current).toBe(2);
    expect(s.longest).toBe(2);
  });

  it('breaks after a missed day without freezes', () => {
    let s = applyActivity(initialStreak, '2026-09-01');
    s = applyActivity(s, '2026-09-02');
    expect(streakStatus(s, '2026-09-03')).toBe('at-risk');
    expect(streakStatus(s, '2026-09-04')).toBe('broken');
    s = applyActivity(s, '2026-09-04');
    expect(s.current).toBe(1);
    expect(s.longest).toBe(2);
  });

  it('consumes freezes for missed days exactly once', () => {
    let s = { ...applyActivity(initialStreak, '2026-09-01'), freezes: 2 };
    s = reconcileStreak(s, '2026-09-04'); // missed 02 and 03
    expect(s.freezes).toBe(0);
    expect(s.frozenDays).toEqual(['2026-09-02', '2026-09-03']);
    s = reconcileStreak(s, '2026-09-04'); // idempotent
    expect(s.freezes).toBe(0);
    s = applyActivity(s, '2026-09-04');
    expect(s.current).toBe(2);
  });
});

describe('xp', () => {
  it('builds an itemised breakdown', () => {
    const xp = computeSessionXp({
      exercises: [{ accuracy: 1, stars: 3, passed: true }, { accuracy: 0.96, stars: 3, passed: true }],
      firstCompletion: true,
      streakDays: 14,
    });
    expect(xp.lines.map((l) => l.label)).toEqual([
      'Session complete', 'Accuracy 98%', 'Flawless', 'New lesson', '14-day streak',
    ]);
    expect(xp.total).toBe(10 + 10 + 5 + 5 + 2);
  });

  it('level curve is monotonic and levelFromXp inverts it', () => {
    for (let l = 1; l < 50; l++) expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
    expect(levelFromXp(0).level).toBe(1);
    expect(levelFromXp(xpForLevel(7)).level).toBe(7);
    expect(levelFromXp(xpForLevel(7) - 1).level).toBe(6);
  });
});

describe('skill tree', () => {
  const defs: SkillNodeDef[] = [
    { id: 'basics', title: 'Basics', prerequisites: [], lessonIds: ['b1', 'b2'], maxLevel: 3 },
    { id: 'pent', title: 'Pentatonic', prerequisites: ['basics'], lessonIds: ['p1'], maxLevel: 3 },
    { id: 'chords', title: 'Chords', prerequisites: ['basics'], lessonIds: ['c1'], maxLevel: 3 },
    { id: 'solo', title: 'First solo', prerequisites: ['pent', 'chords'], lessonIds: ['s1'], maxLevel: 5 },
  ];

  it('validates and tiers the DAG', () => {
    expect(validateTree(defs)).toEqual([]);
    expect(computeTiers(defs)).toEqual({ basics: 0, pent: 1, chords: 1, solo: 2 });
    const cyclic = [...defs.slice(1), { ...defs[0], prerequisites: ['solo'] }];
    expect(validateTree(cyclic).some((e) => e.startsWith('cycle'))).toBe(true);
  });

  it('levels up after passing every lesson and unlocks dependants', () => {
    let p = applyLessonResult(defs[0], undefined, 'b1', true, 0.9);
    expect(p.leveledUp).toBe(false);
    p = applyLessonResult(defs[0], p.progress, 'b1', true, 0.95); // repeat doesn't count twice
    expect(p.leveledUp).toBe(false);
    p = applyLessonResult(defs[0], p.progress, 'b2', true, 0.8);
    expect(p.leveledUp).toBe(true);
    expect(p.progress.level).toBe(1);
    const progress = { basics: p.progress };
    expect(skillStatus(defs[1], progress)).toBe('available');
    expect(skillStatus(defs[3], progress)).toBe('locked');
  });

  it('failed attempts only update best accuracy', () => {
    const p = applyLessonResult(defs[0], undefined, 'b1', false, 0.4);
    expect(p.progress.lessonsPassedAtLevel).toEqual([]);
    expect(p.progress.bestAccuracy).toBe(0.4);
  });

  it('recommends the lowest-tier open skill and fades the guide track', () => {
    expect(recommendNext(defs, {})).toEqual({ skillId: 'basics', lessonId: 'b1' });
    expect(guideGainForLevel(0, 3)).toBeCloseTo(0.9);
    expect(guideGainForLevel(3, 3)).toBe(0);
  });
});


describe('hearts', () => {
  it('refill one per period, never above max, clock starts when leaving full', () => {
    let h = { hearts: MAX_HEARTS, updatedAt: 0 };
    h = loseHeart(h, 1000);
    h = loseHeart(h, 2000);
    expect(h).toEqual({ hearts: MAX_HEARTS - 2, updatedAt: 1000 });
    expect(msUntilNextHeart(h, 2000)).toBe(HEART_REFILL_MS - 1000);
    expect(refillHearts(h, 1000 + 2 * HEART_REFILL_MS).hearts).toBe(MAX_HEARTS);
    expect(msUntilNextHeart(refillHearts(h, 1000 + 2 * HEART_REFILL_MS), 0)).toBe(null);
    expect(gainHeart({ hearts: MAX_HEARTS, updatedAt: 5 }, 10).hearts).toBe(MAX_HEARTS);
    expect(loseHeart({ hearts: 0, updatedAt: 0 }, 10).hearts).toBe(0);
  });
});

describe('placement, speed ramp, practice XP, tuner', () => {
  const tree: SkillNodeDef[] = [
    { id: 'basics', title: '', prerequisites: [], lessonIds: ['a'], maxLevel: 3 },
    { id: 'fretting', title: '', prerequisites: ['basics'], lessonIds: ['b'], maxLevel: 3 },
    { id: 'rhythm', title: '', prerequisites: ['basics'], lessonIds: ['c'], maxLevel: 3 },
    { id: 'power', title: '', prerequisites: ['fretting'], lessonIds: ['d'], maxLevel: 3 },
    { id: 'solo', title: '', prerequisites: ['power'], lessonIds: ['e'], maxLevel: 3 },
  ];
  it('places players by experience, never past the final tier', () => {
    expect(placementSkills(tree, 'new')).toEqual([]);
    expect(placementSkills(tree, 'some')).toEqual(['basics', 'fretting', 'rhythm']);
    expect(placementSkills(tree, 'experienced')).toEqual(['basics', 'fretting', 'rhythm', 'power']);
  });
  it('ramps tempo with crowns', () => {
    expect([0, 1, 2, 3].map(lessonSpeedForLevel)).toEqual([80, 90, 100, 100]);
  });
  it('practice XP rewards the best pass', () => {
    expect(computePracticeXp([]).total).toBe(0);
    expect(computePracticeXp([0.5, 1]).total).toBe(8);
  });
  it('tuner finds the nearest string and cents', () => {
    const r = readTuner(110 * Math.pow(2, 12 / 1200))!; // A2 +12 c
    expect(r.note).toBe('A2');
    expect(r.string.name).toBe('A');
    expect(r.cents).toBeCloseTo(12, 0);
    const lowE = readTuner(80)!; // flat low E
    expect(lowE.string.string).toBe(6);
    expect(lowE.centsFromString).toBeCloseTo(-51.3, 0);
    expect(readTuner(0)).toBe(null);
  });
});
