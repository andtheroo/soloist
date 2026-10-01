import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { checkServer, detectedServerUrl, loadCourse, setServerUrlOverride } from '../api/client';
import { useAppDispatch, useAppSelector } from '../store';
import { settingsActions } from '../store/settingsSlice';
import { Button } from './components';
import { colors, radius, space, type } from './theme';

/**
 * Finds and tests the lesson server. Dev builds auto-detect the laptop running
 * `expo start`; standalone APKs need the address the server prints on startup.
 */
export function ServerSetup({ onConnected, autoTest = true }: { onConnected?(): void; autoTest?: boolean }) {
  const dispatch = useAppDispatch();
  const saved = useAppSelector((s) => s.settings.serverUrl);
  const [text, setText] = useState(saved ?? '');
  const [status, setStatus] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'fail'; msg?: string }>({ kind: 'idle' });
  const effective = saved ?? detectedServerUrl();

  const test = async (url: string) => {
    setStatus({ kind: 'testing' });
    const r = await checkServer(url);
    if (r.ok) {
      setStatus({ kind: 'ok', msg: `Connected in ${r.ms} ms` });
      loadCourse(true).catch(() => {});
      onConnected?.();
    } else {
      setStatus({ kind: 'fail', msg: r.error });
    }
  };

  useEffect(() => {
    if (autoTest) void test(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    const v = text.trim();
    const normalised = v ? (/^https?:\/\//.test(v) ? v : `http://${v}`).replace(/\/+$/, '') : null;
    dispatch(settingsActions.serverUrlSet(normalised));
    setServerUrlOverride(normalised);
    void test(normalised ?? detectedServerUrl());
  };

  return (
    <View style={{ gap: space(3) }}>
      <Text style={type.small}>Using: {effective}{saved ? '' : ' (auto-detected)'}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="e.g. 192.168.1.23:4000"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={{
          color: colors.text,
          backgroundColor: colors.card,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          paddingHorizontal: space(3),
          paddingVertical: space(3),
          fontSize: 16,
        }}
      />
      <View style={{ flexDirection: 'row', gap: space(3) }}>
        <Button label="Save & test" onPress={save} loading={status.kind === 'testing'} />
        <Button label="Test" variant="secondary" onPress={() => test(effective)} />
      </View>
      {status.kind === 'ok' && <Text style={{ color: colors.accent }}>✓ {status.msg}</Text>}
      {status.kind === 'fail' && (
        <Text style={{ color: colors.red }}>
          ✗ {status.msg}. Check the server is running (`npm start` in /server), the phone is on the same Wi-Fi, and
          Windows Firewall allows Node.js on private networks.
        </Text>
      )}
    </View>
  );
}
