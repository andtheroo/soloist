import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useExercisePlayer } from '../../src/audio/useExercisePlayer';
import { useSoloistEngine } from '../../src/audio/useSoloistEngine';
import { DEFAULT_GRADING, GradeSummary, LENIENT_GRADING, STRICT_GRADING } from '../../src/grading/types';
import { TabHighway } from '../../src/render/TabHighway';
import { useAppDispatch, useAppSelector } from '../../src/store';
import { LOOKAHEAD_MS } from '../../src/store/settingsSlice';
import { finishPractice } from '../../src/store/thunks';
import { Button, Centered } from '../../src/ui/components';
import { colors, radius, space, type } from '../../src/ui/theme';
import { useImmersive } from '../../src/ui/useImmersive';
import { useOrientation } from '../../src/ui/useOrientation';

const SPEEDS = [50, 60, 75, 90, 100];
const TOP_BAR = 44;
const CONTROLS = 96;

/**
 * Practice mode: loop any bars, slow down (server renders 50–100 % variants),
 * mute the guide / bass / click. Each pass through the loop is scored; finishing a
 * pass earns XP and wins back a heart.
 */
export default function PracticeScreen() {
  useOrientation('landscape');
  useImmersive();
  const { chartId, songId, skillId } = useLocalSearchParams<{ chartId: string; songId: string; skillId?: string }>();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.settings);
  const engine = useSoloistEngine();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [speed, setSpeed] = useState(75);
  const [bars, setBars] = useState<{ from: number; to: number } | null>(null);
  const [mix, setMix] = useState({ guide: true, bass: true, click: true });
  const [playing, setPlaying] = useState(false);
  const [passes, setPasses] = useState<GradeSummary[]>([]);

  const grading =
    settings.gradingMode === 'relaxed' ? LENIENT_GRADING : settings.gradingMode === 'strict' ? STRICT_GRADING : DEFAULT_GRADING;

  // Bars are computed from the loaded chart; loop times follow tempo changes automatically.
  const [barStarts, setBarStarts] = useState<number[]>([]);
  const contentBars = Math.max(1, barStarts.length - 2); // minus count-in and tail bars
  const range = bars ?? { from: 1, to: contentBars };
  const loop = barStarts.length
    ? { startMs: barStarts[range.from], endMs: barStarts[range.to + 1] ?? barStarts[barStarts.length - 1] }
    : null;

  const player = useExercisePlayer({
    chartId: engine.ready ? chartId : undefined,
    songId: engine.ready ? songId : undefined,
    speed,
    gains: { guide: mix.guide ? 0.9 : 0, bass: mix.bass ? 0.8 : 0, click: mix.click ? 0.5 : 0 },
    grading,
    loop,
    onPass: (summary) => {
      setPasses((p) => [...p, summary]);
      if (settings.haptics && summary.stars === 3) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  });

  // Recompute bar grid whenever a (re)loaded chart arrives.
  const chart = player.chart;
  useEffect(() => {
    if (chart) setBarStarts(chart.beats.filter((b) => b.downbeat).map((b) => b.timeMs));
  }, [chart]);

  const barMs = chart ? (60000 / chart.bpm) * 4 : 2000;

  const start = () => {
    if (!loop) return;
    player.restart(Math.max(0, loop.startMs - barMs)); // one bar of click before the loop
    player.play();
    setPlaying(true);
  };
  const stop = () => {
    player.pause();
    setPlaying(false);
  };

  const leave = async () => {
    player.pause();
    if (!passes.length) return router.back();
    const r = await dispatch(finishPractice({ chartId, skillId: skillId ?? null, passes })).unwrap();
    Alert.alert('Nice practice!', `+${r.xp.total} XP and +1 ♥`, [{ text: 'OK', onPress: () => router.back() }]);
  };

  const changeBars = (which: 'from' | 'to', delta: number) => {
    const next = { ...range };
    next[which] = Math.max(1, Math.min(contentBars, next[which] + delta));
    if (next.from > next.to) {
      if (which === 'from') next.to = next.from;
      else next.from = next.to;
    }
    stop();
    setBars(next);
  };

  if (engine.error) return <Centered text={engine.error} action={{ label: 'Try again', onPress: engine.retry }} />;
  if (player.error) {
    return <Centered text={player.error} action={{ label: 'Retry', onPress: player.reload }} secondary={{ label: 'Back', onPress: () => router.back() }} />;
  }
  if (!engine.ready || player.loading || !chart) return <Centered spinner text="Loading practice…" />;

  const last = passes[passes.length - 1];
  const best = passes.reduce((m, p) => Math.max(m, p.accuracy), 0);
  const highwayH = height - insets.top - insets.bottom - TOP_BAR - CONTROLS;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.topBar}>
        <Pressable onPress={leave} hitSlop={12} accessibilityLabel="Finish practice">
          <Text style={styles.close}>✕</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>Practice · {chart.title}</Text>
        {SPEEDS.map((s) => (
          <Pressable
            key={s}
            onPress={() => {
              stop();
              setSpeed(s);
            }}
            style={[styles.pill, s === speed && styles.pillOn]}
          >
            <Text style={[styles.pillText, s === speed && { color: colors.accentText }]}>{s}%</Text>
          </Pressable>
        ))}
      </View>

      <TabHighway
        chart={chart}
        clock={player.clock}
        judgments={player.judgments}
        judgedAt={player.judgedAt}
        width={width - insets.left - insets.right}
        height={highwayH}
        lookaheadMs={LOOKAHEAD_MS[settings.highwaySpeed]}
      />

      <View style={styles.controls}>
        <View style={styles.group}>
          <Text style={type.small}>Loop bars</Text>
          <View style={styles.stepper}>
            <Step label="−" onPress={() => changeBars('from', -1)} />
            <Text style={styles.stepValue}>{range.from}</Text>
            <Step label="+" onPress={() => changeBars('from', 1)} />
            <Text style={type.small}> to </Text>
            <Step label="−" onPress={() => changeBars('to', -1)} />
            <Text style={styles.stepValue}>{range.to}</Text>
            <Step label="+" onPress={() => changeBars('to', 1)} />
            <Text style={type.small}> of {contentBars}</Text>
          </View>
        </View>

        <View style={styles.group}>
          <Text style={type.small}>Mix</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            {(['guide', 'bass', 'click'] as const).map((k) => (
              <Pressable key={k} onPress={() => setMix((m) => ({ ...m, [k]: !m[k] }))} style={[styles.pill, mix[k] && styles.pillOn]}>
                <Text style={[styles.pillText, mix[k] && { color: colors.accentText }]}>{k}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={[styles.group, { flex: 1 }]}>
          <Text style={type.small}>{passes.length ? `Pass ${passes.length}` : 'Loop passes appear here'}</Text>
          {last ? (
            <Text style={[type.h2, { color: last.passed ? colors.accent : colors.orange }]}>
              {Math.round(last.accuracy * 100)}% {'★'.repeat(last.stars)}
              <Text style={type.small}>  best {Math.round(best * 100)}%</Text>
            </Text>
          ) : (
            <Text style={type.body}> </Text>
          )}
        </View>

        <Button label={playing ? 'Stop' : 'Play loop'} onPress={playing ? stop : start} variant={playing ? 'secondary' : 'primary'} />
      </View>
    </View>
  );
}

function Step({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={styles.stepBtn}>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { height: TOP_BAR, flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(4) },
  close: { color: colors.sub, fontSize: 20, fontWeight: '700', marginRight: space(2) },
  title: { flex: 1, color: colors.sub, fontSize: 15 },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  pillOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  controls: { height: CONTROLS, flexDirection: 'row', alignItems: 'center', gap: space(5), paddingHorizontal: space(4) },
  group: { gap: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  stepValue: { color: colors.text, fontWeight: '800', minWidth: 22, textAlign: 'center' },
});
