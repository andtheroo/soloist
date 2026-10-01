import { useEffect, useRef, useState } from 'react';

import { readTuner, TunerReading } from '../game/tuning';
import { SoloistAudio } from './native';

/**
 * Turns on the native tuner (continuous YIN on the mic) while mounted and polls it
 * ~20x/second. Polling shares the same pollState() call as the game pump, so the tuner
 * must not be open at the same time as a lesson (it never is: separate screens).
 */
export function useTuner(enabled: boolean) {
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [level, setLevel] = useState(-120);
  const smooth = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    SoloistAudio.pause();
    SoloistAudio.setTunerEnabled(true);
    const id = setInterval(() => {
      const snap = SoloistAudio.poll();
      setLevel(snap.inputDb);
      if (snap.tunerConfidence > 0 && snap.tunerHz > 0) {
        // Light smoothing in the log domain keeps the needle calm without lagging.
        const cents = 1200 * Math.log2(snap.tunerHz);
        smooth.current = smooth.current === null || Math.abs(cents - smooth.current) > 80 ? cents : smooth.current * 0.6 + cents * 0.4;
        setReading(readTuner(Math.pow(2, smooth.current / 1200)));
      } else {
        smooth.current = null;
        setReading(null);
      }
    }, 50);
    return () => {
      clearInterval(id);
      SoloistAudio.setTunerEnabled(false);
    };
  }, [enabled]);

  return { reading, level };
}
