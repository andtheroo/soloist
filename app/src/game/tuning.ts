/** Pitch helpers for the tuner and UI labels. */
export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Standard tuning, string 6 (low E) first — the order a guitarist tunes in. */
export const STANDARD_TUNING = [
  { string: 6, name: 'E', midi: 40 },
  { string: 5, name: 'A', midi: 45 },
  { string: 4, name: 'D', midi: 50 },
  { string: 3, name: 'G', midi: 55 },
  { string: 2, name: 'B', midi: 59 },
  { string: 1, name: 'E', midi: 64 },
];

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export function midiName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export interface TunerReading {
  hz: number;
  /** Nearest equal-tempered note. */
  note: string;
  /** Cents from the nearest note, −50..+50. */
  cents: number;
  /** Closest open string and cents from it (what a beginner actually tunes to). */
  string: (typeof STANDARD_TUNING)[number];
  centsFromString: number;
}

export function readTuner(hz: number): TunerReading | null {
  if (!(hz > 20 && hz < 2000)) return null;
  const midi = hzToMidi(hz);
  const nearest = Math.round(midi);
  let string = STANDARD_TUNING[0];
  for (const s of STANDARD_TUNING) if (Math.abs(midi - s.midi) < Math.abs(midi - string.midi)) string = s;
  return {
    hz,
    note: midiName(nearest),
    cents: (midi - nearest) * 100,
    string,
    centsFromString: (midi - string.midi) * 100,
  };
}
