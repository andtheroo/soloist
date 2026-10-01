/** A single note in a lesson chart (tab). Times are on the song timeline (ms from stem start). */
export interface ChartNote {
  timeMs: number;
  durationMs: number;
  /** Tab convention: 1 = high E ... 6 = low E. */
  string: number;
  fret: number;
  /** Expected MIDI pitch (tuning[string] + fret), precomputed by the content pipeline. */
  midi: number;
  /** Chord symbol when this note is part of a strummed chord (e.g. "Em"). */
  chord?: string;
}

export interface Beat {
  timeMs: number;
  downbeat: boolean;
}

export interface Chart {
  id: string;
  title: string;
  bpm: number;
  /** Tempo as a percentage of the original (practice speed variants). */
  speed?: number;
  timeSignature: [number, number];
  /** Silence / count-in before the first note. */
  leadInMs: number;
  durationMs: number;
  /** MIDI note of each open string, index 0 = string 1 (high E). */
  tuning: number[];
  notes: ChartNote[]; // sorted by timeMs, then string
  beats: Beat[];
}

export interface StemManifestEntry {
  id: string; // "click" | "drums" | "bass" | "backing" | "guide"
  url: string;
  sha256: string;
  bytes: number;
  defaultGain: number;
}

export interface SongManifest {
  songId: string;
  sampleRate: number;
  durationMs: number;
  stems: StemManifestEntry[];
}

export interface Exercise {
  id: string;
  title: string;
  chartId: string;
  songId: string;
  /** Instruction shown before the exercise ("Alternate pick every note"). */
  tip?: string;
}

export interface Lesson {
  id: string;
  skillId: string;
  title: string;
  /** Hard cap for the micro-session (default 180 000 ms). */
  budgetMs: number;
  exercises: Exercise[];
}

export interface SkillNodeDef {
  id: string;
  title: string;
  icon?: string;
  prerequisites: string[];
  /** Lessons that must all be passed to earn the next crown/level. */
  lessonIds: string[];
  maxLevel: number;
  description?: string;
}

export interface Course {
  skills: SkillNodeDef[];
  lessons: Lesson[];
}
