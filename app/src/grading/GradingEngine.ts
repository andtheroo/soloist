import type { DetectedNote } from '../../modules/soloist-audio/src/SoloistAudio.types';
import type { ChartNote } from '../types/chart';
import { DEFAULT_GRADING, GradeEvent, GradeSummary, GradingConfig, isHit, Judgment } from './types';

interface NoteGroup {
  timeMs: number;
  noteIndices: number[]; // indices into the chart's notes array (== native expected-note indices)
  midis: number[];
}

type PitchVerdict = 'match' | 'octave' | 'unpitched' | 'wrong';

const JUDGMENT_POINTS: Record<number, number> = {
  [Judgment.Perfect]: 100,
  [Judgment.Great]: 75,
  [Judgment.Good]: 50,
};
const ACCURACY_WEIGHT: Record<number, number> = {
  [Judgment.Perfect]: 1,
  [Judgment.Great]: 0.85,
  [Judgment.Good]: 0.6,
};
const PITCH_PENALTY: Record<PitchVerdict, number> = { match: 0, octave: 0.3, unpitched: 0.5, wrong: 2 };

/** Cents between two (fractional) MIDI values. */
export const centsBetween = (a: number, b: number) => (a - b) * 100;

/**
 * Real-time grader. Consumes latency-compensated onsets from the native analyzer and
 * matches them to chart notes. Designed for the JS thread: O(log n) per event, zero
 * allocation in the hot path except the returned events.
 *
 * Timing is judged on the *onset* time; pitch is judged by (a) native target-informed
 * verification (robust to chords/ringing strings), else (b) blind YIN pitch.
 */
export class GradingEngine {
  readonly config: GradingConfig;
  readonly judgments: Uint8Array;
  readonly offsets: Float32Array;
  private readonly groups: NoteGroup[];
  private readonly groupJudged: Uint8Array;
  private readonly noteToGroup: Int32Array;
  private sweepCursor = 0; // first group that may still be pending
  private combo = 0;
  private maxCombo = 0;
  private score = 0;
  private stray = 0;

