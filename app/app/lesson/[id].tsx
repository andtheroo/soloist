import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, loadCourse } from '../../src/api/client';
import { useExercisePlayer } from '../../src/audio/useExercisePlayer';
import { useSoloistEngine } from '../../src/audio/useSoloistEngine';
import { guideGainForLevel, lessonSpeedForLevel } from '../../src/game/skillTree';
import type { XpBreakdown } from '../../src/game/xp';
import { DEFAULT_GRADING, GradeSummary, isHit, Judgment, LENIENT_GRADING, STRICT_GRADING } from '../../src/grading/types';
import { TabHighway } from '../../src/render/TabHighway';
import { useAppDispatch, useAppSelector } from '../../src/store';
import { progressionActions } from '../../src/store/progressionSlice';
import { selectCanRetry, selectCurrentExercise, selectTimeRemainingMs, sessionActions } from '../../src/store/sessionSlice';
import { LOOKAHEAD_MS } from '../../src/store/settingsSlice';
import { finishSession } from '../../src/store/thunks';
import type { SkillNodeDef } from '../../src/types/chart';
import { Button, Centered, Hearts } from '../../src/ui/components';
import { colors, radius, space, type } from '../../src/ui/theme';
import { useImmersive } from '../../src/ui/useImmersive';
import { useOrientation } from '../../src/ui/useOrientation';

const TOP_BAR = 44;
const BOTTOM_BAR = 36;

