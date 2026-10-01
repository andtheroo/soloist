/**
 * XP economy. Tuned so a typical 3-minute session earns 12–30 XP and a daily goal of
 * 30 XP ≈ 1–2 sessions. All functions are pure; the server should recompute XP from the
 * raw session report before trusting it (anti-cheat).
 */
export interface ExerciseOutcome {
  accuracy: number; // 0..1
  stars: 0 | 1 | 2 | 3;
  passed: boolean;
}

export interface XpInput {
  exercises: ExerciseOutcome[];
  firstCompletion: boolean;
  /** Current streak length *before* this session. */
  streakDays: number;
}

export interface XpLine {
  label: string;
  xp: number;
}

export interface XpBreakdown {
  lines: XpLine[];
  total: number;
}

export const SESSION_BASE_XP = 10;

export function computeSessionXp(input: XpInput): XpBreakdown {
  const lines: XpLine[] = [];
  const done = input.exercises.length;
  if (done === 0) return { lines, total: 0 };

  lines.push({ label: 'Session complete', xp: SESSION_BASE_XP });

  const avgAcc = input.exercises.reduce((a, e) => a + e.accuracy, 0) / done;
  const accuracyXp = Math.round(avgAcc * 10);
  if (accuracyXp > 0) lines.push({ label: `Accuracy ${Math.round(avgAcc * 100)}%`, xp: accuracyXp });

  if (input.exercises.every((e) => e.stars === 3)) lines.push({ label: 'Flawless', xp: 5 });
  if (input.firstCompletion) lines.push({ label: 'New lesson', xp: 5 });

  // Small, capped streak bonus: rewards consistency without making missed days feel ruinous.
  const streakXp = Math.min(5, Math.floor(input.streakDays / 7));
  if (streakXp > 0) lines.push({ label: `${input.streakDays}-day streak`, xp: streakXp });

  return { lines, total: lines.reduce((a, l) => a + l.xp, 0) };
}

/** Cumulative XP required to *reach* `level` (level 1 = 0 XP). Gently super-linear. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(60 * Math.pow(level - 1, 1.55));
}

export function levelFromXp(totalXp: number) {
  let level = 1;
  while (xpForLevel(level + 1) <= totalXp) level++;
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    xpIntoLevel: totalXp - floor,
    xpForNext: next - floor,
    progress: (totalXp - floor) / (next - floor),
  };
}

/** Practice mode: small reward per session, but enough to keep a streak and earn a heart. */
export function computePracticeXp(passAccuracies: number[]): XpBreakdown {
  if (!passAccuracies.length) return { lines: [], total: 0 };
  const best = Math.max(...passAccuracies);
  const lines: XpLine[] = [{ label: 'Practice', xp: 3 }];
  const bonus = Math.round(best * 5);
  if (bonus > 0) lines.push({ label: `Best pass ${Math.round(best * 100)}%`, xp: bonus });
  return { lines, total: lines.reduce((a, l) => a + l.xp, 0) };
}

export const DAILY_GOAL_OPTIONS = [
  { xp: 10, label: 'Casual' },
  { xp: 20, label: 'Regular' },
  { xp: 30, label: 'Serious' },
  { xp: 50, label: 'Intense' },
] as const;
