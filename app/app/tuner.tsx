import React from 'react';
import { ScrollView, Text } from 'react-native';

import { useSoloistEngine } from '../src/audio/useSoloistEngine';
import { Centered } from '../src/ui/components';
import { colors, space, type } from '../src/ui/theme';
import { TunerView } from '../src/ui/TunerView';

export default function TunerScreen() {
  const engine = useSoloistEngine();
  if (engine.error) return <Centered text={engine.error} action={{ label: 'Try again', onPress: engine.retry }} />;
  if (!engine.ready) return <Centered spinner text="Starting the microphone…" />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space(4) }}>
      <TunerView />
      <Text style={[type.small, { textAlign: 'center', marginTop: space(6) }]}>
        Standard tuning, low to high: E A D G B E. Pluck one string at a time and let it ring.
      </Text>
    </ScrollView>
  );
}
