import Constants from 'expo-constants';
import { router } from 'expo-router';
import React from 'react';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';

import { clearStemCache } from '../src/api/client';
import { useSoloistEngine } from '../src/audio/useSoloistEngine';
import { DAILY_GOAL_OPTIONS } from '../src/game/xp';
import { useAppDispatch, useAppSelector } from '../src/store';
import { progressionActions } from '../src/store/progressionSlice';
import { GradingMode, GuideMode, HighwaySpeed, settingsActions } from '../src/store/settingsSlice';
import { Button, Card, SectionLabel, Segmented } from '../src/ui/components';
import { ServerSetup } from '../src/ui/ServerSetup';
import { colors, space, type } from '../src/ui/theme';

export default function SettingsScreen() {
  const dispatch = useAppDispatch();
  const s = useAppSelector((st) => st.settings);
  const goal = useAppSelector((st) => st.progression.dailyGoalXp);
  const engine = useSoloistEngine();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space(4), paddingBottom: space(20) }}>
      <SectionLabel>Daily goal</SectionLabel>
      <Segmented
        options={DAILY_GOAL_OPTIONS.map((o) => ({ value: o.xp, label: o.label, hint: `${o.xp} XP` }))}
        value={goal}
        onChange={(v) => dispatch(progressionActions.dailyGoalSet(v))}
      />

      <SectionLabel>Grading</SectionLabel>
      <Segmented<GradingMode>
        options={[
          { value: 'relaxed', label: 'Relaxed', hint: '±35 ms perfect' },
          { value: 'standard', label: 'Standard', hint: 'eases you in' },
          { value: 'strict', label: 'Strict', hint: '±18 ms perfect' },
        ]}
        value={s.gradingMode}
        onChange={(v) => dispatch(settingsActions.gradingModeSet(v))}
      />

      <SectionLabel>Note highway speed</SectionLabel>
      <Segmented<HighwaySpeed>
        options={[
          { value: 'slow', label: 'Slow', hint: 'more reading time' },
          { value: 'normal', label: 'Normal' },
          { value: 'fast', label: 'Fast' },
        ]}
        value={s.highwaySpeed}
        onChange={(v) => dispatch(settingsActions.highwaySpeedSet(v))}
      />

      <SectionLabel>Guide guitar in lessons</SectionLabel>
      <Segmented<GuideMode>
        options={[
          { value: 'auto', label: 'Auto', hint: 'fades with crowns' },
          { value: 'always', label: 'Always on' },
          { value: 'off', label: 'Off' },
        ]}
        value={s.guideMode}
        onChange={(v) => dispatch(settingsActions.guideModeSet(v))}
      />

      <SectionLabel>Feedback</SectionLabel>
      <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={type.body}>Vibrate on wrong notes and new crowns</Text>
        <Switch value={s.haptics} onValueChange={(v) => {
            dispatch(settingsActions.hapticsSet(v));
          }} />
      </Card>

      <SectionLabel>Lesson server</SectionLabel>
      <Card>
        <ServerSetup autoTest={false} />
      </Card>

      <SectionLabel>Latency</SectionLabel>
      <Card style={{ gap: space(3) }}>
        <Text style={type.body}>
          {s.calibrationOffsetMs === null
            ? 'Not measured yet. Run the latency check once per phone (and again if you switch headphones).'
            : `Offset ${s.calibrationOffsetMs.toFixed(1)} ms. If you're always graded early or late, nudge it.`}
        </Text>
        <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
          {[-5, -1, 1, 5].map((d) => (
            <Button
              key={d}
              label={`${d > 0 ? '+' : ''}${d} ms`}
              variant="secondary"
              style={{ paddingVertical: 8, minHeight: 36, paddingHorizontal: 12 }}
              onPress={() => dispatch(settingsActions.calibrationNudged(d))}
            />
          ))}
        </View>
        <Button label="Run latency check" onPress={() => router.push('/calibrate')} />
      </Card>

      <SectionLabel>Audio diagnostics</SectionLabel>
      <Card>
        {engine.report ? (
          <Text style={type.small}>
            {engine.report.platform} · {engine.report.audioApi} · {engine.report.sampleRate} Hz{'\n'}
            Output {engine.report.outputLatencyMs.toFixed(1)} ms · Input {engine.report.inputLatencyMs.toFixed(1)} ms
            {engine.report.framesPerBurst ? ` · burst ${engine.report.framesPerBurst}` : ''}
            {engine.report.bufferSizeFrames ? ` · buffer ${engine.report.bufferSizeFrames}` : ''}
            {'\n'}
            {engine.report.mmap ? 'MMAP fast path ✓' : 'MMAP not in use'} · {engine.report.exclusive ? 'exclusive' : 'shared'} ·{' '}
            {engine.report.featurePro ? 'pro audio device' : engine.report.featureLowLatency ? 'low-latency device' : 'standard device'}
            {engine.report.bluetoothOutput ? '\n⚠ Bluetooth output adds latency' : ''}
          </Text>
        ) : (
          <Text style={type.small}>{engine.error ?? 'Starting audio…'}</Text>
        )}
      </Card>

      <SectionLabel>Storage & account</SectionLabel>
      <View style={{ gap: space(3) }}>
        <Button
          label="Clear downloaded audio"
          variant="secondary"
          onPress={() => {
            clearStemCache();
            Alert.alert('Cleared', 'Lesson audio will download again when needed.');
          }}
        />
        <Button
          label="Replay the intro"
          variant="secondary"
          onPress={() => {
            dispatch(settingsActions.onboardingRestarted());
            router.replace('/onboarding');
          }}
        />
        <Button
          label="Reset all progress"
          variant="danger"
          onPress={() =>
            Alert.alert('Reset everything?', 'XP, streak, crowns and history will be deleted.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive', onPress: () => dispatch(progressionActions.progressionReset()) },
            ])
          }
        />
      </View>
      <Text style={[type.small, { textAlign: 'center', marginTop: space(8) }]}>Soloist {Constants.expoConfig?.version ?? ''}</Text>
    </ScrollView>
  );
}