/** The 3-minute micro-session. Landscape, full-width highway, overlays for each phase. */
export default function LessonScreen() {
  useOrientation('landscape');
  useImmersive();
  const { id: lessonId, skillId } = useLocalSearchParams<{ id: string; skillId: string }>();
  const dispatch = useAppDispatch();
  const session = useAppSelector((s) => s.session);
  const settings = useAppSelector((s) => s.settings);
  const hearts = useAppSelector((s) => s.progression.hearts.hearts);
  const level = useAppSelector((s) => s.progression.skills[skillId]?.level ?? 0);
  const levelUp = useAppSelector((s) => s.progression.lastLevelUp);
  const engine = useSoloistEngine();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [skill, setSkill] = useState<SkillNodeDef | null>(null);
  const [xp, setXp] = useState<XpBreakdown | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const exercise = selectCurrentExercise(session);

  // ---- load lesson ----
  useEffect(() => {
    dispatch(sessionActions.sessionRequested({ lessonId, skillId }));
    Promise.all([api.lesson(lessonId), loadCourse()])
      .then(([lesson, course]) => {
        setSkill(course.skills.find((s) => s.id === skillId) ?? null);
        dispatch(sessionActions.sessionLoaded({ exercises: lesson.exercises, budgetMs: lesson.budgetMs }));
      })
      .catch((e: Error) => dispatch(sessionActions.sessionFailed(e.message)));
    return () => {
      dispatch(sessionActions.sessionReset());
    };
  }, [dispatch, lessonId, skillId, loadAttempt]);

  const grading = useMemo(() => {
    if (settings.gradingMode === 'relaxed') return LENIENT_GRADING;
    if (settings.gradingMode === 'strict') return STRICT_GRADING;
    return level === 0 ? LENIENT_GRADING : DEFAULT_GRADING;
  }, [settings.gradingMode, level]);

  const guide =
    settings.guideMode === 'always' ? 0.9 : settings.guideMode === 'off' ? 0 : guideGainForLevel(level, skill?.maxLevel ?? 3);

  const player = useExercisePlayer({
    chartId: engine.ready ? exercise?.chartId : undefined,
    songId: engine.ready ? exercise?.songId : undefined,
    speed: lessonSpeedForLevel(level),
    gains: { guide, bass: 0.8, click: 0.5 },
    grading,
    onGrades: (events, live) => {
      const hits = events.filter((e) => isHit(e.judgment)).length;
      if (settings.haptics && events.some((e) => e.judgment === Judgment.WrongPitch)) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      dispatch(sessionActions.gradesRecorded({ combo: live.combo, score: live.score, hits, judged: events.length }));
    },
    onActiveTime: (deltaMs) => dispatch(sessionActions.tick({ deltaMs })),
    onFinished: (summary) => {
      dispatch(sessionActions.exerciseFinished(summary));
      if (!summary.passed) dispatch(progressionActions.heartLost({ now: Date.now() }));
    },
  });

  // ---- session complete -> XP / streak / crowns ----
  useEffect(() => {
    if (session.phase === 'complete' && skill && !xp) {
      dispatch(finishSession({ skill, report: api.reportSession }))
        .unwrap()
        .then((r) => {
          setXp(r.xp);
          if (r.leveledUp && settings.haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        })
        .catch(() => setXp({ lines: [], total: 0 }));
    }
  }, [session.phase, skill, xp, dispatch, settings.haptics]);

  const start = () => {
    dispatch(sessionActions.countInStarted());
    player.play();
    dispatch(sessionActions.playbackStarted());
  };

  const quit = () => {
    const leave = () => {
      player.pause();
      if (session.results.length) dispatch(sessionActions.sessionEndedEarly('quit'));
      else router.back();
    };
    if (session.phase === 'complete') return router.back();
    Alert.alert('Leave lesson?', session.results.length ? 'You keep XP for finished exercises.' : 'Progress in this lesson will be lost.', [
      { text: 'Keep playing', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: leave },
    ]);
  };

  // ---------------------------------------------------------------- render
  if (engine.error) return <Centered text={engine.error} action={{ label: 'Try again', onPress: engine.retry }} />;
  const back = { label: 'Back', onPress: () => router.back() };
  if (session.phase === 'error') {
    return (
      <Centered
        text={session.error ?? 'Something went wrong'}
        action={{ label: 'Retry', onPress: () => setLoadAttempt((a) => a + 1) }}
        secondary={back}
      />
    );
  }
  if (player.error) return <Centered text={player.error} action={{ label: 'Retry', onPress: player.reload }} secondary={back} />;
  if (hearts <= 0 && session.results.length === 0 && session.phase === 'ready') {
    return (
      <Centered
        text="You're out of hearts. Practice any exercise to earn one back, or wait for a refill."
        action={{ label: 'Back', onPress: () => router.back() }}
      />
    );
  }
  if (!engine.ready || session.phase === 'loading' || player.loading || !player.chart) {
    return <Centered spinner text="Tuning up…" />;
  }

  const remaining = Math.ceil(selectTimeRemainingMs(session) / 1000);
  const highwayH = height - insets.top - insets.bottom - TOP_BAR - BOTTOM_BAR;
  const highwayW = width - insets.left - insets.right;
  const accuracy = session.live.judged ? Math.round((session.live.hits / session.live.judged) * 100) : null;
  const last = session.results[session.results.length - 1];

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.topBar}>
        <Pressable onPress={quit} hitSlop={12} accessibilityLabel="Leave lesson">
          <Text style={styles.close}>✕</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {exercise?.title} · {session.exerciseIndex + 1}/{session.exercises.length}
          {player.chart.speed && player.chart.speed !== 100 ? ` · ${player.chart.speed}% speed` : ''}
        </Text>
        <Hearts count={hearts} />
        <Text style={styles.timer}>⏱ {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</Text>
        {session.phase === 'playing' && (
          <Pressable
            onPress={() => {
              player.pause();
              dispatch(sessionActions.paused());
            }}
            hitSlop={12}
            accessibilityLabel="Pause"
          >
            <Text style={styles.close}>⏸</Text>
          </Pressable>
        )}
      </View>

      <TabHighway
        chart={player.chart}
        clock={player.clock}
        judgments={player.judgments}
        judgedAt={player.judgedAt}
        width={highwayW}
        height={highwayH}
        lookaheadMs={LOOKAHEAD_MS[settings.highwaySpeed]}
      />

      <View style={styles.bottomBar}>
        <Text style={styles.score}>{session.live.score.toLocaleString()}</Text>
        <Text style={styles.combo}>{session.live.combo > 1 ? `${session.live.combo}× combo` : ''}</Text>
        <Text style={type.small}>{accuracy !== null ? `${accuracy}% hit` : ' '}</Text>
      </View>

      {/* ---------------- overlays ---------------- */}
      {session.phase === 'ready' && (
        <Overlay>
          <Text style={type.title}>{exercise?.title}</Text>
          {exercise?.tip && <Text style={[type.body, styles.center]}>💡 {exercise.tip}</Text>}
          {engine.warnings[0] && <Text style={[type.small, styles.center, { color: colors.orange }]}>{engine.warnings[0]}</Text>}
          <Text style={[type.small, styles.center]}>A one-bar click count-in plays before the first note.</Text>
          <Button label="Start" onPress={start} />
        </Overlay>
      )}
      {session.phase === 'countIn' && (
        <Overlay>
          <Text style={type.title}>Next: {exercise?.title}</Text>
          {exercise?.tip && <Text style={[type.body, styles.center]}>💡 {exercise.tip}</Text>}
          <Button label="Go" onPress={start} />
        </Overlay>
      )}
      {session.phase === 'paused' && (
        <Overlay>
          <Text style={type.title}>Paused</Text>
          <View style={styles.buttons}>
            <Button label="Leave" variant="secondary" onPress={quit} />
            <Button
              label="Resume"
              onPress={() => {
                player.play();
                dispatch(sessionActions.playbackStarted());
              }}
            />
          </View>
        </Overlay>
      )}
      {session.phase === 'exerciseReview' && last && (
        <Overlay>
          <ReviewCard summary={last.summary} />
          {!last.summary.passed && <Text style={{ color: colors.heart }}>−1 ♥ · {hearts} left</Text>}
          <View style={styles.buttons}>
            {selectCanRetry(session) && hearts > 0 && (
              <Button
                label="Retry"
                variant="secondary"
                onPress={() => {
                  dispatch(sessionActions.exerciseRetried());
                  player.restart(0);
                }}
              />
            )}
            {hearts <= 0 ? (
              <Button label="Out of hearts · Finish" onPress={() => dispatch(sessionActions.sessionEndedEarly('hearts'))} />
            ) : (
              <Button
                label={session.endedReason ? 'Finish' : 'Next exercise'}
                onPress={() => {
                  dispatch(sessionActions.nextExercise());
                  // Rewind in case the next exercise reuses the same backing track.
                  if (!session.endedReason) player.restart(0);
                }}
              />
            )}
          </View>
        </Overlay>
      )}
      {session.phase === 'complete' && (
        <Overlay>
          <Text style={type.title}>{session.endedReason === 'hearts' ? 'Out of hearts' : 'Session complete'}</Text>
          {xp ? (
            <>
              {xp.lines.map((l) => (
                <Text key={l.label} style={type.body}>+{l.xp} XP · {l.label}</Text>
              ))}
              <Text style={[type.h2, { color: colors.gold }]}>+{xp.total} XP</Text>
            </>
          ) : (
            <Text style={type.body}>Saving…</Text>
          )}
          {levelUp && <Text style={[type.h2, { color: colors.gold }]}>👑 New crown! {skill?.title} level {levelUp.level}</Text>}
          <Button
            label="Done"
            onPress={() => {
              dispatch(progressionActions.levelUpAcknowledged());
              router.back();
            }}
          />
        </Overlay>
      )}
    </View>
  );
}

