import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { api, ensureStemsCached } from '../api/client';
import { CalibrationResult, estimateCalibration } from '../audio/calibration';
import { SoloistAudio } from '../audio/native';
import type { LatencyReport } from '../audio/native';
import { Button, Card } from './components';
import { colors, space, type } from './theme';

/**
 * Acoustic loopback calibration: the speaker plays 16 clicks, the mic hears them, and the
 * median residual between "when the engine thinks they were heard" and "when they were
 * scheduled" becomes this phone's latency offset.
 */
export function CalibrationView({
  report,
  currentOffsetMs,
  onSave,
  onSkip,
}: {
  report: LatencyReport | null;
  currentOffsetMs: number | null;
  onSave(offsetMs: number): void;
  onSkip?(): void;
}) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      SoloistAudio.pause();
      SoloistAudio.setCalibrationOffsetMs(currentOffsetMs ?? 0);
    },
    [currentOffsetMs],
  );

  const run = async () => {
    try {
      setStatus('running');
      setResult(null);
      const [chart, manifest] = await Promise.all([api.chart('calibration'), api.songManifest('calibration')]);
      const uris = await ensureStemsCached(manifest);
      SoloistAudio.setCalibrationOffsetMs(0); // measure the raw residual
      await SoloistAudio.loadSong(manifest.stems.map((s) => ({ id: s.id, uri: uris[s.id], gain: 1 })));
      SoloistAudio.setExpectedNotes([]);
      const detected: number[] = [];
      SoloistAudio.play();
      // Watchdog: if playback never reports the end (audio route change, stalled stream),
      // finish anyway with whatever was heard instead of listening forever.
      const deadline = Date.now() + chart.durationMs + 4000;
      const loop = () => {
        const snap = SoloistAudio.poll();
        for (const e of snap.events) detected.push(e.songMs);
        if (snap.ended || Date.now() > deadline) {
          SoloistAudio.pause();
          raf.current = null;
          SoloistAudio.setCalibrationOffsetMs(currentOffsetMs ?? 0); // restore until saved
          setResult(estimateCalibration(chart.notes.map((n) => n.timeMs), detected, 0));
          setStatus('done');
          return;
        }
        raf.current = requestAnimationFrame(loop);
      };
      raf.current = requestAnimationFrame(loop);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  };

  return (
    <View style={{ gap: space(4) }}>
      <Text style={type.body}>
        Unplug headphones, turn the volume up and stay quiet for 10 seconds. Soloist plays clicks through the speaker
        and listens for them to measure this phone’s exact audio delay.
      </Text>
      {report && (
        <Text style={type.small}>
          {report.audioApi} · {report.sampleRate} Hz · reported out {report.outputLatencyMs.toFixed(1)} ms / in{' '}
          {report.inputLatencyMs.toFixed(1)} ms{report.mmap ? ' · MMAP fast path' : ''}
          {currentOffsetMs !== null ? ` · saved offset ${currentOffsetMs.toFixed(1)} ms` : ''}
        </Text>
      )}
      {status === 'running' && <Text style={[type.h2, { color: colors.blue }]}>Listening… 🔊</Text>}
      {status === 'error' && <Text style={{ color: colors.red }}>{error}</Text>}
      {status === 'done' && result && (
        <Card>
          <Text style={[type.h2, { color: result.reliable ? colors.accent : colors.orange }]}>
            {result.reliable
              ? `Measured offset: ${result.offsetMs.toFixed(1)} ms (±${result.spreadMs.toFixed(1)})`
              : "Couldn't hear the clicks clearly."}
          </Text>
          <Text style={[type.small, { marginTop: 4 }]}>{result.samples} of 16 clicks heard</Text>
          {!result.reliable && (
            <Text style={[type.body, { marginTop: space(2) }]}>
              Unplug headphones, turn the volume up and try again in a quieter room. Or skip: lessons still work using
              your phone's own latency figures, and you can rerun this from Settings.
            </Text>
          )}
        </Card>
      )}
      <View style={{ flexDirection: 'row', gap: space(3), flexWrap: 'wrap' }}>
        {status !== 'running' && (
          <Button label={status === 'idle' ? 'Start latency check' : 'Run again'} onPress={run} variant={result?.reliable ? 'secondary' : 'primary'} />
        )}
        {status === 'done' && result?.reliable && <Button label="Save" onPress={() => onSave(result.offsetMs)} />}
        {onSkip && status !== 'running' && <Button label="Skip for now" variant="ghost" onPress={onSkip} />}
      </View>
    </View>
  );
}
