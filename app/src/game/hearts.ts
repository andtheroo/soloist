/**
 * Hearts (Duolingo-style): failing an exercise costs a heart; at zero you can't start a
 * new lesson until hearts refill (one every 30 minutes) or you earn one back in
 * Practice mode. Pure functions; callers pass `now` (epoch ms) so reducers stay pure.
 */
export interface HeartsState {
  hearts: number;
  /** Start of the current refill period (epoch ms). Only meaningful when not full. */
  updatedAt: number;
}

export const MAX_HEARTS = 5;
export const HEART_REFILL_MS = 30 * 60 * 1000;

export const initialHearts = (now = 0): HeartsState => ({ hearts: MAX_HEARTS, updatedAt: now });

/** Apply any refills that have accrued since `updatedAt`. */
export function refillHearts(s: HeartsState, now: number): HeartsState {
  if (s.hearts >= MAX_HEARTS) return s.hearts === MAX_HEARTS ? s : { hearts: MAX_HEARTS, updatedAt: now };
  const gained = Math.floor((now - s.updatedAt) / HEART_REFILL_MS);
  if (gained <= 0) return s;
  const hearts = Math.min(MAX_HEARTS, s.hearts + gained);
  return { hearts, updatedAt: hearts >= MAX_HEARTS ? now : s.updatedAt + gained * HEART_REFILL_MS };
}

export function loseHeart(s: HeartsState, now: number): HeartsState {
  const r = refillHearts(s, now);
  if (r.hearts <= 0) return r;
  // Leaving "full" starts the refill clock now.
  return { hearts: r.hearts - 1, updatedAt: r.hearts >= MAX_HEARTS ? now : r.updatedAt };
}

export function gainHeart(s: HeartsState, now: number): HeartsState {
  const r = refillHearts(s, now);
  const hearts = Math.min(MAX_HEARTS, r.hearts + 1);
  return { hearts, updatedAt: hearts >= MAX_HEARTS ? now : r.updatedAt };
}

/** ms until the next heart arrives, or null when already full. */
export function msUntilNextHeart(s: HeartsState, now: number): number | null {
  const r = refillHearts(s, now);
  if (r.hearts >= MAX_HEARTS) return null;
  return Math.max(0, r.updatedAt + HEART_REFILL_MS - now);
}
