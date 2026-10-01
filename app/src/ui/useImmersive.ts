import { useEffect } from 'react';
import { Platform, StatusBar } from 'react-native';

import type * as KeepAwake from 'expo-keep-awake';
import type * as NavigationBar from 'expo-navigation-bar';

/**
 * Native modules that only exist in builds made after they were added. Loaded lazily so a
 * JS reload onto an older dev build degrades to a no-op instead of crashing at import.
 */
function optional<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}

const KEEP_AWAKE_TAG = 'soloist-play';

/**
 * Lessons and practice: hide the status and navigation bars (swipe from an edge to peek)
 * and keep the screen on. Everything is restored when the screen unmounts.
 */
export function useImmersive() {
  useEffect(() => {
    const status = StatusBar.pushStackEntry({ hidden: true, animated: true });
    const nav = Platform.OS === 'android' ? optional(() => require('expo-navigation-bar') as typeof NavigationBar) : null;
    const awake = optional(() => require('expo-keep-awake') as typeof KeepAwake);
    nav?.setVisibilityAsync('hidden').catch(() => {});
    awake?.activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      StatusBar.popStackEntry(status);
      nav?.setVisibilityAsync('visible').catch(() => {});
      awake?.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, []);
}