  constructor(
    private readonly notes: ReadonlyArray<ChartNote>,
    config: Partial<GradingConfig> = {},
  ) {
    this.config = { ...DEFAULT_GRADING, ...config, windows: { ...DEFAULT_GRADING.windows, ...config.windows } };
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].timeMs < notes[i - 1].timeMs) throw new Error('chart notes must be sorted by time');
    }
    this.judgments = new Uint8Array(notes.length);
    this.offsets = new Float32Array(notes.length).fill(NaN);
    this.noteToGroup = new Int32Array(notes.length);
    this.groups = [];
    for (let i = 0; i < notes.length; i++) {
      const last = this.groups[this.groups.length - 1];
      if (last && notes[i].timeMs - last.timeMs <= this.config.chordToleranceMs) {
        last.noteIndices.push(i);
        last.midis.push(notes[i].midi);
      } else {
        this.groups.push({ timeMs: notes[i].timeMs, noteIndices: [i], midis: [notes[i].midi] });
      }
      this.noteToGroup[i] = this.groups.length - 1;
    }
    this.groupJudged = new Uint8Array(this.groups.length);
  }

  get liveStats() {
    return { combo: this.combo, maxCombo: this.maxCombo, score: this.score };
  }

  /** Feed newly detected onsets (already on the song timeline). */
  ingest(detections: ReadonlyArray<DetectedNote>): GradeEvent[] {
    const out: GradeEvent[] = [];
    for (const d of detections) {
      const ev = this.matchOne(d);
      if (ev) out.push(ev);
      else this.stray++;
    }
    return out;
  }

  /**
   * Mark notes as missed once no detection for them can still arrive.
   * Call every frame with the current audible song position.
   */
  sweep(songNowMs: number): GradeEvent[] {
    const out: GradeEvent[] = [];
    const cutoff = songNowMs - this.config.windows.miss - this.config.detectionLatencyMs;
    while (this.sweepCursor < this.groups.length && this.groups[this.sweepCursor].timeMs < cutoff) {
      const gi = this.sweepCursor++;
      if (!this.groupJudged[gi]) out.push(this.commit(gi, Judgment.Miss, NaN, undefined, songNowMs));
    }
    return out;
  }

  /** Re-arm everything at/after `songMs` (retry from a point, seeking). */
  resetFrom(songMs: number) {
    this.resetRange(songMs, Number.POSITIVE_INFINITY);
    this.sweepCursor = this.lowerBound(songMs - this.config.windows.miss);
  }

  /** Whole-chart summary (end of an exercise). */
  summary(): GradeSummary {
    return summarize(this.judgments, this.offsets, this.score, this.maxCombo, this.stray);
  }

  /** Indices of chart notes with startMs <= time < endMs. */
  noteIndicesInRange(startMs: number, endMs: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.notes.length; i++) {
      const t = this.notes[i].timeMs;
      if (t >= startMs && t < endMs) out.push(i);
    }
    return out;
  }

  /** Copy of judgments/offsets for the given notes (practice loop passes). */
  snapshot(indices: number[]): { judgments: number[]; offsets: number[] } {
    return { judgments: indices.map((i) => this.judgments[i]), offsets: indices.map((i) => this.offsets[i]) };
  }

  /**
   * Re-arm notes in [startMs, endMs) — used when a practice loop wraps. Notes outside the
   * range keep their judgments so late detections for the previous pass still land.
   */
  resetRange(startMs: number, endMs: number) {
    for (let gi = 0; gi < this.groups.length; gi++) {
      const t = this.groups[gi].timeMs;
      if (t < startMs || t >= endMs) continue;
      this.groupJudged[gi] = 0;
      for (const ni of this.groups[gi].noteIndices) {
        this.judgments[ni] = Judgment.Pending;
        this.offsets[ni] = NaN;
      }
    }
    this.sweepCursor = Math.min(this.sweepCursor, this.lowerBound(startMs));
    this.combo = 0;
  }

  // ---------------------------------------------------------------------------

  private matchOne(d: DetectedNote): GradeEvent | null {
    const { windows } = this.config;
    let best = -1;
    let bestCost = Infinity;
    let bestVerdict: PitchVerdict = 'wrong';
    let bestCents: number | undefined;

    for (let gi = this.lowerBound(d.songMs - windows.miss); gi < this.groups.length; gi++) {
      const g = this.groups[gi];
      if (g.timeMs > d.songMs + windows.miss) break;
      if (this.groupJudged[gi]) continue;
      const { verdict, cents } = this.pitchVerdict(g, d);
      const cost = Math.abs(d.songMs - g.timeMs) / windows.good + PITCH_PENALTY[verdict];
      if (cost < bestCost) {
        best = gi;
        bestCost = cost;
        bestVerdict = verdict;
        bestCents = cents;
      }
    }
    if (best < 0) return null;

    const offset = d.songMs - this.groups[best].timeMs;
    const absOff = Math.abs(offset);

    if (bestVerdict === 'wrong') {
      // A confident wrong note right on the beat is a real mistake; outside the good window
      // it's more likely a stray (string noise, previous note's release) — ignore it.
      if (absOff > windows.good) return null;
      return this.commit(best, Judgment.WrongPitch, offset, bestCents, d.songMs);
    }

    let j: Judgment =
      absOff <= windows.perfect ? Judgment.Perfect
      : absOff <= windows.great ? Judgment.Great
      : absOff <= windows.good ? Judgment.Good
      : Judgment.Miss; // right note, way off the beat
    if (bestVerdict === 'octave') j = Math.max(j, Judgment.Great);
    if (bestVerdict === 'unpitched') j = Math.max(j, this.config.unpitchedMaxJudgment);
    return this.commit(best, j, offset, bestCents, d.songMs);
  }

  private pitchVerdict(g: NoteGroup, d: DetectedNote): { verdict: PitchVerdict; cents?: number } {
    // (a) Native verification against the exact expected notes — most reliable signal.
    for (const ni of g.noteIndices) if (d.verified.includes(ni)) return { verdict: 'match' };

    // (b) Blind pitch.
    if (d.midi < 0) return { verdict: 'unpitched' };
    let nearest = Infinity;
    for (const m of g.midis) {
      const c = centsBetween(d.midi, m);
      if (Math.abs(c) < Math.abs(nearest)) nearest = c;
    }
    if (Math.abs(nearest) <= this.config.pitchToleranceCents) return { verdict: 'match', cents: nearest };
    if (this.config.allowOctaveErrors) {
      for (const m of g.midis) {
        const c = centsBetween(d.midi, m);
        const folded = ((c % 1200) + 1800) % 1200 - 600; // distance to nearest octave multiple
        if (Math.abs(c) >= 1100 && Math.abs(folded) <= this.config.pitchToleranceCents) {
          return { verdict: 'octave', cents: nearest };
        }
      }
    }
    // Low-confidence blind pitch must not punish the player.
    if (d.confidence < this.config.minPitchConfidence) return { verdict: 'unpitched', cents: nearest };
    return { verdict: 'wrong', cents: nearest };
  }

  private commit(gi: number, j: Judgment, offsetMs: number, cents: number | undefined, atSongMs: number): GradeEvent {
    const g = this.groups[gi];
    this.groupJudged[gi] = 1;
    for (const ni of g.noteIndices) {
      this.judgments[ni] = j;
      this.offsets[ni] = offsetMs;
    }
    if (isHit(j)) {
      this.combo += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      const multiplier = Math.min(4, 1 + Math.floor(this.combo / 10));
      this.score += JUDGMENT_POINTS[j] * g.noteIndices.length * multiplier;
    } else {
      this.combo = 0;
    }
    return { groupIndex: gi, noteIndices: g.noteIndices, judgment: j, offsetMs, centsError: cents, atSongMs };
  }

  /** First group with timeMs >= t. */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.groups.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.groups[mid].timeMs < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * Pure summary over any set of judgments (whole chart or one practice-loop pass).
 * Unjudged notes count as misses.
 */
