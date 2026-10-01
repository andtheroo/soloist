import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';

import { api, ensureStemsCached } from '../api/client';
import { GradingEngine } from '../grading/GradingEngine';
import { GradeEvent, GradeSummary, GradingConfig, Judgment } from '../grading/types';
import type { Chart } from '../types/chart';
import { AudioSyncController, ClockSample, LoopRange } from './AudioSyncController';
import { SoloistAudio } from './native';

export interface StemGains {
  guide: number;
  bass: number;
  click: number;
}

interface Options {
  /** undefined while the screen isn't ready (engine starting, lesson loading). */
  chartId: string | undefined;
  songId: string | undefined;
  speed: number;
  gains: StemGains;
  grading: Partial<GradingConfig>;
  /** Practice mode A–B loop; null/undefined for a straight run. */
  loop?: LoopRange | null;
  onGrades?(events: GradeEvent[], live: { combo: number; score: number }): void;
  onActiveTime?(deltaMs: number): void;
  onFinished?(summary: GradeSummary): void;
  onPass?(summary: GradeSummary, pass: number): void;
}

/**
 * Loads one chart + its stems, wires native audio -> grader -> Skia shared values, and
 * exposes transport controls. Used by both the lesson screen and practice mode.
 */
export function useExercisePlayer(opts: Options) {
  const { chartId, songId, speed } = opts;
  const [chart, setChart] = useState<Chart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadToken, setLoadToken] = useState(0);

  const clock = useSharedValue<ClockSample>({ songMs: 0, hostMs: 0, playing: false, seq: 0 });
  const judgments = useSharedValue<number[]>([]);
  const judgedAt = useSharedValue<number[]>([]);
  const inputDb = useSharedValue(-120);

  const controllerRef = useRef<AudioSyncController | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const cbRef = useRef(opts);
  cbRef.current = opts;

  // Batch active-time ticks so Redux isn't dispatched 60x/second.
  const pendingTick = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (pendingTick.current > 0) {
        cbRef.current.onActiveTime?.(pendingTick.current);
        pendingTick.current = 0;
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  /** Fresh grader + controller for the loaded chart (start, retry, restart). */
  const arm = useCallback(() => {
    const c = chartRef.current;
    if (!c) return;
    controllerRef.current?.stop();
    const grader = new GradingEngine(c.notes, cbRef.current.grading);
    judgments.value = new Array(c.notes.length).fill(Judgment.Pending);
    judgedAt.value = new Array(c.notes.length).fill(NaN);
    const ctl = new AudioSyncController(
      grader,
      { clock, judgments, judgedAt },
      {
        onGrades: (events, live) => cbRef.current.onGrades?.(events, live),
        onTick: (delta) => (pendingTick.current += delta),
        onInputLevel: (db) => (inputDb.value = db),
        onPass: (summary, pass) => cbRef.current.onPass?.(summary, pass),
        onEnded: (summary) => {
          ctl.stop();
          cbRef.current.onActiveTime?.(pendingTick.current);
          pendingTick.current = 0;
          cbRef.current.onFinished?.(summary);
        },
        // Route / sample-rate change: stems were decoded for the old rate. Reload.
        onDeviceChanged: () => setLoadToken((t) => t + 1),
      },
      SoloistAudio,
    );
    ctl.setLoop(cbRef.current.loop ?? null);
    controllerRef.current = ctl;
  }, [clock, judgments, judgedAt, inputDb]);

  // ---- load chart + stems ----
  useEffect(() => {
    if (!chartId || !songId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    controllerRef.current?.stop();
    SoloistAudio.pause();
    (async () => {
      try {
        const [c, manifest] = await Promise.all([api.chart(chartId, speed), api.songManifest(songId, speed)]);
        const uris = await ensureStemsCached(manifest);
        if (!alive) return;
        const g = cbRef.current.gains;
        await SoloistAudio.loadSong(
          manifest.stems.map((s) => ({
            id: s.id,
            uri: uris[s.id],
            gain: s.id in g ? g[s.id as keyof StemGains] : s.defaultGain,
          })),
        );
        SoloistAudio.setExpectedNotes(c.notes); // indices == chart note indices == grader indices
        chartRef.current = c;
        arm();
        if (alive) setChart(c);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      controllerRef.current?.stop();
      SoloistAudio.pause();
    };
  }, [chartId, songId, speed, loadToken, arm]);

  // ---- live stem gains (no reload) ----
  const { guide, bass, click } = opts.gains;
  useEffect(() => {
    if (!chart) return;
    SoloistAudio.setStemGain('guide', guide);
    SoloistAudio.setStemGain('bass', bass);
    SoloistAudio.setStemGain('click', click);
  }, [chart, guide, bass, click]);

  // ---- practice loop ----
  const loopStart = opts.loop?.startMs ?? -1;
  const loopEnd = opts.loop?.endMs ?? -1;
  useEffect(() => {
    if (!chart) return;
    if (loopEnd > loopStart && loopStart >= 0) SoloistAudio.setLoop(loopStart, loopEnd);
    else SoloistAudio.setLoop(0, 0);
    controllerRef.current?.setLoop(loopEnd > loopStart && loopStart >= 0 ? { startMs: loopStart, endMs: loopEnd } : null);
  }, [chart, loopStart, loopEnd]);

  const play = useCallback(() => {
    controllerRef.current?.start();
    SoloistAudio.play();
  }, []);

  const pause = useCallback(() => SoloistAudio.pause(), []);

  /** Back to `fromMs` with a clean scoreboard (retry / restart practice). */
  const restart = useCallback(
    (fromMs = 0) => {
      SoloistAudio.pause();
      arm();
      SoloistAudio.seek(Math.max(0, fromMs));
    },
    [arm],
  );

  /** Retry a failed chart/stem download. */
  const reload = useCallback(() => setLoadToken((t) => t + 1), []);

  return { chart, loading, error, clock, judgments, judgedAt, inputDb, play, pause, restart, reload };
}
