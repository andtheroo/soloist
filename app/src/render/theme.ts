import { Judgment } from '../grading/types';

/** Highway colours (CSS strings; Skia.Color parses them on the UI thread). */
export const HIGHWAY_COLORS = {
  background: '#0e1117',
  string: '#2b3240',
  beat: '#1c222c',
  downbeat: '#343d4d',
  nowLine: '#ffffff',
  text: '#0e1117',
  chordLabel: '#c9d1e0',
  headStroke: 'rgba(255,255,255,0.2)',
  // One colour per string (1 = high E ... 6 = low E), Rocksmith-ish ordering.
  lanes: ['#b36bff', '#3fb6ff', '#4fd98b', '#ffc44d', '#ff8a3d', '#ff4d6d'],
  judgment: {
    [Judgment.Perfect]: '#ffd84d',
    [Judgment.Great]: '#5cf08a',
    [Judgment.Good]: '#5cd6f0',
    [Judgment.Miss]: '#4a5160',
    [Judgment.WrongPitch]: '#ff5a4d',
  } as Record<number, string>,
};

export interface HighwayLayout {
  width: number;
  height: number;
  nowX: number;
  top: number;
  laneH: number;
  pxPerMs: number;
  pastMs: number;
  lookaheadMs: number;
  headW: number;
  headH: number;
  fontSize: number;
}

export function computeLayout(
  width: number,
  height: number,
  strings: number,
  lookaheadMs: number,
  nowLineFraction: number,
): HighwayLayout {
  const top = 28; // room for chord symbols above the top string
  const bottomPad = 12;
  const laneH = (height - top - bottomPad) / strings;
  const nowX = width * nowLineFraction;
  const pxPerMs = (width - nowX) / lookaheadMs;
  const headH = Math.min(34, laneH * 0.82);
  return {
    width,
    height,
    nowX,
    top,
    laneH,
    pxPerMs,
    pastMs: nowX / pxPerMs + 50,
    lookaheadMs,
    headW: headH * 1.25,
    headH,
    fontSize: Math.round(headH * 0.58),
  };
}
