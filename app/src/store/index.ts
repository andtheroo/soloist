import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import {
  createMigrate,
  FLUSH,
  PAUSE,
  PERSIST,
  persistReducer,
  persistStore,
  PURGE,
  REGISTER,
  REHYDRATE,
} from 'redux-persist';

import { initialHearts } from '../game/hearts';
import { rootReducer, RootState } from './rootReducer';
import { initialSettings } from './settingsSlice';

// v1 -> v2: calibration moved progression -> settings; hearts + history added.
const migrations = {
  2: (state: any) => {
    if (!state) return state;
    const p = state.progression ?? {};
    return {
      ...state,
      settings: { ...initialSettings, ...(state.settings ?? {}), calibrationOffsetMs: p.calibrationOffsetMs ?? null, onboardingComplete: true },
      progression: { ...p, hearts: p.hearts ?? initialHearts(Date.now()), history: p.history ?? [] },
    };
  },
};

// The micro-session is ephemeral; progression and settings persist.
const persisted = persistReducer(
  {
    key: 'soloist',
    version: 2,
    storage: AsyncStorage,
    whitelist: ['progression', 'settings'],
    migrate: createMigrate(migrations as any, { debug: false }),
  },
  rootReducer,
);

export const store = configureStore({
  reducer: persisted,
  middleware: (getDefault) =>
    getDefault({ serializableCheck: { ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER] } }),
});
export const persistor = persistStore(store);

export type AppDispatch = typeof store.dispatch;
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export type { RootState };
