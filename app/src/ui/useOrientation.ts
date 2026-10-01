import * as ScreenOrientation from 'expo-screen-orientation';
import { useEffect } from 'react';

/**
 * The app is portrait, but the note highway wants the full width of a landscape screen.
 * Lock while the screen is mounted; restore portrait on the way out.
 */
export function useOrientation(mode: 'portrait' | 'landscape') {
  useEffect(() => {
    const lock =
      mode === 'landscape' ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    ScreenOrientation.lockAsync(lock).catch(() => {});
    return () => {
      if (mode === 'landscape') ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, [mode]);
}
