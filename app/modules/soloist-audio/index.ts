import { requireNativeModule } from 'expo';

import { decodeSnapshot } from './src/decode';
import {
  AudioSnapshot,
  InitOptions,
  LatencyReport,
  PermissionResult,
  StemSpec,
} from './src/SoloistAudio.types';

export * from './src/SoloistAudio.types';
export { decodeSnapshot };

interface NativeSoloistAudio {
  requestMicPermission(): Promise<PermissionResult>;
  initialize(opts: InitOptions): Promise<LatencyReport>;
  loadSong(stems: StemSpec[]): Promise<{ durationMs: number }>;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setStemGain(id: string, gain: number): boolean;
  setCalibrationOffsetMs(ms: number): void;
  setExpectedNotes(flatTimeMidi: number[]): void;
  setLoop(startMs: number, endMs: number): void;
  setTunerEnabled(on: boolean): void;
  pollState(): number[];
  getLatencyReport(): Promise<LatencyReport>;
  shutdown(): Promise<void>;
}

const Native = requireNativeModule<NativeSoloistAudio>('SoloistAudio');

export const SoloistAudio = {
  requestMicPermission: () => Native.requestMicPermission(),
  initialize: (opts: InitOptions = {}) => Native.initialize(opts),
  loadSong: (stems: StemSpec[]) => Native.loadSong(stems),
  play: () => Native.play(),
  pause: () => Native.pause(),
  seek: (ms: number) => Native.seek(ms),
  setStemGain: (id: string, gain: number) => Native.setStemGain(id, gain),
  setCalibrationOffsetMs: (ms: number) => Native.setCalibrationOffsetMs(ms),
  /** Chart notes for target-informed pitch verification (indices must match grader's). */
  setExpectedNotes: (notes: ReadonlyArray<{ timeMs: number; midi: number }>) => {
    const flat: number[] = new Array(notes.length * 2);
    notes.forEach((n, i) => {
      flat[2 * i] = n.timeMs;
      flat[2 * i + 1] = n.midi;
    });
    Native.setExpectedNotes(flat);
  },
  /** Practice A–B loop (song ms). Pass (0, 0) to clear. */
  setLoop: (startMs: number, endMs: number) => Native.setLoop(startMs, endMs),
  setTunerEnabled: (on: boolean) => Native.setTunerEnabled(on),
  poll: (): AudioSnapshot => decodeSnapshot(Native.pollState()),
  getLatencyReport: () => Native.getLatencyReport(),
  shutdown: () => Native.shutdown(),
};

export default SoloistAudio;
