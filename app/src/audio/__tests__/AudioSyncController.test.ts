import type { AudioSnapshot, DetectedNote } from '../../../modules/soloist-audio/src/SoloistAudio.types';
import { GradingEngine } from '../../grading/GradingEngine';
import { GradeSummary, Judgment } from '../../grading/types';
import type { ChartNote } from '../../types/chart';
import { AudioSyncController, ClockSample, PollSource } from '../AudioSyncController';

const note = (timeMs: number): ChartNote => ({ timeMs, durationMs: 200, string: 1, fret: 0, midi: 64 });

/** Simulated native engine: song advances 16 ms per frame, loops, and delivers onsets late. */
class FakeEngine implements PollSource {
  songMs = 0;
  hostMs = 10_000;
  loopCount = 0;
  ended = false;
  private queue: { dueHost: number; ev: DetectedNote }[] = [];
  constructor(private loop: { startMs: number; endMs: number } | null, private durationMs: number) {}
  play(songMs: number) {
    // the "player" hits the note exactly; the detection arrives 60 ms later
    this.queue.push({ dueHost: this.hostMs + 60, ev: { songMs, midi: 64, confidence: 0.95, levelDb: -20, detectedAtMs: 0, verified: [] } });
  }
  advance() {
    this.hostMs += 16;
    this.songMs += 16;
    if (this.loop && this.songMs >= this.loop.endMs) {
      this.songMs = this.loop.startMs + (this.songMs - this.loop.endMs);
      this.loopCount++;
    }
    if (!this.loop && this.songMs >= this.durationMs) this.ended = true;
  }
  poll(): AudioSnapshot {
    const due = this.queue.filter((q) => q.dueHost <= this.hostMs);
    this.queue = this.queue.filter((q) => q.dueHost > this.hostMs);
    return {
      songMs: this.songMs, hostNowMs: this.hostMs, playing: !this.ended, ended: this.ended, inputDb: -40,
      durationMs: this.durationMs, overflows: 0, deviceGeneration: 0, tunerHz: 0, tunerConfidence: 0,
      loopCount: this.loopCount, events: due.map((q) => q.ev),
    };
  }
}

const box = <T,>(value: T) => ({ value });

function setup(notes: ChartNote[], loop: { startMs: number; endMs: number } | null, durationMs = 4000) {
  const grader = new GradingEngine(notes);
  const shared = {
    clock: box<ClockSample>({ songMs: 0, hostMs: 0, playing: false, seq: 0 }),
    judgments: box<number[]>(notes.map(() => Judgment.Pending)),
    judgedAt: box<number[]>(notes.map(() => NaN)),
  };
  const engine = new FakeEngine(loop, durationMs);
  const passes: GradeSummary[] = [];
  let ended: GradeSummary | null = null;
  let active = 0;
  const ctl = new AudioSyncController(
    grader,
    shared,
    { onPass: (s) => passes.push(s), onEnded: (s) => (ended = s), onTick: (d) => (active += d) },
    engine,
  );
  ctl.setLoop(loop);
  return { grader, shared, engine, ctl, passes, getEnded: () => ended, getActive: () => active };
}

describe('AudioSyncController', () => {
  it('grades a full run and reports the summary when the song ends', () => {
    const notes = [500, 1000, 1500].map(note);
    const t = setup(notes, null, 2000);
    for (let f = 0; f < 200; f++) {
      if (notes.some((n) => Math.abs(n.timeMs - t.engine.songMs) <= 8)) t.engine.play(t.engine.songMs);
      t.engine.advance();
      t.ctl.tick();
    }
    expect(t.getEnded()).not.toBe(null);
    expect(t.getEnded()!.counts.perfect).toBe(3);
    expect(t.shared.judgments.value).toEqual([1, 1, 1]);
    expect(t.getActive()).toBeGreaterThan(1900);
  });

  it('scores each loop pass, including notes right before the loop end, then re-arms', () => {
    // loop 1000–2000 ms; the note at 1950 is in the "tail" whose detection arrives after the wrap
    const notes = [1000, 1250, 1500, 1950, 2500].map(note);
    const t = setup(notes, { startMs: 1000, endMs: 2000 });
    t.engine.songMs = 1000;
    // pass 1: play everything in the loop
    let frames = 0;
    while (t.engine.loopCount < 1) {
      if (notes.some((n) => n.timeMs < 2000 && Math.abs(n.timeMs - t.engine.songMs) <= 8)) t.engine.play(t.engine.songMs);
      t.engine.advance();
      t.ctl.tick();
      frames++;
    }
    // pass 2: play nothing; run long enough for pass 1 tail + pass 2 to finalize
    while (t.engine.loopCount < 2 || t.passes.length < 2) {
      t.engine.advance();
      t.ctl.tick();
      if (++frames > 1000) break;
    }
    expect(t.passes.length).toBe(2);
    expect(t.passes[0].totalNotes).toBe(4);
    expect(t.passes[0].counts.perfect).toBe(4); // the tail note (1950) counted for pass 1
    expect(t.passes[1].counts.miss).toBe(4);
    // note outside the loop never judged
    expect(t.shared.judgments.value[4]).toBe(Judgment.Pending);
  });
});
