import { Redirect, router, Stack } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { loadCourse } from '../src/api/client';
import { msUntilNextHeart } from '../src/game/hearts';
import { computeTiers, recommendNext, skillStatus, SkillStatus } from '../src/game/skillTree';
import { streakStatus, toDayKey } from '../src/game/streak';
import { levelFromXp } from '../src/game/xp';
import { useAppSelector } from '../src/store';
import { selectXpToday } from '../src/store/progressionSlice';
import type { Course, SkillNodeDef } from '../src/types/chart';
import { Button, Card, Hearts, ProgressBar } from '../src/ui/components';
import { colors, radius, space, type } from '../src/ui/theme';

const NODE_STYLE: Record<SkillStatus, { bg: string; label: string }> = {
  locked: { bg: colors.locked, label: 'Locked' },
  available: { bg: '#2a6df4', label: 'Start' },
  'in-progress': { bg: '#2f9e64', label: 'Continue' },
  mastered: { bg: '#b8860b', label: 'Mastered' },
};

export default function HomeScreen() {
  const onboarded = useAppSelector((s) => s.settings.onboardingComplete);
  const p = useAppSelector((s) => s.progression);
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = Date.now();
  const today = toDayKey(new Date(now));

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      setCourse(await loadCourse(force));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (onboarded) void refresh(false);
  }, [onboarded, refresh]);

  const skills = course?.skills ?? [];
  const tiers = useMemo(() => computeTiers(skills), [skills]);
  const rows = useMemo(() => {
    const byTier: SkillNodeDef[][] = [];
    for (const s of skills) (byTier[tiers[s.id]] ??= []).push(s);
    return byTier;
  }, [skills, tiers]);
  const next = useMemo(() => recommendNext(skills, p.skills), [skills, p.skills]);

  if (!onboarded) return <Redirect href="/onboarding" />;

  const lvl = levelFromXp(p.totalXp);
  const xpToday = selectXpToday(p, today);
  const sStatus = streakStatus(p.streak, today);
  const heartWait = msUntilNextHeart(p.hearts, now);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: space(4) }}>
              <HeaderLink label="🎚" hint="Tuner" onPress={() => router.push('/tuner')} />
              <HeaderLink label="📈" hint="Progress" onPress={() => router.push('/profile')} />
              <HeaderLink label="⚙️" hint="Settings" onPress={() => router.push('/settings')} />
            </View>
          ),
        }}
      />
      <ScrollView
        style={styles.root}
        contentContainerStyle={{ padding: space(4), paddingBottom: space(16) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => refresh(true)} tintColor={colors.text} />}
      >
        <Card style={{ gap: space(3) }}>
          <View style={styles.statsRow}>
            <View>
              <Text style={styles.big}>🔥 {p.streak.current}</Text>
              <Text style={type.small}>{sStatus === 'at-risk' ? 'Play today to keep it!' : sStatus === 'done-today' ? 'Streak safe today' : 'day streak'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Hearts count={p.hearts.hearts} />
              <Text style={type.small}>{heartWait !== null ? `next ♥ in ${Math.ceil(heartWait / 60000)} min` : 'hearts full'}</Text>
            </View>
          </View>
          <View>
            <View style={styles.rowBetween}>
              <Text style={type.small}>Daily goal</Text>
              <Text style={type.small}>{Math.min(xpToday, p.dailyGoalXp)} / {p.dailyGoalXp} XP</Text>
            </View>
            <ProgressBar progress={xpToday / p.dailyGoalXp} color={colors.gold} />
          </View>
          <View>
            <View style={styles.rowBetween}>
              <Text style={type.small}>Level {lvl.level}</Text>
              <Text style={type.small}>{lvl.xpIntoLevel} / {lvl.xpForNext} XP</Text>
            </View>
            <ProgressBar progress={lvl.progress} />
          </View>
        </Card>

        {error && (
          <Card style={{ marginTop: space(4), borderColor: colors.red, borderWidth: 1, gap: space(3) }}>
            <Text style={[type.body, { color: colors.text }]}>{error}</Text>
            <View style={{ flexDirection: 'row', gap: space(3) }}>
              <Button label="Retry" onPress={() => refresh(true)} />
              <Button label="Server settings" variant="secondary" onPress={() => router.push('/settings')} />
            </View>
          </Card>
        )}

        {next && (
          <Button
            label={p.hearts.hearts > 0 ? 'Continue · 3-minute session' : 'Out of hearts · Practice to earn one'}
            style={{ marginTop: space(4) }}
            onPress={() =>
              p.hearts.hearts > 0
                ? router.push({ pathname: '/lesson/[id]', params: { id: next.lessonId, skillId: next.skillId } })
                : router.push({ pathname: '/skill/[id]', params: { id: next.skillId } })
            }
          />
        )}

        {rows.map((row, tier) => (
          <View key={`tier-${tier}`}>
            {tier > 0 && <View style={styles.connector} />}
            <View style={styles.tier}>
              {row.map((s) => {
                const status = skillStatus(s, p.skills);
                const prog = p.skills[s.id];
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${s.title}, ${NODE_STYLE[status].label}`}
                    onPress={() => router.push({ pathname: '/skill/[id]', params: { id: s.id } })}
                    style={({ pressed }) => [
                      styles.node,
                      { backgroundColor: NODE_STYLE[status].bg, opacity: status === 'locked' ? 0.55 : pressed ? 0.8 : 1 },
                    ]}
                  >
                    <Text style={styles.nodeIcon}>{status === 'locked' ? '🔒' : s.icon ?? '🎸'}</Text>
                    <Text style={styles.nodeTitle} numberOfLines={2}>{s.title}</Text>
                    <Text style={styles.crowns}>
                      {prog?.level ? `${'👑'.repeat(prog.level)}` : NODE_STYLE[status].label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function HeaderLink({ label, hint, onPress }: { label: string; hint: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={hint} hitSlop={10} onPress={onPress}>
      <Text style={{ fontSize: 20 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  big: { color: colors.text, fontSize: 24, fontWeight: '800' },
  tier: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: space(3), marginTop: space(2) },
  connector: { alignSelf: 'center', width: 3, height: space(5), backgroundColor: colors.border, borderRadius: 2, marginTop: space(2) },
  node: {
    width: 92,
    height: 92,
    borderRadius: radius.xl * 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  nodeIcon: { fontSize: 24 },
  nodeTitle: { color: colors.text, fontWeight: '800', fontSize: 11, textAlign: 'center', marginTop: 2 },
  crowns: { color: colors.text, fontSize: 10, marginTop: 2 },
});
