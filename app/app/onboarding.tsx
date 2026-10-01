import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { loadCourse } from '../src/api/client';
import { useSoloistEngine } from '../src/audio/useSoloistEngine';
import { Experience, placementSkills } from '../src/game/skillTree';
import { DAILY_GOAL_OPTIONS } from '../src/game/xp';
import { store, useAppDispatch, useAppSelector } from '../src/store';
import { progressionActions } from '../src/store/progressionSlice';
import { settingsActions } from '../src/store/settingsSlice';
import { CalibrationView } from '../src/ui/CalibrationView';
import { Button, Card, ProgressBar } from '../src/ui/components';
import { ServerSetup } from '../src/ui/ServerSetup';
import { colors, radius, space, type } from '../src/ui/theme';
import { TunerView } from '../src/ui/TunerView';

const STEPS = ['welcome', 'instrument', 'experience', 'goal', 'server', 'mic', 'tune', 'latency', 'done'] as const;
type Step = (typeof STEPS)[number];

export default function Onboarding() {
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)]);
  const back = () => setStep(STEPS[Math.max(0, idx - 1)]);

  const finish = async () => {
    setBusy(true);
    try {
      const course = await loadCourse();
      const exp: Experience = store.getState().settings.experience ?? 'new';
      dispatch(progressionActions.placementApplied({ skillIds: placementSkills(course.skills, exp) }));
    } catch {
      /* placement is optional; the server can be fixed later in Settings */
    }
    dispatch(settingsActions.onboardingCompleted());
    router.replace('/');
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + space(3), paddingBottom: insets.bottom + space(3) }]}>
      <View style={styles.header}>
        {idx > 0 && step !== 'done' ? (
          <Pressable onPress={back} hitSlop={12}>
            <Text style={{ color: colors.sub, fontSize: 22 }}>‹</Text>
          </Pressable>
        ) : (
          <View style={{ width: 12 }} />
        )}
        <View style={{ flex: 1 }}>
          <ProgressBar progress={idx / (STEPS.length - 1)} height={6} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: space(5), gap: space(4), flexGrow: 1 }}>
        {step === 'welcome' && (
          <>
            <Text style={styles.hero}>🎸</Text>
            <Text style={type.title}>Learn guitar, three minutes at a time.</Text>
            <Text style={type.body}>
              Soloist listens while you play and grades every note: timing to the millisecond, and pitch. Short daily
              sessions, real songs, a skill tree to climb.
            </Text>
            <View style={{ flex: 1 }} />
            <Button label="Get started" onPress={next} />
          </>
        )}

        {step === 'instrument' && (
          <>
            <Text style={type.title}>What will you play?</Text>
            <Choice title="Guitar" subtitle="Acoustic or electric, standard tuning" selected onPress={next} />
            <Choice title="Bass" subtitle="Coming soon" disabled />
            <Choice title="Ukulele" subtitle="Coming soon" disabled />
          </>
        )}

        {step === 'experience' && <ExperienceStep onDone={next} />}

        {step === 'goal' && <GoalStep onDone={next} />}

        {step === 'server' && (
          <>
            <Text style={type.title}>Connect to your lesson server</Text>
            <Text style={type.body}>
              Lessons and backing tracks come from the Soloist server running on your computer. Start it with{' '}
              <Text style={styles.code}>npm start</Text> in the <Text style={styles.code}>server</Text> folder; it prints the
              address to type here. Your phone and computer must be on the same Wi-Fi.
            </Text>
            <ServerSetup />
            <View style={{ flex: 1 }} />
            <Button label="Continue" onPress={next} />
          </>
        )}

        {step === 'mic' && <MicStep onDone={next} />}

        {step === 'tune' && (
          <>
            <Text style={type.title}>Tune up</Text>
            <Text style={type.body}>An in-tune guitar makes grading fair. Pluck each open string and turn its peg until it says “In tune”.</Text>
            <EngineGate>
              <TunerView />
            </EngineGate>
            <Button label="My guitar is tuned" onPress={next} />
          </>
        )}

        {step === 'latency' && (
          <>
            <Text style={type.title}>One-time latency check</Text>
            <EngineGate>
              <LatencyStep onDone={next} />
            </EngineGate>
          </>
        )}

        {step === 'done' && (
          <>
            <Text style={styles.hero}>🎉</Text>
            <Text style={type.title}>You're ready.</Text>
            <Text style={type.body}>
              Your first lesson takes three minutes. Use headphones if you can, keep your guitar in your lap, and watch
              the notes slide into the white line.
            </Text>
            <View style={{ flex: 1 }} />
            <Button label="Let's play" onPress={finish} loading={busy} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ExperienceStep({ onDone }: { onDone(): void }) {
  const dispatch = useAppDispatch();
  const pick = (e: Experience) => {
    dispatch(settingsActions.experienceSet(e));
    onDone();
  };
  return (
    <>
      <Text style={type.title}>How much have you played?</Text>
      <Choice title="I'm brand new" subtitle="Start from the very first string" onPress={() => pick('new')} />
      <Choice title="I know a few things" subtitle="Skip open strings, first frets and rhythm basics" onPress={() => pick('some')} />
      <Choice title="I play already" subtitle="Unlock up to chords, melodies and the pentatonic" onPress={() => pick('experienced')} />
    </>
  );
}

function GoalStep({ onDone }: { onDone(): void }) {
  const dispatch = useAppDispatch();
  const goal = useAppSelector((s) => s.progression.dailyGoalXp);
  return (
    <>
      <Text style={type.title}>Pick a daily goal</Text>
      <Text style={type.body}>One 3-minute lesson earns about 20–30 XP.</Text>
      {DAILY_GOAL_OPTIONS.map((o) => (
        <Choice
          key={o.xp}
          title={`${o.label} · ${o.xp} XP / day`}
          subtitle={o.xp <= 10 ? 'One short session' : o.xp <= 20 ? 'About one lesson' : o.xp <= 30 ? 'One or two lessons' : 'Two or more lessons'}
          selected={goal === o.xp}
          onPress={() => {
            dispatch(progressionActions.dailyGoalSet(o.xp));
            onDone();
          }}
        />
      ))}
    </>
  );
}

function MicStep({ onDone }: { onDone(): void }) {
  const engine = useSoloistEngine();
  return (
    <>
      <Text style={type.title}>Let Soloist hear you</Text>
      <Text style={type.body}>
        The microphone is used only on this phone, only while a lesson, the tuner or the latency check is open. Nothing is
        recorded or uploaded.
      </Text>
      {engine.ready && (
        <Card>
          <Text style={[type.h2, { color: colors.accent }]}>✓ Microphone ready</Text>
          {engine.warnings
            .filter((w) => !w.startsWith('Run the'))
            .map((w) => (
              <Text key={w} style={[type.small, { marginTop: 6 }]}>{w}</Text>
            ))}
        </Card>
      )}
      {engine.error && <Text style={{ color: colors.red }}>{engine.error}</Text>}
      <View style={{ flex: 1 }} />
      {engine.error ? <Button label="Try again" onPress={engine.retry} /> : <Button label="Continue" onPress={onDone} disabled={!engine.ready} />}
    </>
  );
}

function LatencyStep({ onDone }: { onDone(): void }) {
  const dispatch = useAppDispatch();
  const engine = useSoloistEngine();
  const saved = useAppSelector((s) => s.settings.calibrationOffsetMs);
  return (
    <CalibrationView
      report={engine.report}
      currentOffsetMs={saved}
      onSave={(ms) => {
        dispatch(settingsActions.calibrationSaved(ms));
        onDone();
      }}
      onSkip={onDone}
    />
  );
}

/** Renders children only once the audio engine is running (mic permission granted). */
function EngineGate({ children }: { children: React.ReactNode }) {
  const engine = useSoloistEngine();
  if (engine.error) return <Text style={{ color: colors.red }}>{engine.error}</Text>;
  if (!engine.ready) return <Text style={type.body}>Starting audio…</Text>;
  return <>{children}</>;
}

function Choice({
  title,
  subtitle,
  selected,
  disabled,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?(): void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && { borderColor: colors.accent },
        { opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={type.h2}>{title}</Text>
      {subtitle && <Text style={[type.small, { marginTop: 2 }]}>{subtitle}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(5) },
  hero: { fontSize: 72, marginTop: space(8) },
  code: { fontFamily: 'monospace', color: colors.text },
  choice: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(4), borderWidth: 2, borderColor: 'transparent' },
});
