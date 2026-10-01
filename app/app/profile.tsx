import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { msUntilNextHeart } from '../src/game/hearts';
import { addDays, toDayKey } from '../src/game/streak';
import { levelFromXp } from '../src/game/xp';
import { useAppDispatch, useAppSelector } from '../src/store';
import { progressionActions, selectCrowns, selectRecentTiming } from '../src/store/progressionSlice';
import { Button, Card, Hearts, ProgressBar, SectionLabel, Stat } from '../src/ui/components';
import { colors, space, type } from '../src/ui/theme';

const FREEZE_COST_XP = 100;
// Single-series bar color, validated for the dark card surface (OKLCH L in 0.48–0.67, ≥3:1).
const BAR_COLOR = '#b88a0a';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function ProfileScreen() {
  const dispatch = useAppDispatch();
  const p = useAppSelector((s) => s.progression);
  const now = Date.now();
  const today = toDayKey(new Date(now));
  const lvl = levelFromXp(p.totalXp);
  const recent = selectRecentTiming(p);
  const lessonsDone = Object.keys(p.lessons).length;
  const heartWait = msUntilNextHeart(p.hearts, now);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space(4), paddingBottom: space(16) }}>
      <Card style={{ gap: space(3) }}>
        <Text style={type.title}>Level {lvl.level}</Text>
        <ProgressBar progress={lvl.progress} />
        <Text style={type.small}>
          {p.totalXp.toLocaleString()} XP total · {lvl.xpForNext - lvl.xpIntoLevel} XP to level {lvl.level + 1}
        </Text>
      </Card>

      <Card style={{ flexDirection: 'row', marginTop: space(3) }}>
        <Stat value={`🔥 ${p.streak.current}`} label="day streak" />
        <Stat value={`${p.streak.longest}`} label="longest" />
        <Stat value={`👑 ${selectCrowns(p)}`} label="crowns" />
        <Stat value={`${lessonsDone}`} label="lessons" />
      </Card>

      <SectionLabel>Last 7 days</SectionLabel>
      <XpChart xpByDay={p.xpByDay} goal={p.dailyGoalXp} today={today} />

      <SectionLabel>Timing</SectionLabel>
      <Card style={{ gap: space(1) }}>
        {recent ? (
          <>
            <Text style={type.h2}>{Math.round(recent.accuracy * 100)}% average accuracy</Text>
            <Text style={type.body}>
              {Math.abs(recent.meanOffsetMs) <= 12
                ? `You land on the beat (${recent.meanOffsetMs >= 0 ? '+' : ''}${recent.meanOffsetMs.toFixed(0)} ms on average).`
                : recent.meanOffsetMs < 0
                  ? `You tend to rush by about ${Math.round(-recent.meanOffsetMs)} ms. Try counting out loud.`
                  : `You tend to drag by about ${Math.round(recent.meanOffsetMs)} ms. Lean into the click.`}
            </Text>
            <Text style={type.small}>Based on your last {Math.min(10, p.history.length)} sessions.</Text>
          </>
        ) : (
          <Text style={type.body}>Play a lesson to see how your timing is trending.</Text>
        )}
      </Card>

      <SectionLabel>Hearts & streak freezes</SectionLabel>
      <Card style={{ gap: space(3) }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Hearts count={p.hearts.hearts} />
          <Text style={type.small}>{heartWait !== null ? `next heart in ${Math.ceil(heartWait / 60000)} min` : 'full'}</Text>
        </View>
        <Text style={type.body}>
          Streak freezes protect your streak on a day you can't play. You have {p.streak.freezes} of 2.
        </Text>
        <Button
          label={`Buy a freeze · ${FREEZE_COST_XP} XP`}
          variant="secondary"
          disabled={p.streak.freezes >= 2 || p.totalXp < FREEZE_COST_XP}
          onPress={() => dispatch(progressionActions.streakFreezePurchased({ costXp: FREEZE_COST_XP }))}
        />
      </Card>

      <SectionLabel>Recent sessions</SectionLabel>
      {p.history.length === 0 && <Text style={type.body}>Nothing yet. Your first session is three minutes away.</Text>}
      {p.history
        .slice(-8)
        .reverse()
        .map((h) => (
          <View key={h.at} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space(2), borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={type.body}>
              {h.kind === 'practice' ? '🔁 Practice' : '🎸 Lesson'} · {h.lessonId ?? h.chartId}
            </Text>
            <Text style={type.body}>
              {Math.round(h.accuracy * 100)}% · +{h.xp} XP
            </Text>
          </View>
        ))}
    </ScrollView>
  );
}

/** Single-series bar chart: XP per day for the last 7 days, with the daily goal as a reference line. */
function XpChart({ xpByDay, goal, today }: { xpByDay: Record<string, number>; goal: number; today: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)), [today]);
  const values = days.map((d) => xpByDay[d] ?? 0);
  const max = Math.max(goal * 1.2, ...values, 1);
  const H = 120;
  const sel = selected ?? today;
  const selValue = xpByDay[sel] ?? 0;

  return (
    <Card>
      <Text style={type.body} accessibilityLiveRegion="polite">
        {sel === today ? 'Today' : weekday(sel)}: <Text style={{ color: colors.text, fontWeight: '800' }}>{selValue} XP</Text>
        {selValue >= goal ? ' · goal met ✓' : ''}
      </Text>
      <View style={{ height: H, marginTop: space(3), flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
        {/* goal reference line: recessive, labelled */}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: (goal / max) * H, height: 1, backgroundColor: colors.border }} />
        <Text style={[type.small, { position: 'absolute', right: 0, bottom: (goal / max) * H + 2 }]}>goal {goal}</Text>
        {days.map((d, i) => {
          const h = Math.max(values[i] > 0 ? 4 : 0, (values[i] / max) * H);
          return (
            <Pressable
              key={d}
              onPress={() => setSelected(d)}
              accessibilityLabel={`${weekday(d)} ${values[i]} XP`}
              style={{ flex: 1, height: H, justifyContent: 'flex-end', alignItems: 'center' }}
            >
              <View
                style={{
                  width: '58%',
                  height: h,
                  backgroundColor: BAR_COLOR,
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                  opacity: d === sel ? 1 : 0.75,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 2, marginTop: 6 }}>
        {days.map((d) => (
          <Text key={d} style={[type.small, { flex: 1, textAlign: 'center', color: d === sel ? colors.text : colors.muted }]}>
            {d === today ? 'Today' : weekday(d).slice(0, 3)}
          </Text>
        ))}
      </View>
    </Card>
  );
}

function weekday(dayKey: string) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return DAY_LABELS[new Date(y, m - 1, d).getDay()];
}
