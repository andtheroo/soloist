import { GradingEngine, summarize } from '../grading/GradingEngine';
import { GradeEvent, GradeSummary, Judgment } from '../grading/types';
import type { AudioSnapshot } from './native';

/** What the UI thread needs to extrapolate the song position between polls. */
export interface ClockSample {
  songMs: number;
  hostMs: number; // native monotonic ms at which songMs was audible
  playing: boolean;
  seq: number;
}

/** Minimal shape of a Reanimated SharedValue (keeps this class testable in Node). */
export interface ValueBox<T> {
  value: T;
}

export interface HighwaySharedState {
  clock: ValueBox<ClockSample>;
  /** Judgment per chart note (Judgment enum values). */
  judgments: ValueBox<number[]>;
  /** Song ms at which each note was judged (NaN = pending) — drives hit bursts. */
  judgedAt: ValueBox<number[]>;
}

export interface SyncCallbacks {
  onGrades?(events: GradeEvent[], live: GradingEngine['liveStats']): void;
  onTick?(deltaMs: number, snapshot: AudioSnapshot): void;
  onEnded?(summary: GradeSummary): void;
  onDeviceChanged?(): void;
  /** Practice loop: one completed pass through the A–B range. */
  onPass?(summary: GradeSummary, passNumber: number): void;
  onInputLevel?(db: number): void;
}

export interface PollSource {
  poll(): AudioSnapshot;
}

export interface LoopRange {
  startMs: number;
  endMs: number;
}

interface PendingTail {
  headJudgments: number[];
  headOffsets: number[];
  tailIndices: number[];
  tailStartMs: number;
  dueHostMs: number;
}

/**
 * The JS-thread "pump". Once per display frame it makes ONE synchronous JSI call into
 * the native engine and fans the result out:
 *
 *   native pollState() ──▶ clock value ──▶ UI thread (Skia worklet extrapolates)
 *                     └──▶ detected onsets ──▶ GradingEngine ──▶ judgment values
 *                                                           └──▶ Redux (HUD, session)
 *
 * The JS thread is NOT on the timing-critical path: onset times were stamped in native
 * code against the audio clock, so a GC pause here delays *feedback*, never *accuracy*.
 *
 * Practice loops: when the native mixer wraps, notes in the body of the loop are scored
 * and re-armed immediately; the last ~300 ms are scored a moment later, because their
 * detections are still in flight (pitch analysis + polling). Then they re-arm too.
 */
export class AudioSyncController {
  private raf: number | null = null;
  private lastSongMs = 0;
  private lastPlaying = false;
  private seq = 0;
  private generation = -1;
  private endedFired = false;
  private loop: LoopRange | null = null;
  private lastLoopCount = -1;
  private passes = 0;
  private pendingTail: PendingTail | null = null;

  constructor(
    private readonly grader: GradingEngine,
    private readonly shared: HighwaySharedState,
    private readonly cb: SyncCallbacks = {},
    private readonly source: PollSource,
  ) {}

  setLoop(range: LoopRange | null) {
    this.loop = range;
    this.pendingTail = null;
    this.lastLoopCount = -1;
    this.passes = 0;
  }

  start() {
    if (this.raf !== null) return;
    this.endedFired = false;
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  /** One frame of work. Public so tests can drive it without requestAnimationFrame. */
  tick() {
    const snap = this.source.poll();

    // 1) Clock -> UI thread.
    this.shared.clock.value = { songMs: snap.songMs, hostMs: snap.hostNowMs, playing: snap.playing, seq: ++this.seq };
    this.cb.onInputLevel?.(snap.inputDb);

    // 2) Active-time accounting for the 3-minute budget (audio time, not wall time).
    if (snap.playing && this.lastPlaying) {
      const delta = snap.songMs - this.lastSongMs;
      if (delta > 0 && delta < 1000) this.cb.onTick?.(delta, snap);
    }
    this.lastSongMs = snap.songMs;
    this.lastPlaying = snap.playing;

    // 3) Grade.
    let events: GradeEvent[] = [];
    if (snap.events.length) events = this.grader.ingest(snap.events);
    if (snap.playing) {
      const missed = this.grader.sweep(snap.songMs);
      if (missed.length) events = events.concat(missed);
    }
    if (events.length) this.publish(events);

    // 4) Practice loop bookkeeping.
    if (this.loop) this.handleLoop(snap);

    // 5) Lifecycle.
    if (this.generation >= 0 && snap.deviceGeneration !== this.generation) this.cb.onDeviceChanged?.();
    this.generation = snap.deviceGeneration;

    if (snap.ended && !this.endedFired && !this.loop) {
      this.endedFired = true;
      const tail = this.grader.sweep(Number.POSITIVE_INFINITY);
      if (tail.length) this.publish(tail);
      this.cb.onEnded?.(this.grader.summary());
    }
  }

  private handleLoop(snap: AudioSnapshot) {
    const loop = this.loop!;
    if (this.lastLoopCount < 0) this.lastLoopCount = snap.loopCount;

    if (this.pendingTail && snap.hostNowMs >= this.pendingTail.dueHostMs) {
      const t = this.pendingTail;
      this.pendingTail = null;
      const tail = this.grader.snapshot(t.tailIndices);
      const summary = summarize([...t.headJudgments, ...tail.judgments], [...t.headOffsets, ...tail.offsets]);
      this.grader.resetRange(t.tailStartMs, loop.endMs);
      this.rearm(t.tailIndices);
      this.cb.onPass?.(summary, ++this.passes);
    }

    if (snap.loopCount > this.lastLoopCount) {
      this.lastLoopCount = snap.loopCount;
      const { windows, detectionLatencyMs } = this.grader.config;
      const tailStartMs = Math.max(loop.startMs, loop.endMs - (windows.miss + detectionLatencyMs + 40));
      const headIdx = this.grader.noteIndicesInRange(loop.startMs, tailStartMs);
      const head = this.grader.snapshot(headIdx);
      this.grader.resetRange(loop.startMs, tailStartMs);
      this.rearm(headIdx);
      this.pendingTail = {
        headJudgments: head.judgments,
        headOffsets: head.offsets,
        tailIndices: this.grader.noteIndicesInRange(tailStartMs, loop.endMs),
        tailStartMs,
        dueHostMs: snap.hostNowMs + windows.miss + detectionLatencyMs,
      };
    }
  }

  private rearm(indices: number[]) {
    if (!indices.length) return;
    const judgments = this.shared.judgments.value.slice();
    const judgedAt = this.shared.judgedAt.value.slice();
    for (const i of indices) {
      judgments[i] = Judgment.Pending;
      judgedAt[i] = NaN;
    }
    this.shared.judgments.value = judgments;
    this.shared.judgedAt.value = judgedAt;
  }

  private publish(events: GradeEvent[]) {
    const judgments = this.shared.judgments.value.slice();
    const judgedAt = this.shared.judgedAt.value.slice();
    for (const e of events) {
      for (const i of e.noteIndices) {
        judgments[i] = e.judgment;
        judgedAt[i] = e.atSongMs;
      }
    }
    this.shared.judgments.value = judgments;
    this.shared.judgedAt.value = judgedAt;
    this.cb.onGrades?.(events, this.grader.liveStats);
  }
}
