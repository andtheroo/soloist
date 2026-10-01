/** Stored in a numeric array shared with the Skia worklet — keep values stable. */
export enum Judgment {
  Pending = 0,
  Perfect = 1,
  Great = 2,
  Good = 3,
  Miss = 4,
  WrongPitch = 5,
}

export const isHit = (j: Judgment) => j === Judgment.Perfect || j === Judgment.Great || j === Judgment.Good;

export interface GradingConfig {
  /** ± ms windows. Ordered tightest to loosest. */
  windows: { perfect: number; great: number; good: number; miss: number };
  pitchToleranceCents: number;
  /** Blind-pitch confidence needed to *penalise* a wrong note (not needed to reward a right one). */
  minPitchConfidence: number;
  /** YIN octave errors are common on guitar; count them as correct but cap at Great. */
  allowOctaveErrors: boolean;
  /** Onsets with no usable pitch (muted strums, noisy rooms) can still earn up to this. */
  unpitchedMaxJudgment: Judgment;
  /** Notes starting within this many ms of each other form a chord (judged by one strum). */
  chordToleranceMs: number;
  /** Upper bound on onset -> event arrival (pitch window + poll). Delays the miss sweep. */
  detectionLatencyMs: number;
}

export const DEFAULT_GRADING: GradingConfig = {
  windows: { perfect: 25, great: 50, good: 90, miss: 140 },
  pitchToleranceCents: 50,
  minPitchConfidence: 0.6,
  allowOctaveErrors: true,
  unpitchedMaxJudgment: Judgment.Good,
  chordToleranceMs: 15,
  // Single notes arrive ~50 ms after the onset; strummed chords ~100 ms (longer window).
  detectionLatencyMs: 140,
};

/** For players who want a challenge (Settings → Grading → Strict). */
export const STRICT_GRADING: GradingConfig = {
  ...DEFAULT_GRADING,
  windows: { perfect: 18, great: 35, good: 70, miss: 120 },
  pitchToleranceCents: 35,
};

/** Beginner-friendly preset for the first skill nodes. */
export const LENIENT_GRADING: GradingConfig = {
  ...DEFAULT_GRADING,
  windows: { perfect: 35, great: 70, good: 120, miss: 180 },
  pitchToleranceCents: 60,
};

export interface GradeEvent {
  groupIndex: number;
  noteIndices: number[];
  judgment: Judgment;
  /** Signed: negative = early, positive = late. NaN for sweeps. */
  offsetMs: number;
  /** Signed cents error of blind pitch vs. nearest chord note, if available. */
  centsError?: number;
  /** song ms at which the judgment was made (drives hit-burst animation). */
  atSongMs: number;
}

export interface GradeSummary {
  totalNotes: number;
  counts: Record<'perfect' | 'great' | 'good' | 'miss' | 'wrongPitch', number>;
  accuracy: number; // 0..1, weighted
  score: number;
  maxCombo: number;
  meanOffsetMs: number;
  stdDevOffsetMs: number;
  tendency: 'rushing' | 'dragging' | 'on-time';
  strayOnsets: number;
  stars: 0 | 1 | 2 | 3;
  passed: boolean;
}
