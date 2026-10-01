import type { SkillNodeDef } from '../types/chart';

/**
 * Skill tree = DAG of skills. Each skill has `maxLevel` crowns; a crown is earned by
 * passing every lesson in the skill at the current level (content difficulty scales
 * with level on the server: faster tempo, less guide audio, tighter windows).
 * A skill unlocks when all prerequisites have at least one crown.
 */
export interface SkillProgress {
  level: number; // crowns earned, 0..maxLevel
  lessonsPassedAtLevel: string[];
  bestAccuracy: number;
}

export type SkillStatus = 'locked' | 'available' | 'in-progress' | 'mastered';

export const emptyProgress = (): SkillProgress => ({ level: 0, lessonsPassedAtLevel: [], bestAccuracy: 0 });

export function validateTree(defs: SkillNodeDef[]): string[] {
  const errors: string[] = [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const d of defs) {
    for (const p of d.prerequisites) if (!byId.has(p)) errors.push(`${d.id}: unknown prerequisite ${p}`);
    if (d.lessonIds.length === 0) errors.push(`${d.id}: no lessons`);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 visiting, 2 done
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    for (const p of byId.get(id)?.prerequisites ?? []) visit(p, [...path, id]);
    state.set(id, 2);
  };
  defs.forEach((d) => visit(d.id, []));
  return errors;
}

/** Row index for layout: longest prerequisite chain length. */
export function computeTiers(defs: SkillNodeDef[]): Record<string, number> {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const memo: Record<string, number> = {};
  const tier = (id: string): number => {
    if (memo[id] !== undefined) return memo[id];
    const pre = byId.get(id)?.prerequisites ?? [];
    memo[id] = pre.length ? 1 + Math.max(...pre.map(tier)) : 0;
    return memo[id];
  };
  defs.forEach((d) => tier(d.id));
  return memo;
}

export function skillStatus(def: SkillNodeDef, progress: Record<string, SkillProgress>): SkillStatus {
  const p = progress[def.id] ?? emptyProgress();
  if (p.level >= def.maxLevel) return 'mastered';
  const unlocked = def.prerequisites.every((pre) => (progress[pre]?.level ?? 0) >= 1);
  if (!unlocked) return 'locked';
  return p.level > 0 || p.lessonsPassedAtLevel.length > 0 ? 'in-progress' : 'available';
}

export function applyLessonResult(
  def: SkillNodeDef,
  prev: SkillProgress | undefined,
  lessonId: string,
  passed: boolean,
  accuracy: number,
): { progress: SkillProgress; leveledUp: boolean } {
  const p = prev ?? emptyProgress();
  const bestAccuracy = Math.max(p.bestAccuracy, accuracy);
  if (!passed || p.level >= def.maxLevel || !def.lessonIds.includes(lessonId)) {
    return { progress: { ...p, bestAccuracy }, leveledUp: false };
  }
  const passedSet = new Set([...p.lessonsPassedAtLevel, lessonId]);
  if (def.lessonIds.every((l) => passedSet.has(l))) {
    return { progress: { level: p.level + 1, lessonsPassedAtLevel: [], bestAccuracy }, leveledUp: true };
  }
  return { progress: { ...p, lessonsPassedAtLevel: [...passedSet], bestAccuracy }, leveledUp: false };
}

/** Next lesson to play within a skill (mastered skills return their first lesson as practice). */
export function nextLessonFor(def: SkillNodeDef, progress: SkillProgress | undefined): string {
  const done = new Set(progress?.lessonsPassedAtLevel ?? []);
  return def.lessonIds.find((l) => !done.has(l)) ?? def.lessonIds[0];
}

/** "Continue" button: the lowest-tier unlocked, unmastered skill. */
export function recommendNext(defs: SkillNodeDef[], progress: Record<string, SkillProgress>) {
  const tiers = computeTiers(defs);
  const candidates = defs
    .filter((d) => ['available', 'in-progress'].includes(skillStatus(d, progress)))
    .sort((a, b) => tiers[a.id] - tiers[b.id]);
  const d = candidates[0];
  return d ? { skillId: d.id, lessonId: nextLessonFor(d, progress[d.id]) } : null;
}

/**
 * Scaffolding: the guide stem (the part the learner is playing) fades out as crowns
 * are earned — full help on first contact, none at mastery.
 */
export function guideGainForLevel(level: number, maxLevel: number): number {
  if (maxLevel <= 0) return 0;
  return Math.max(0, 0.9 * (1 - level / maxLevel));
}

export type Experience = 'new' | 'some' | 'experienced';

/**
 * Placement: skills a returning player can skip on day one (they start with one crown,
 * which unlocks everything that depends on them). Based on tree depth, so it adapts
 * automatically as the course grows.
 */
export function placementSkills(defs: SkillNodeDef[], experience: Experience): string[] {
  if (experience === 'new') return [];
  const maxTier = experience === 'some' ? 1 : 2;
  const tiers = computeTiers(defs);
  return defs.filter((d) => tiers[d.id] <= maxTier && tiers[d.id] < Math.max(...Object.values(tiers))).map((d) => d.id);
}

/**
 * Difficulty ramp per crown: first contact is slowed down, mastery is full speed.
 * (Maps onto the server's pre-rendered speed variants.)
 */
export function lessonSpeedForLevel(level: number): number {
  return level <= 0 ? 80 : level === 1 ? 90 : 100;
}