function ReviewCard({ summary }: { summary: GradeSummary }) {
  const tendency =
    summary.tendency === 'rushing'
      ? `You're rushing by ~${Math.round(-summary.meanOffsetMs)} ms. Relax into the beat.`
      : summary.tendency === 'dragging'
        ? `You're ~${Math.round(summary.meanOffsetMs)} ms behind. Anticipate a little.`
        : 'Right in the pocket.';
  return (
    <>
      <Text style={[type.title, { color: colors.gold }]}>
        {'★'.repeat(summary.stars)}
        <Text style={{ color: colors.border }}>{'★'.repeat(3 - summary.stars)}</Text>
        <Text style={{ color: colors.text }}>  {Math.round(summary.accuracy * 100)}%</Text>
      </Text>
      <Text style={type.body}>
        Perfect {summary.counts.perfect} · Great {summary.counts.great} · Good {summary.counts.good} · Missed{' '}
        {summary.counts.miss} · Wrong note {summary.counts.wrongPitch}
      </Text>
      <Text style={type.body}>{tendency}</Text>
    </>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.overlay}>
      <View style={styles.overlayCard}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { height: TOP_BAR, flexDirection: 'row', alignItems: 'center', gap: space(4), paddingHorizontal: space(4) },
  close: { color: colors.sub, fontSize: 20, fontWeight: '700' },
  topTitle: { flex: 1, color: colors.sub, fontSize: 15 },
  timer: { color: colors.sub, fontSize: 15, fontVariant: ['tabular-nums'] },
  bottomBar: { height: BOTTOM_BAR, flexDirection: 'row', alignItems: 'center', gap: space(4), paddingHorizontal: space(4) },
  score: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  combo: { color: colors.gold, fontSize: 16, fontWeight: '700', flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(14,17,23,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space(6),
    maxWidth: 560,
    width: '80%',
    alignItems: 'center',
    gap: space(3),
  },
  buttons: { flexDirection: 'row', gap: space(3), marginTop: space(2) },
  center: { textAlign: 'center' },
});