export function summarize(
  judgments: ArrayLike<number>,
  offsets: ArrayLike<number>,
  score = 0,
  maxCombo = 0,
  strayOnsets = 0,
): GradeSummary {
  const counts = { perfect: 0, great: 0, good: 0, miss: 0, wrongPitch: 0 };
  let weighted = 0;
  const hitOffsets: number[] = [];
  for (let i = 0; i < judgments.length; i++) {
    const j = judgments[i] as Judgment;
    switch (j) {
      case Judgment.Perfect: counts.perfect++; break;
      case Judgment.Great: counts.great++; break;
      case Judgment.Good: counts.good++; break;
      case Judgment.WrongPitch: counts.wrongPitch++; break;
      default: counts.miss++; // Miss or never judged
    }
    weighted += ACCURACY_WEIGHT[j] ?? 0;
    if (isHit(j) && !Number.isNaN(offsets[i])) hitOffsets.push(offsets[i]);
  }
  const n = judgments.length || 1;
  const accuracy = weighted / n;
  const mean = hitOffsets.length ? hitOffsets.reduce((a, b) => a + b, 0) / hitOffsets.length : 0;
  const variance = hitOffsets.length
    ? hitOffsets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hitOffsets.length
    : 0;
  // Only call out a tendency when it's consistent, not noise.
  const tendency = hitOffsets.length >= 6 && Math.abs(mean) > 12 ? (mean < 0 ? 'rushing' : 'dragging') : 'on-time';
  const stars = accuracy >= 0.95 ? 3 : accuracy >= 0.8 ? 2 : accuracy >= 0.6 ? 1 : 0;
  return {
    totalNotes: judgments.length,
    counts,
    accuracy,
    score,
    maxCombo,
    meanOffsetMs: mean,
    stdDevOffsetMs: Math.sqrt(variance),
    tendency,
    strayOnsets,
    stars,
    passed: accuracy >= 0.6,
  };
}
