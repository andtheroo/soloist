import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTuner } from '../audio/useTuner';
import { STANDARD_TUNING } from '../game/tuning';
import { LevelMeter } from './components';
import { colors, radius, space, type } from './theme';

const IN_TUNE_CENTS = 5;

/** Chromatic tuner that also tells beginners which open string they're closest to. */
export function TunerView({ active = true }: { active?: boolean }) {
  const { reading, level } = useTuner(active);
  const cents = reading ? Math.max(-50, Math.min(50, reading.centsFromString)) : 0;
  const inTune = reading && Math.abs(reading.centsFromString) <= IN_TUNE_CENTS;
  const farOff = reading && Math.abs(reading.centsFromString) > 50;
  const status = !reading
    ? 'Pluck one open string'
    : inTune
      ? 'In tune ✓'
      : farOff
        ? `Closer to ${reading.note} — keep turning`
        : reading.centsFromString < 0
          ? 'Too low — tighten the string'
          : 'Too high — loosen the string';
  const accent = inTune ? colors.accent : reading ? colors.orange : colors.muted;

  return (
    <View style={styles.root}>
      <View style={styles.strings}>
        {STANDARD_TUNING.map((s) => {
          const on = reading?.string.string === s.string;
          return (
            <View key={s.string} style={[styles.chip, on && { backgroundColor: accent, borderColor: accent }]}>
              <Text style={[styles.chipText, on && { color: colors.accentText }]}>{s.name}</Text>
              <Text style={[styles.chipSub, on && { color: colors.accentText }]}>{s.string}</Text>
            </View>
          );
        })}
      </View>

      <Text style={[styles.note, { color: accent }]}>{reading ? reading.string.name : '–'}</Text>
      <Text style={type.small}>
        {reading ? `${reading.hz.toFixed(1)} Hz · ${reading.centsFromString > 0 ? '+' : ''}${reading.centsFromString.toFixed(0)} cents` : ' '}
      </Text>

      <View style={styles.scale}>
        <View style={styles.centerTick} />
        <View style={[styles.inTuneZone, { width: `${(IN_TUNE_CENTS * 2) / 100 * 100}%` }]} />
        {reading && <View style={[styles.needle, { left: `${50 + cents}%`, backgroundColor: accent }]} />}
      </View>
      <View style={styles.scaleLabels}>
        <Text style={type.small}>♭ low</Text>
        <Text style={type.small}>high ♯</Text>
      </View>

      <Text style={[type.h2, { color: accent, marginTop: space(3) }]}>{status}</Text>
      {!reading && (
        <View style={{ width: '60%', marginTop: space(4) }}>
          <LevelMeter db={level} />
          <Text style={[type.small, { textAlign: 'center', marginTop: 4 }]}>mic level</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingVertical: space(4) },
  strings: { flexDirection: 'row', gap: space(2), marginBottom: space(6) },
  chip: {
    width: 44,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  chipText: { color: colors.text, fontWeight: '800', fontSize: 16 },
  chipSub: { color: colors.muted, fontSize: 10 },
  note: { fontSize: 96, fontWeight: '900', lineHeight: 104 },
  scale: {
    width: '90%',
    height: 36,
    marginTop: space(5),
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  centerTick: { position: 'absolute', left: '50%', width: 2, height: '100%', backgroundColor: colors.border },
  inTuneZone: { position: 'absolute', left: '45%', height: '100%', backgroundColor: 'rgba(79,217,139,0.18)' },
  needle: { position: 'absolute', width: 6, marginLeft: -3, height: '100%', borderRadius: 3 },
  scaleLabels: { width: '90%', flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
});
