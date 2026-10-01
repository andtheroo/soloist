import { router } from 'expo-router';
import React from 'react';
import { ScrollView } from 'react-native';

import { useSoloistEngine } from '../src/audio/useSoloistEngine';
import { useAppDispatch, useAppSelector } from '../src/store';
import { settingsActions } from '../src/store/settingsSlice';
import { CalibrationView } from '../src/ui/CalibrationView';
import { Centered } from '../src/ui/components';
import { colors, space } from '../src/ui/theme';

export default function CalibrateScreen() {
  const engine = useSoloistEngine();
  const dispatch = useAppDispatch();
  const saved = useAppSelector((s) => s.settings.calibrationOffsetMs);
  if (engine.error) return <Centered text={engine.error} action={{ label: 'Try again', onPress: engine.retry }} />;
  if (!engine.ready) return <Centered spinner text="Starting audio…" />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space(5) }}>
      <CalibrationView
        report={engine.report}
        currentOffsetMs={saved}
        onSave={(ms) => {
          dispatch(settingsActions.calibrationSaved(ms));
          router.back();
        }}
      />
    </ScrollView>
  );
}
