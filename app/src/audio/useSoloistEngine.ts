import { useCallback, useEffect, useState } from 'react';

import { useAppSelector } from '../store';
import { SoloistAudio } from './native';
import type { LatencyReport } from './native';

/** App-lifetime singleton: the native engine is opened once and kept warm between screens. */
let enginePromise: Promise<LatencyReport> | null = null;

function ensureEngine(calibrationOffsetMs: number): Promise<LatencyReport> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const perm = await SoloistAudio.requestMicPermission();
      if (!perm.granted) {
        throw new Error("Soloist needs the microphone to hear you play. Allow it in your phone's Settings → Apps → Soloist → Permissions, then tap Try again.");
      }
      return SoloistAudio.initialize({ minFrequencyHz: 70, maxFrequencyHz: 1400, calibrationOffsetMs });
    })();
    enginePromise.catch(() => (enginePromise = null)); // allow retry after a denial
  }
  return enginePromise;
}

export interface EngineState {
  ready: boolean;
  report: LatencyReport | null;
  error: string | null;
  /** Human-readable problems worth surfacing before a lesson. */
  warnings: string[];
  retry(): void;
}

export function useSoloistEngine(): EngineState {
  const calibration = useAppSelector((s) => s.settings.calibrationOffsetMs);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<EngineState, 'retry'>>({ ready: false, report: null, error: null, warnings: [] });

  useEffect(() => {
    let alive = true;
    ensureEngine(calibration ?? 0)
      .then((report) => {
        if (!alive) return;
        const warnings: string[] = [];
        if (report.bluetoothOutput) warnings.push('Bluetooth headphones add 100–300 ms of delay. Wired or USB is best.');
        if (!report.wiredOrUsbOutput && !report.bluetoothOutput)
          warnings.push('Tip: headphones stop the backing track leaking into the mic.');
        if (report.platform === 'android' && report.audioApi !== 'AAudio')
          warnings.push('This phone uses the legacy audio path; timing is calibrated but feedback may feel slower.');
        if (calibration === null) warnings.push('Run the 20-second latency check (Settings) for the most accurate grading.');
        setState({ ready: true, report, error: null, warnings });
      })
      .catch((e: Error) => alive && setState((s) => ({ ...s, ready: false, error: e.message })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Keep native calibration in sync when the player recalibrates or nudges it.
  useEffect(() => {
    if (state.ready) SoloistAudio.setCalibrationOffsetMs(calibration ?? 0);
  }, [state.ready, calibration]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
