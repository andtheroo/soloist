import { AudioSnapshot, DetectedNote, Poll } from './SoloistAudio.types';

/** Decodes the flat Float64 array produced by AudioCore::pollState(). Pure — unit tested. */
export function decodeSnapshot(raw: ArrayLike<number>): AudioSnapshot {
  const events: DetectedNote[] = [];
  const count = raw.length > Poll.EVENT_COUNT ? raw[Poll.EVENT_COUNT] : 0;
  let w = Poll.HEADER;
  for (let e = 0; e < count && w + Poll.EVENT_FIXED_FIELDS <= raw.length; e++) {
    const nVerified = raw[w + 5];
    const verified: number[] = [];
    for (let k = 0; k < nVerified; k++) verified.push(raw[w + 6 + k]);
    events.push({
      songMs: raw[w],
      midi: raw[w + 1],
      confidence: raw[w + 2],
      levelDb: raw[w + 3],
      detectedAtMs: raw[w + 4],
      verified,
    });
    w += Poll.EVENT_FIXED_FIELDS + nVerified;
  }
  return {
    songMs: raw[Poll.SONG_MS] ?? 0,
    hostNowMs: raw[Poll.HOST_NOW_MS] ?? 0,
    playing: raw[Poll.PLAYING] === 1,
    ended: raw[Poll.ENDED] === 1,
    inputDb: raw[Poll.INPUT_DB] ?? -120,
    durationMs: raw[Poll.DURATION_MS] ?? 0,
    overflows: raw[Poll.OVERFLOWS] ?? 0,
    deviceGeneration: raw[Poll.DEVICE_GENERATION] ?? 0,
    tunerHz: raw[Poll.TUNER_HZ] ?? 0,
    tunerConfidence: raw[Poll.TUNER_CONFIDENCE] ?? 0,
    loopCount: raw[Poll.LOOP_COUNT] ?? 0,
    events,
  };
}
