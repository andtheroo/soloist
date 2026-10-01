export interface InitOptions {
  /** Lowest fundamental to detect. Guitar 70, bass 38, ukulele 250. Sets YIN window length. */
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Per-device residual latency from calibration (see src/audio/calibration.ts). */
  calibrationOffsetMs?: number;
}

export interface StemSpec {
  id: string; // e.g. "drums" | "bass" | "backing" | "guide"
  uri: string; // local file:// URI (downloaded + cached by the app)
  gain: number;
}

export interface LatencyReport {
  platform: 'android' | 'ios';
  audioApi: 'AAudio' | 'OpenSLES' | 'AVAudioEngine';
  sampleRate: number;
  inputSampleRate: number;
  outputLatencyMs: number;
  inputLatencyMs: number;
  framesPerBurst?: number;
  bufferSizeFrames?: number;
  ioBufferMs?: number;
  exclusive?: boolean;
  lowLatency?: boolean;
  mmap?: boolean;
  xruns?: number;
  featureLowLatency?: boolean;
  featurePro?: boolean;
  bluetoothOutput: boolean;
  wiredOrUsbOutput: boolean;
}

export interface PermissionResult {
  granted: boolean;
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

/** A note onset heard by the native analyzer, already mapped onto the song timeline. */
export interface DetectedNote {
  /** Song position the player was hearing when they played (latency-compensated). */
  songMs: number;
  /** Fractional MIDI from blind YIN; -1 when unpitched (muted strum, noise). */
  midi: number;
  confidence: number;
  levelDb: number;
  /** Host ms when detection completed — feedbackLatency = detectedAtMs - onset host time. */
  detectedAtMs: number;
  /** Indices into the expected-note list whose pitch was verified at this onset. */
  verified: number[];
}

export interface AudioSnapshot {
  songMs: number; // audible song position at hostNowMs
  hostNowMs: number; // same timebase as Reanimated frame timestamps
  playing: boolean;
  ended: boolean;
  inputDb: number;
  durationMs: number;
  overflows: number;
  deviceGeneration: number;
  /** Continuous pitch for the tuner (0 when tuner disabled or silent). */
  tunerHz: number;
  tunerConfidence: number;
  /** Increments every time the practice A–B loop wraps. */
  loopCount: number;
  events: DetectedNote[];
}

/** Mirrors `enum PollField` in cpp/AudioCore.h. Keep in sync. */
export const Poll = {
  SONG_MS: 0,
  HOST_NOW_MS: 1,
  PLAYING: 2,
  ENDED: 3,
  INPUT_DB: 4,
  DURATION_MS: 5,
  OVERFLOWS: 6,
  DEVICE_GENERATION: 7,
  TUNER_HZ: 8,
  TUNER_CONFIDENCE: 9,
  LOOP_COUNT: 10,
  EVENT_COUNT: 11,
  HEADER: 12,
  EVENT_FIXED_FIELDS: 6, // songMs, midi, confidence, levelDb, detectedAtMs, nVerified
} as const;
