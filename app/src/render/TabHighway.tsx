import {
  Canvas,
  createPicture,
  matchFont,
  PaintStyle,
  Picture,
  Skia,
  SkCanvas,
  SkFont,
  SkPaint,
} from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { Platform } from 'react-native';
import { SharedValue, useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';

import type { ClockSample } from '../audio/AudioSyncController';
import { Judgment } from '../grading/types';
import type { Chart } from '../types/chart';
import { computeLayout, HIGHWAY_COLORS, HighwayLayout } from './theme';

/**
 * Scrolling tab "highway", drawn imperatively with Skia on the UI thread.
 *
 * Why Skia (not a WebView canvas / react-native-canvas): drawing happens in a Reanimated
 * worklet on the UI thread with GPU-backed Skia — no bridge, no JS-thread involvement,
 * so React re-renders and GC pauses can't drop frames. 60/120 Hz capable.
 *
 * Per frame:
 *   1. useFrameCallback extrapolates the audible song position from the latest native
 *      clock sample (hostMs, songMs) to the moment this frame will hit the display.
 *   2. useDerivedValue records a Skia Picture: beats, strings, notes (culled by binary
 *      search to the visible window), sustains, judgment colours, hit bursts.
 */
export interface TabHighwayProps {
  chart: Chart;
  clock: SharedValue<ClockSample>;
  judgments: SharedValue<number[]>;
  judgedAt: SharedValue<number[]>;
  width: number;
  height: number;
  lookaheadMs?: number;
  nowLineFraction?: number;
}

/** Chart flattened into plain arrays — cheap to copy to the UI runtime once. */
interface PackedChart {
  t: number[];
  d: number[];
  s: number[];
  label: string[];
  labelW: number[];
  /** Chord symbol on the first note of each strummed chord, '' otherwise. */
  chord: string[];
  chordW: number[];
  beatT: number[];
  beatDown: boolean[];
  strings: number;
  maxDur: number;
}

interface Paints {
  fill: SkPaint;
  stroke: SkPaint;
  line: SkPaint;
  text: SkPaint;
}

export function lowerBound(arr: number[], x: number): number {
  'worklet';
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function noteColor(stringIdx: number, judgment: number): string {
  'worklet';
  if (judgment !== Judgment.Pending) return HIGHWAY_COLORS.judgment[judgment];
  return HIGHWAY_COLORS.lanes[(stringIdx - 1) % HIGHWAY_COLORS.lanes.length];
}

export function drawHighway(
  canvas: SkCanvas,
  songMs: number,
  c: PackedChart,
  judgments: number[],
  judgedAt: number[],
  L: HighwayLayout,
  P: Paints,
  font: SkFont,
) {
  'worklet';
  const bottom = L.top + L.laneH * c.strings;
  const t0 = songMs - L.pastMs;
  const t1 = songMs + L.lookaheadMs;

  // Background
  P.fill.setAlphaf(1);
  P.fill.setColor(Skia.Color(HIGHWAY_COLORS.background));
  canvas.drawRect(Skia.XYWHRect(0, 0, L.width, L.height), P.fill);

  // Beat grid
  for (let i = lowerBound(c.beatT, t0); i < c.beatT.length && c.beatT[i] <= t1; i++) {
    const x = L.nowX + (c.beatT[i] - songMs) * L.pxPerMs;
    P.line.setColor(Skia.Color(c.beatDown[i] ? HIGHWAY_COLORS.downbeat : HIGHWAY_COLORS.beat));
    P.line.setStrokeWidth(c.beatDown[i] ? 3 : 1.5);
    canvas.drawLine(x, L.top, x, bottom, P.line);
  }

  // Strings (thicker for wound strings)
  for (let s = 0; s < c.strings; s++) {
    const y = L.top + L.laneH * (s + 0.5);
    P.line.setColor(Skia.Color(HIGHWAY_COLORS.string));
    P.line.setStrokeWidth(1 + s * 0.4);
    canvas.drawLine(0, y, L.width, y, P.line);
  }

  // Now line
  P.line.setColor(Skia.Color(HIGHWAY_COLORS.nowLine));
  P.line.setStrokeWidth(3);
  canvas.drawLine(L.nowX, L.top - 10, L.nowX, bottom + 10, P.line);

  // Notes: start early enough to include long sustains that began off-screen.
  for (let i = lowerBound(c.t, t0 - c.maxDur); i < c.t.length && c.t[i] <= t1; i++) {
    const j = judgments[i] ?? Judgment.Pending;
    const hit = j === Judgment.Perfect || j === Judgment.Great || j === Judgment.Good;
    const x = L.nowX + (c.t[i] - songMs) * L.pxPerMs;
    const y = L.top + L.laneH * (c.s[i] - 0.5);
    const color = noteColor(c.s[i], j);

    // Sustain tail — hit notes' tails are "eaten" by the now line.
    const tailEnd = x + c.d[i] * L.pxPerMs;
    if (c.d[i] > 150 && tailEnd > L.nowX - L.headW) {
      const tx = hit ? Math.max(x, L.nowX) : x;
      if (tailEnd > tx) {
        P.fill.setColor(Skia.Color(color));
        P.fill.setAlphaf(j === Judgment.Miss ? 0.25 : 0.55);
        canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(tx, y - 5, tailEnd - tx, 10), 5, 5), P.fill);
      }
    }

    // Head: hit notes vanish at the now line (the burst takes over); misses keep scrolling.
    const consumed = hit && x <= L.nowX;
    if (!consumed && x > -L.headW) {
      // Approach cue: pending notes swell slightly in the last 150 ms.
      const dt = c.t[i] - songMs;
      const swell = j === Judgment.Pending && dt > 0 && dt < 150 ? 1 + 0.15 * (1 - dt / 150) : 1;
      const w = L.headW * swell;
      const h = L.headH * swell;
      const rect = Skia.RRectXY(Skia.XYWHRect(x - w / 2, y - h / 2, w, h), 8, 8);
      P.fill.setColor(Skia.Color(color));
      P.fill.setAlphaf(j === Judgment.Miss ? 0.45 : 1);
      canvas.drawRRect(rect, P.fill);
      P.stroke.setColor(Skia.Color(HIGHWAY_COLORS.headStroke));
      canvas.drawRRect(rect, P.stroke);
      P.text.setColor(Skia.Color(HIGHWAY_COLORS.text));
      canvas.drawText(c.label[i], x - c.labelW[i] / 2, y + L.fontSize * 0.36, P.text, font);
    }

    // Chord symbol above the top string, scrolling with the strum.
    if (c.chord[i] && x > -L.headW) {
      P.text.setColor(Skia.Color(HIGHWAY_COLORS.chordLabel));
      canvas.drawText(c.chord[i], x - c.chordW[i] / 2, L.top - 2, P.text, font);
    }

    // Hit burst: expanding, fading ring at the now line in the judgment colour.
    if (j !== Judgment.Pending && j !== Judgment.Miss) {
      const age = songMs - judgedAt[i];
      if (age >= 0 && age < 260) {
        const k = age / 260;
        P.stroke.setColor(Skia.Color(color));
        P.stroke.setAlphaf(1 - k);
        P.stroke.setStrokeWidth(4 * (1 - k) + 1);
        canvas.drawCircle(L.nowX, y, L.headH * (0.6 + 0.9 * k), P.stroke);
        P.stroke.setAlphaf(1);
        P.stroke.setStrokeWidth(1.5);
      }
    }
  }
}

