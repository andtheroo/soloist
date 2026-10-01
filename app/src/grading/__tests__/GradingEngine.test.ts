import type { DetectedNote } from '../../../modules/soloist-audio/src/SoloistAudio.types';
import type { ChartNote } from '../../types/chart';
import { GradingEngine } from '../GradingEngine';
import { Judgment } from '../types';
import { summarize } from '../GradingEngine';

const note = (timeMs: number, midi: number, string = 1, fret = 0): ChartNote => ({
  timeMs, durationMs: 200, string, fret, midi,
});
const det = (songMs: number, midi: number, extra: Partial<DetectedNote> = {}): DetectedNote => ({
  songMs, midi, confidence: 0.95, levelDb: -20, detectedAtMs: 0, verified: [], ...extra,
});

describe('GradingEngine', () => {
  const chart = [note(1000, 64), note(1500, 67), note(2000, 69), note(2500, 71)];

  it('tiers timing correctly (early and late)', () => {
    const g = new GradingEngine(chart);
    const ev = g.ingest([det(1010, 64), det(1460, 67), det(2080, 69)]);
    expect(ev.map((e) => e.judgment)).toEqual([Judgment.Perfect, Judgment.Great, Judgment.Good]);
    expect(ev[1].offsetMs).toBe(-40); // early is negative
  });

  it('flags a confident wrong note on the beat as WrongPitch and breaks combo', () => {
    const g = new GradingEngine(chart);
    g.ingest([det(1000, 64)]);
    const [ev] = g.ingest([det(1502, 66)]); // F# instead of G
    expect(ev.judgment).toBe(Judgment.WrongPitch);
    expect(g.liveStats.combo).toBe(0);
  });

  it('does not punish low-confidence blind pitch (treated as unpitched, capped at Good)', () => {
    const g = new GradingEngine(chart);
    const [ev] = g.ingest([det(1000, 60, { confidence: 0.3 })]);
    expect(ev.judgment).toBe(Judgment.Good);
  });

  it('native verification overrides a wrong blind pitch (ringing string / chord)', () => {
    const g = new GradingEngine(chart);
    const [ev] = g.ingest([det(1005, 52, { verified: [0] })]);
    expect(ev.judgment).toBe(Judgment.Perfect);
  });

  it('accepts octave errors capped at Great', () => {
    const g = new GradingEngine(chart);
    const [ev] = g.ingest([det(1000, 52)]); // one octave below E4
    expect(ev.judgment).toBe(Judgment.Great);
  });

  it('prefers the pitch-matching note when two are in range', () => {
    const tight = [note(1000, 64), note(1100, 67)];
    const g = new GradingEngine(tight);
    const [ev] = g.ingest([det(1040, 67)]); // closer to note 0 in time, but pitch says note 1
    expect(ev.noteIndices).toEqual([1]);
    expect(ev.judgment).toBe(Judgment.Good);
  });

  it('sweeps unplayed notes as Miss only after miss window + detection latency', () => {
    const g = new GradingEngine(chart);
    expect(g.sweep(1000 + 140 + 140 - 1)).toHaveLength(0);
    const missed = g.sweep(1000 + 140 + 140 + 1);
    expect(missed).toHaveLength(1);
    expect(missed[0].judgment).toBe(Judgment.Miss);
    // A late-arriving detection can no longer claim it.
    expect(g.ingest([det(1100, 64)])).toHaveLength(0);
  });

  it('judges a chord as one strum', () => {
    const chord = [note(1000, 40, 6), note(1002, 47, 5), note(1004, 52, 4)];
    const g = new GradingEngine(chord);
    const [ev] = g.ingest([det(1010, 47)]);
    expect(ev.noteIndices).toEqual([0, 1, 2]);
    expect(Array.from(g.judgments)).toEqual([Judgment.Perfect, Judgment.Perfect, Judgment.Perfect]);
  });

  it('counts strays and does not consume notes', () => {
    const g = new GradingEngine(chart);
    expect(g.ingest([det(3000, 64)])).toHaveLength(0);
    expect(g.summary().strayOnsets).toBe(1);
  });

  it('summarises accuracy, combo multiplier, tendency and stars', () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(1000 + i * 500, 64));
    const g = new GradingEngine(notes);
    g.ingest(notes.map((n) => det(n.timeMs - 20, 64))); // consistently 20 ms early
    const s = g.summary();
    expect(s.counts.perfect).toBe(12);
    expect(s.accuracy).toBe(1);
    expect(s.stars).toBe(3);
    expect(s.tendency).toBe('rushing');
    expect(s.meanOffsetMs).toBeCloseTo(-20);
    // 9 notes at x1, combo 10..12 at x2
    expect(s.score).toBe(9 * 100 + 3 * 200);
  });

  it('resetFrom re-arms a practice loop', () => {
    const g = new GradingEngine(chart);
    g.ingest([det(1000, 64), det(1500, 67)]);
    g.resetFrom(1400);
    expect(g.judgments[0]).toBe(Judgment.Perfect);
    expect(g.judgments[1]).toBe(Judgment.Pending);
    expect(g.ingest([det(1500, 67)])[0].judgment).toBe(Judgment.Perfect);
  });
});


describe('practice-loop support', () => {
  const chart = [1000, 1500, 2000, 2500, 3000].map((t) => note(t, 64));
  it('resetRange re-arms only the loop region and rewinds the sweep', () => {
    const g = new GradingEngine(chart);
    g.ingest(chart.map((n) => det(n.timeMs, 64)));
    g.resetRange(1400, 2600);
    expect(Array.from(g.judgments)).toEqual([1, 0, 0, 0, 1]);
    expect(g.noteIndicesInRange(1400, 2600)).toEqual([1, 2, 3]);
    // sweeping again from the loop start marks the region missed
    expect(g.sweep(5000).map((e) => e.noteIndices[0])).toEqual([1, 2, 3]);
  });
  it('summarize works on any snapshot', () => {
    const s = summarize([Judgment.Perfect, Judgment.Great, Judgment.Pending], [0, 30, NaN]);
    expect(s.counts).toEqual({ perfect: 1, great: 1, good: 0, miss: 1, wrongPitch: 0 });
    expect(s.accuracy).toBeCloseTo((1 + 0.85) / 3);
  });
});
