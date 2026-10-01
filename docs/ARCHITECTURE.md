# Soloist — Audio & Sync Architecture

## 1. The core idea

Two separate latency problems get mixed up all the time. The design treats them separately:

| Problem | What it affects | How Soloist handles it |
|---|---|---|
| **Grading accuracy**: when did the player *actually* play, relative to what they heard? | Fairness. A late judgment that is really the phone's fault makes players quit. | Every mic sample is mapped to the song timeline through **measured hardware timestamps** (`ClockMap`), plus a one-time per-device calibration. Accuracy does **not** depend on how big the latency is. |
| **Feedback latency**: how quickly does the note change colour? | Feel. | Low-latency I/O (Oboe/AAudio MMAP, AVAudioEngine RT nodes), native DSP, one JSI call per frame, and Skia drawing on the UI thread. |

The JS thread is never on the timing-critical path. A GC pause can delay *feedback* but can't change a *judgment*, because onset times are stamped in C++ against the audio clock.

## 2. Threads

```
┌─ RT audio thread (Oboe callback / Core Audio render) ── no locks · no alloc · no syscalls ─┐
│  Mixer::render()        stems (int16, pre-resampled) → device, publishes SongAnchor         │
│  onInputFrames()        mic → SpscRingBuffer, each sample tagged with its device frame #    │
│  (iOS) publishes in/out hardware timestamps every callback                                 │
└──────────────────────────────┬──────────────────────────────────────────────────────────────┘
                               │ lock-free (SPSC ring, seqlocks, atomics)
┌─ Analysis thread (high priority, not RT) ──────────────────────────────────────────────────┐
│  OnsetDetector   128-sample hops (2.7 ms) → onset frame (sub-hop refined)                  │
│  ClockMap        onset frame → song ms (latency-compensated, calibrated)                   │
│  PitchDetector   YIN once per onset + target-informed verification of expected notes       │
│  (Android) polls AAudio getTimestamp(CLOCK_MONOTONIC) every 10 ms                          │
└──────────────────────────────┬──────────────────────────────────────────────────────────────┘
                               │ SpscQueue<DetectedNote>, drained by pollState()
┌─ JS thread ─────────────────────────────────────────────────────────────────────────────────┐
│  AudioSyncController (rAF): ONE sync JSI call/frame → clock SharedValue, GradingEngine,     │
│  judgment SharedValues, Redux (HUD + session time budget, batched every 500 ms)            │
└──────────────────────────────┬──────────────────────────────────────────────────────────────┘
                               │ Reanimated shared values
┌─ UI thread ─────────────────────────────────────────────────────────────────────────────────┐
│  useFrameCallback: extrapolate song position to the frame's *display* time, slew jitter    │
│  useDerivedValue → createPicture: Skia draws beats, strings, notes, tails, hit bursts      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Clock math (`cpp/ClockMap.h`)

Three published facts, each a lock-free seqlock:

* **Output timestamp** `(outFrame_o, t_o)`: output frame `outFrame_o` reached the DAC at host time `t_o`.
* **Input timestamp** `(inFrame_i, t_i)`: input frame `inFrame_i` left the ADC at host time `t_i`.
* **Song anchor** `(outFrame_a, songFrame_a, playing)`: published by the mixer each callback.

For a mic onset at input frame `I`:

```
t        = t_i + (I − inFrame_i) / inRate            // when the sound hit the mic
F        = outFrame_o + (t − t_o) · outRate          // which output frame was playing then
songMs   = (songFrame_a + (F − outFrame_a)) / outRate · 1000 − calibrationMs
```

The UI uses the same map: `pollState()` returns `(songMs audible now, hostNowMs)`. The Skia worklet
extrapolates `songMs + (frameTimestamp + frameDuration − hostNowMs)`, so it draws where the song
*will be* when the frame is on screen.

**Jumps (seeks, practice-loop wraps, pause/resume).** Audio already queued in the device buffer
still belongs to the song position *before* the jump. The anchor therefore carries the previous anchor
too. Frames older than the current anchor's output frame are mapped with the previous one, so onsets
played right up to a loop point are still timed exactly (`tests/feature_test.cpp` checks this).

**Timebase.** Native host time is `CLOCK_MONOTONIC` (Android) or `mach_absolute_time` (iOS). These are
the same clocks as Choreographer/CADisplayLink frame timestamps. Note that `std::chrono::steady_clock`
on Apple is `mach_continuous_time`, which drifts from `mach_absolute_time` after the device sleeps, so
`HostClock.h` avoids it. The worklet also learns a min-filtered offset and applies it if the two clocks
ever disagree by more than 250 ms.

## 4. Android: Oboe / AAudio (`android/src/main/cpp/OboeEngine.cpp`)

* The output stream is `LowLatency + Exclusive` (MMAP when the device supports it), Float, at the **device-native rate** (forcing 44.1 kHz knocks you off the fast path). The buffer is 2 bursts, and `LatencyTuner` only grows it after an underrun.
* The input stream has no callback. The output callback drains it with non-blocking `read(…, timeout 0)`. That gives one RT thread and no cross-stream drift, the same pattern as `oboe::FullDuplexStream`.
* Input preset: `VoicePerformance` on API 29+ (built for live monitoring, no AGC/NS), otherwise `VoiceRecognition`.
* Device changes (headphones, USB, BT) are handled in `onErrorAfterClose` → reopen → `deviceGeneration++`. JS then reloads stems if the rate changed.
* Timestamps: `getTimestamp(CLOCK_MONOTONIC)` from the analysis thread (never the callback). If that fails, a callback-time estimate is used.

### About "sub-10 ms on Android"

| Stage | MMAP-capable device (e.g. Pixel, recent flagships) | Legacy path |
|---|---|---|
| Output (2 × 96–192-frame bursts + codec) | **~5–10 ms** | 20–40 ms |
| Input | ~5–10 ms | 15–40 ms |
| Round trip | ~10–20 ms | 40–100+ ms |
| Bluetooth A2DP | +100–300 ms | same |

Sub-10 ms **output** latency is achievable on MMAP devices with this configuration. Sub-10 ms **round trip**
is not something any app can guarantee across Android hardware. Soloist is designed so it doesn't need to:
grading accuracy comes from timestamps, and `getLatencyReport()` exposes `mmap / exclusive / audioApi /
bluetoothOutput` so the UI can warn the player.

## 5. iOS: AVAudioEngine (`ios/SoloistAudioEngine.mm`)

* `AVAudioSourceNode` renders the **same C++ Mixer** and `AVAudioSinkNode` feeds the same analyzer. Both run on Core Audio's RT thread. `installTap` isn't used because it delivers ~100 ms buffers on a non-RT thread.
* Session: `playAndRecord` + mode `.measurement` (no AGC/NS/EQ, which pitch detection needs), preferred IO buffer 128 frames, 48 kHz. Voice processing is deliberately off because its echo canceller would cancel the guitar too.
* Timestamps: render `mHostTime + outputLatency`, sink `mHostTime − inputLatency`. Calibration absorbs any residual.
* Interruptions, route changes, `AVAudioEngineConfigurationChange` and media-server resets all trigger a graph rebuild and `deviceGeneration++`.

## 6. Detection and grading

**Onsets:** pre-emphasis high-pass → per-hop dB → rise over the min of the last 3 hops **and** over the mean
power of the last ~32 ms. The second test rejects the deep dips and small peaks of beating between decaying
strings, which otherwise fire false onsets in strummed chords. Then: asymmetric noise-floor gate → 45 ms
refractory → refined to the first sample above 30 % of the attack peak.

**Pitch:** blind YIN (`PitchDetector`) runs on a window that starts 8 ms after the attack. Blind pitch fails when
earlier notes are still ringing (55 % correct in the overlap stress test). So there is a second path,
**target-informed verification**: the chart's expected notes are pushed to native code (`setExpectedNotes`). For
each candidate near the onset, the engine asks *"did energy periodic at this note's period appear at this onset?"*

* `rise`: periodic power after the onset minus before. This cancels strings that were already ringing.
* `purity`: it must be more periodic at τ than at τ/2 (rejects the octave above) and at 2τ (rejects the octave below).
* `local max`: it must be more periodic at τ than at the semitones either side. This matters for high, near-sinusoidal notes.

**Chords (2+ notes at once)** each carry only a fraction of the energy, so per-note thresholds fail. The engine
scores the **whole chord shape** (the mean periodicity over all its notes) and compares it with the same shape
transposed a semitone up and down. The played chord must fit clearly better than both, and its periodic energy
must have risen at the onset. Strummed chords (3+ notes) wait ~27 ms for all strings to sound, then use a
window twice as long.

**Tuner:** with the tuner screen open, YIN runs on the newest window every ~32 ms with median-of-3 smoothing,
published in the same `pollState()` header.

**Practice loops:** the mixer wraps at the loop end (at a callback boundary). JS scores the body of the pass
immediately, waits ~280 ms for detections still in flight for the last notes, scores those, and re-arms
(`AudioSyncController`, tested in `src/audio/__tests__`).

**Grader (`src/grading/GradingEngine.ts`):**

* Chords are grouped within 15 ms, and one strum judges the whole group.
* Each detection picks the pending group with the lowest cost: `|Δt|/goodWindow + pitchPenalty`.
* Tiers (Standard): Perfect ±25, Great ±50, Good ±90, Miss ±140 ms. Relaxed is ±35/70/120/180 and is also used on
  level-0 skills. Strict is ±18/35/70/120.
* Pitch is correct if verified natively *or* blind pitch is within ±50 ¢. Octave errors are capped at Great. Unpitched or low-confidence onsets are capped at Good and never penalised, because a noisy room shouldn't punish the player.
* A confident wrong note within the Good window gives `WrongPitch` and breaks the combo.
* The miss sweep lags by `miss + detectionLatency` so late-arriving events can still claim their note.
* The summary reports weighted accuracy, a combo multiplier (×1–×4), stars, and **rushing/dragging** feedback from the mean signed offset.

## 7. Feedback-latency budget (onset → note turns gold)

| Stage | ms |
|---|---|
| Mic input latency (MMAP) | 5–10 |
| Onset hop + analysis poll | ≤ 4 |
| Pitch window (skip 8 + 2·τmax ≈ 29 for guitar; strummed chords ≈ 90) | ~37 |
| JS pump (next rAF) | ≤ 17 |
| UI worklet + display pipeline | 17–33 |
| **Total** | **~80–100** |

That is well inside what reads as "instant" for visual feedback. Grading *precision* is independent of it:
0.1 ms max onset error measured on synthetic input. **Next step:** emit an onset-only event immediately so the
timing flash appears ~40 ms sooner, with pitch confirmed afterwards.

## 8. Verification done in this repo

| Suite | What it proves | Result |
|---|---|---|
| `cpp/tests/core_test.cpp` (20 seeds) | Overlapping sustained plucks + 23/11 ms simulated latency; 4 wrong-note distractors per note | onset recall 100 %, timing error ≤ 0.21 ms; pitch: blind YIN 55 % → with verification **99.2 %**; false accepts **0.30 %** |
| `cpp/tests/feature_test.cpp` | A–B loop wraps, ended flag, clock mapping across a jump and a pause, tuner accuracy and release | all pass (tuner within 0.1 ¢ of a 7 ¢-sharp A2) |
| `cpp/tests/run_e2e.sh` | All 25 generated guide tracks (24 kHz, resampled) through the engine as "mic"; plus each chart transposed +1 and −2 semitones as a wrong-note control | **494/494** onsets within 0.3 ms, **493/494** pitch-verified (incl. 6-string chords); false accepts on transposed charts: 0/494 (+1 st), 3/494 (−2 st) |
| `server/test/api.test.js` | Course integrity, speed variants, chord timestamps, Range/ETag, path traversal, XP re-check | 7/7 |
| `app` logic tests | Grader, loop-pass scoring, game rules (XP, streak, hearts, placement, tuner), store + thunks, snapshot decoding | 43/43 |
| Type check | Every screen and module, `strict` + no unused locals, against API stubs checked by hand against the Expo SDK 54, Skia 2.2.12 and Reanimated 4.1.1 sources | clean |
| Android C++ | Compiled (`-fsyntax-only`) against the real Oboe headers | clean |

Not verifiable in this environment: a full Gradle/Xcode build and on-device audio. The first build on your
machine is the real integration test (see RUNNING.md → Troubleshooting).

## 9. Known gaps / roadmap

1. **Legato** (hammer-ons, pull-offs, slides) produces no energy onset. Add pitch-change onsets.
2. **Speaker bleed:** without headphones the backing track reaches the mic. We know the exact output signal, so a reference-gated onset suppressor (a light AEC) is the natural next step.
3. **Slow-down of arbitrary audio** (real recordings) needs time-stretching (Signalsmith Stretch / Rubber Band) inside `Mixer`. Today's slow-down works because the server re-renders synthesized stems at 50–100 % tempo.
4. **Compressed stems:** decode AAC/Opus via AMediaCodec / AVAudioFile into `DecodedAudio`, and stream long songs from disk.
5. **Skia allocations:** reuse `SkRect`/`SkRRect` objects in the worklet to cut per-frame JSI allocations.
6. **Server authority:** streak and XP ledgers on the server (the mock already recomputes XP and flags mismatches).
7. **Offline mode:** bundle a starter pack of lessons and stems in the app so it works without the server.