export function TabHighway({
  chart,
  clock,
  judgments,
  judgedAt,
  width,
  height,
  lookaheadMs = 2600,
  nowLineFraction = 0.2,
}: TabHighwayProps) {
  const strings = chart.tuning.length;
  const layout = useMemo(
    () => computeLayout(width, height, strings, lookaheadMs, nowLineFraction),
    [width, height, strings, lookaheadMs, nowLineFraction],
  );

  const font = useMemo(
    () =>
      matchFont({
        fontFamily: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
        fontSize: layout.fontSize,
        fontWeight: 'bold',
      }),
    [layout.fontSize],
  );

  const packed = useMemo<PackedChart>(() => {
    const label = chart.notes.map((n) => String(n.fret));
    const chord = chart.notes.map((n, i) =>
      n.chord && (i === 0 || chart.notes[i - 1].timeMs !== n.timeMs || chart.notes[i - 1].chord !== n.chord) ? n.chord : '',
    );
    return {
      t: chart.notes.map((n) => n.timeMs),
      d: chart.notes.map((n) => n.durationMs),
      s: chart.notes.map((n) => n.string),
      label,
      labelW: label.map((l) => font.measureText(l).width), // measured once, not per frame
      chord,
      chordW: chord.map((c) => (c ? font.measureText(c).width : 0)),
      beatT: chart.beats.map((b) => b.timeMs),
      beatDown: chart.beats.map((b) => b.downbeat),
      strings,
      maxDur: chart.notes.reduce((m, n) => Math.max(m, n.durationMs), 0),
    };
  }, [chart, font, strings]);

  const paints = useMemo<Paints>(() => {
    const fill = Skia.Paint();
    fill.setAntiAlias(true);
    const stroke = Skia.Paint();
    stroke.setAntiAlias(true);
    stroke.setStyle(PaintStyle.Stroke);
    stroke.setStrokeWidth(1.5);
    const line = Skia.Paint();
    line.setAntiAlias(true);
    const text = Skia.Paint();
    text.setAntiAlias(true);
    return { fill, stroke, line, text };
  }, []);

  // ---- UI-thread clock: extrapolate + smooth ----
  const displayMs = useSharedValue(clock.value.songMs);
  const lastSeq = useSharedValue(-1);
  const minArrivalDelta = useSharedValue(Number.MAX_SAFE_INTEGER);

  useFrameCallback((frame) => {
    'worklet';
    const c = clock.value;

    // Native hostMs and frame.timestamp should share a monotonic timebase
    // (CLOCK_MONOTONIC / mach_absolute_time). Guard anyway: learn a min-filtered offset
    // from sample arrival times and apply it only if the clocks clearly disagree.
    if (c.seq !== lastSeq.value) {
      lastSeq.value = c.seq;
      const delta = frame.timestamp - c.hostMs;
      if (delta < minArrivalDelta.value) minArrivalDelta.value = delta;
    }
    const timebaseOffset = Math.abs(minArrivalDelta.value) > 250 ? minArrivalDelta.value : 0;

    const frameDur = frame.timeSincePreviousFrame ?? 16.7;
    // Draw where the song WILL be when this frame is scanned out (~1 frame of pipeline).
    const presentAt = frame.timestamp + frameDur - timebaseOffset;
    let target = c.playing ? c.songMs + (presentAt - c.hostMs) : c.songMs;

    if (c.playing) {
      // Slew small corrections (timestamp jitter) over ~10 frames; snap on seeks/restarts.
      const predicted = displayMs.value + frameDur;
      const err = target - predicted;
      if (Math.abs(err) < 40) target = predicted + err * 0.1;
    }
    displayMs.value = target;
  }, true);

  const picture = useDerivedValue(() =>
    createPicture((canvas) => {
      drawHighway(canvas, displayMs.value, packed, judgments.value, judgedAt.value, layout, paints, font);
    }),
  );

  return (
    <Canvas style={{ width, height }}>
      <Picture picture={picture} />
    </Canvas>
  );
}
