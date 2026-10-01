/**
 * Daily streaks with streak freezes (Duolingo-style).
 *
 * Days are *local calendar days* as 'YYYY-MM-DD' keys, computed on device. Freezes are
 * consumed lazily (on app open or on activity) rather than by a midnight job, so the
 * logic is pure and works offline.
 */
export interface StreakState {
  current: number;
  longest: number;
  /** Last day covered by activity OR a consumed freeze. */
  lastCoveredDay: string | null;
  /** Last day with real activity (for "practised today" UI). */
  lastActiveDay: string | null;
  freezes: number;
  frozenDays: string[];
}

export const MAX_FREEZES = 2;

export const initialStreak: StreakState = {
  current: 0,
  longest: 0,
  lastCoveredDay: null,
  lastActiveDay: null,
  freezes: 0,
  frozenDays: [],
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-calendar day key. Pass the date explicitly so reducers stay pure. */
export function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from a to b (b - a). DST-proof: compares calendar dates in UTC. */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Bring the streak up to date for `today` without recording activity:
 * consume freezes for missed days, or break the streak if there aren't enough.
 * Today itself is never "missed" — the user can still practise.
 */
export function reconcileStreak(s: StreakState, today: string): StreakState {
  if (!s.lastCoveredDay || s.current === 0) return s;
  const missed = dayDiff(s.lastCoveredDay, today) - 1;
  if (missed <= 0) return s;
  if (s.freezes >= missed) {
    const frozen = Array.from({ length: missed }, (_, i) => addDays(s.lastCoveredDay!, i + 1));
    return {
      ...s,
      freezes: s.freezes - missed,
      frozenDays: [...s.frozenDays, ...frozen].slice(-30),
      lastCoveredDay: addDays(today, -1),
    };
  }
  return { ...s, current: 0 };
}

/** Record a completed session today. */
export function applyActivity(prev: StreakState, today: string): StreakState {
  const s = reconcileStreak(prev, today);
  if (s.lastActiveDay === today) return s;
  const continues = s.current > 0 && s.lastCoveredDay !== null && dayDiff(s.lastCoveredDay, today) === 1;
  const current = continues ? s.current + 1 : s.lastCoveredDay === today ? s.current : 1;
  return {
    ...s,
    current,
    longest: Math.max(s.longest, current),
    lastCoveredDay: today,
    lastActiveDay: today,
  };
}

export type StreakStatus = 'none' | 'done-today' | 'at-risk' | 'broken';

export function streakStatus(prev: StreakState, today: string): StreakStatus {
  const s = reconcileStreak(prev, today);
  if (s.lastActiveDay === today) return 'done-today';
  if (s.current === 0) return prev.longest > 0 ? 'broken' : 'none';
  return 'at-risk';
}
