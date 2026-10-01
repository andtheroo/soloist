import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { loadCourse } from '../../src/api/client';
import { lessonSpeedForLevel, skillStatus } from '../../src/game/skillTree';
import { useAppSelector } from '../../src/store';
import type { Course } from '../../src/types/chart';
import { Button, Card, Centered, ProgressBar, SectionLabel } from '../../src/ui/components';
import { colors, space, type } from '../../src/ui/theme';

export default function SkillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = useAppSelector((s) => s.progression);
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCourse().then(setCourse).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <Centered text={error} action={{ label: 'Back', onPress: () => router.back() }} />;
  const skill = course?.skills.find((s) => s.id === id);
  if (!course || !skill) return <Centered spinner text="Loading skill…" />;

  const prog = p.skills[skill.id];
  const level = prog?.level ?? 0;
  const status = skillStatus(skill, p.skills);
  const passed = new Set(prog?.lessonsPassedAtLevel ?? []);
  const lessons = skill.lessonIds.map((lid) => course.lessons.find((l) => l.id === lid)).filter(Boolean);
  const locked = status === 'locked';
  const missing = skill.prerequisites
    .filter((pre) => (p.skills[pre]?.level ?? 0) < 1)
    .map((pre) => course.skills.find((s) => s.id === pre)?.title ?? pre);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space(4), paddingBottom: space(16) }}>
      <Stack.Screen options={{ title: skill.title }} />
      <Text style={type.title}>{skill.icon} {skill.title}</Text>
      {skill.description && <Text style={[type.body, { marginTop: space(2) }]}>{skill.description}</Text>}

      <Card style={{ marginTop: space(4), gap: space(2) }}>
        <Text style={type.h2}>{level >= skill.maxLevel ? 'Mastered 👑' : `Crown ${level + 1} of ${skill.maxLevel}`}</Text>
        <ProgressBar progress={level >= skill.maxLevel ? 1 : passed.size / skill.lessonIds.length} color={colors.gold} />
        <Text style={type.small}>
          {level >= skill.maxLevel
            ? 'Keep it sharp with practice.'
            : `Pass every lesson to earn the next crown. Lessons play at ${lessonSpeedForLevel(level)}% speed at this level.`}
        </Text>
      </Card>

      {locked && (
        <Card style={{ marginTop: space(4), borderWidth: 1, borderColor: colors.border }}>
          <Text style={type.body}>🔒 Earn a crown in {missing.join(' and ')} to unlock this skill.</Text>
        </Card>
      )}

      <SectionLabel>Lessons</SectionLabel>
      {lessons.map((lesson) => {
        const l = lesson!;
        const rec = p.lessons[l.id];
        return (
          <Card key={l.id} style={{ marginBottom: space(3), gap: space(3) }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={type.h2}>{l.title}</Text>
                <Text style={type.small}>
                  {l.exercises.length} exercise{l.exercises.length > 1 ? 's' : ''} · 3 min
                  {rec ? ` · best ${'★'.repeat(rec.bestStars)}${'☆'.repeat(3 - rec.bestStars)}` : ''}
                </Text>
              </View>
              {passed.has(l.id) && <Text style={{ color: colors.accent, fontWeight: '800' }}>✓</Text>}
            </View>
            <Button
              label={p.hearts.hearts > 0 ? (passed.has(l.id) ? 'Play again' : 'Start lesson') : 'Out of hearts'}
              disabled={locked || p.hearts.hearts <= 0}
              onPress={() => router.push({ pathname: '/lesson/[id]', params: { id: l.id, skillId: skill.id } })}
            />
            <View style={{ gap: space(2) }}>
              {l.exercises.map((ex) => (
                <View key={ex.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[type.body, { flex: 1 }]}>{ex.title}</Text>
                  <Button
                    label="Practice"
                    variant="ghost"
                    disabled={locked}
                    style={{ paddingVertical: 8, minHeight: 36 }}
                    onPress={() =>
                      router.push({ pathname: '/practice/[chartId]', params: { chartId: ex.chartId, songId: ex.songId, skillId: skill.id } })
                    }
                  />
                </View>
              ))}
            </View>
          </Card>
        );
      })}
      {p.hearts.hearts <= 0 && (
        <Text style={[type.body, { marginTop: space(2) }]}>
          ♥ Out of hearts. Finish a practice loop to earn one back, or wait for the next refill.
        </Text>
      )}
    </ScrollView>
  );
}
