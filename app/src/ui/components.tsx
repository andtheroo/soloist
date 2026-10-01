import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { MAX_HEARTS } from '../game/hearts';
import { colors, radius, space, type } from './theme';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress(): void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const bg = { primary: colors.accent, secondary: colors.border, ghost: 'transparent', danger: colors.red }[variant];
  const fg = variant === 'primary' ? colors.accentText : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
        variant === 'ghost' && styles.ghost,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={[type.label, { marginTop: space(6), marginBottom: space(2) }]}>{children}</Text>;
}

/** Pick-one control (daily goal, grading mode, speed…). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange(v: T): void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityState={{ selected: on }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && { color: colors.accentText }]}>{o.label}</Text>
            {o.hint ? <Text style={[styles.segmentHint, on && { color: colors.accentText }]}>{o.hint}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function ProgressBar({ progress, color = colors.accent, height = 8 }: { progress: number; color?: string; height?: number }) {
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      <View style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`, height, borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

export function Hearts({ count, compact }: { count: number; compact?: boolean }) {
  if (compact) return <Text style={{ color: colors.heart, fontWeight: '800', fontSize: 16 }}>♥ {count}</Text>;
  return (
    <Text accessibilityLabel={`${count} of ${MAX_HEARTS} hearts`} style={{ fontSize: 16, letterSpacing: 2 }}>
      {Array.from({ length: MAX_HEARTS }, (_, i) => (
        <Text key={i} style={{ color: i < count ? colors.heart : colors.border }}>♥</Text>
      ))}
    </Text>
  );
}

export function Stat({ value, label, color = colors.text }: { value: string; label: string; color?: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ color, fontSize: 18, fontWeight: '800' }}>{value}</Text>
      <Text style={[type.small, { marginTop: 2 }]}>{label}</Text>
    </View>
  );
}

export function Centered({ text, spinner, action }: { text: string; spinner?: boolean; action?: { label: string; onPress(): void } }) {
  return (
    <View style={styles.centered}>
      {spinner && <ActivityIndicator color={colors.text} size="large" />}
      <Text style={[type.body, { marginTop: space(3), textAlign: 'center' }]}>{text}</Text>
      {action && <Button label={action.label} onPress={action.onPress} style={{ marginTop: space(4) }} />}
    </View>
  );
}

/** dB meter for "is my mic hearing me?" (-70 dB = empty, -10 dB = full). */
export function LevelMeter({ db }: { db: number }) {
  const p = Math.max(0, Math.min(1, (db + 70) / 60));
  return <ProgressBar progress={p} color={p > 0.85 ? colors.orange : colors.accent} height={6} />;
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  ghost: { borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 16, fontWeight: '800' },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(4) },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  segment: {
    flexGrow: 1,
    minWidth: 70,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  segmentOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { color: colors.text, fontWeight: '700' },
  segmentHint: { color: colors.muted, fontSize: 11, marginTop: 2 },
  track: { backgroundColor: colors.border, overflow: 'hidden', width: '100%' },
  centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: space(6) },
});
