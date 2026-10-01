import { combineReducers, configureStore } from '@reduxjs/toolkit';

import progression from './progressionSlice';
import session from './sessionSlice';
import settings from './settingsSlice';

export const rootReducer = combineReducers({ progression, session, settings });
export type RootState = ReturnType<typeof rootReducer>;

/** Unpersisted store — used by tests. */
export const makeStore = (preloadedState?: Partial<RootState>) =>
  configureStore({ reducer: rootReducer, preloadedState });

export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore['dispatch'];
