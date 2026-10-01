import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type { Experience } from '../game/skillTree';

/** Device- and player-preference settings (persisted). */
export type GradingMode = 'relaxed' | 'standard' | 'strict';
export type HighwaySpeed = 'slow' | 'normal' | 'fast';
export type GuideMode = 'auto' | 'always' | 'off';

export interface SettingsState {
  onboardingComplete: boolean;
  experience: Experience | null;
  /** null = auto-detect (dev build: your computer's IP; otherwise app.json extra.apiUrl). */
  serverUrl: string | null;
  gradingMode: GradingMode;
  highwaySpeed: HighwaySpeed;
  /** auto = the guide guitar fades out as you earn crowns. */
  guideMode: GuideMode;
  haptics: boolean;
  /** Per-device latency residual from the latency check; null = never measured. */
  calibrationOffsetMs: number | null;
}

export const initialSettings: SettingsState = {
  onboardingComplete: false,
  experience: null,
  serverUrl: null,
  gradingMode: 'standard',
  highwaySpeed: 'normal',
  guideMode: 'auto',
  haptics: true,
  calibrationOffsetMs: null,
};

/** How far ahead the highway shows notes. Slower = more reading time. */
export const LOOKAHEAD_MS: Record<HighwaySpeed, number> = { slow: 3400, normal: 2600, fast: 1900 };

const settingsSlice = createSlice({
  name: 'settings',
  initialState: initialSettings,
  reducers: {
    onboardingCompleted(state) {
      state.onboardingComplete = true;
    },
    onboardingRestarted(state) {
      state.onboardingComplete = false;
    },
    experienceSet(state, { payload }: PayloadAction<Experience>) {
      state.experience = payload;
    },
    serverUrlSet(state, { payload }: PayloadAction<string | null>) {
      const v = payload?.trim();
      state.serverUrl = v ? (/^https?:\/\//.test(v) ? v : `http://${v}`).replace(/\/+$/, '') : null;
    },
    gradingModeSet(state, { payload }: PayloadAction<GradingMode>) {
      state.gradingMode = payload;
    },
    highwaySpeedSet(state, { payload }: PayloadAction<HighwaySpeed>) {
      state.highwaySpeed = payload;
    },
    guideModeSet(state, { payload }: PayloadAction<GuideMode>) {
      state.guideMode = payload;
    },
    hapticsSet(state, { payload }: PayloadAction<boolean>) {
      state.haptics = payload;
    },
    calibrationSaved(state, { payload }: PayloadAction<number>) {
      state.calibrationOffsetMs = Math.round(payload * 10) / 10;
    },
    calibrationNudged(state, { payload }: PayloadAction<number>) {
      state.calibrationOffsetMs = Math.round(((state.calibrationOffsetMs ?? 0) + payload) * 10) / 10;
    },
  },
});

export const settingsActions = settingsSlice.actions;
export default settingsSlice.reducer;
