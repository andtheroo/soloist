# Soloist

A Duolingo-style guitar trainer. Three-minute sessions over a scrolling tab highway. Soloist listens through the
microphone and grades every note for timing (to the millisecond) and pitch, with a skill tree, XP, streaks, hearts,
practice loops and a built-in tuner.

**→ To run it on your phone, follow [RUNNING.md](RUNNING.md).**

```
soloist/
├── RUNNING.md                         step-by-step: Windows PC + Android phone
├── docs/ARCHITECTURE.md               audio threads, clock math, detection, latency budget, test results
├── server/                            lesson server (Node, zero dependencies)
│   ├── src/content.js                 the course: 8 skills · 24 lessons · 25 songs (original + public-domain)
│   ├── src/index.js                   REST API, Range/ETag audio, lazy 50–100 % speed variants, XP re-check
│   └── test/api.test.js               node --test
└── app/                               Expo SDK 54 app (React Native 0.81, new architecture)
    ├── app/                           screens (expo-router)
    │   ├── onboarding.tsx             experience placement, goal, server, mic, tuner, latency check
    │   ├── index.tsx                  home: streak, hearts, goals, skill tree
    │   ├── skill/[id].tsx             lessons + practice entry points
    │   ├── lesson/[id].tsx            the 3-minute session (landscape)
    │   ├── practice/[chartId].tsx     A–B loops, slow-down, stem mutes, per-pass scoring
    │   ├── tuner.tsx · profile.tsx · settings.tsx · calibrate.tsx
    ├── src/
    │   ├── render/TabHighway.tsx      Skia + Reanimated rendering loop (UI thread)
    │   ├── grading/GradingEngine.ts   timing tiers, pitch, chords, combo, loop passes
    │   ├── audio/AudioSyncController.ts  one JSI poll per frame → clock, grader, loop scoring
    │   ├── audio/useExercisePlayer.ts    loads chart + stems, transport, live mix, loops
    │   ├── store/                     progression (XP, streak, hearts, crowns, history), session, settings
    │   ├── game/                      pure rules: xp, streak, hearts, skill tree, tuning
    │   ├── api/client.ts              server discovery, content-addressed audio cache
    │   └── ui/                        components, tuner, calibration, server setup
    └── modules/soloist-audio/         custom Expo native module
        ├── cpp/                       shared C++17 core: mixer + loops, clock map, onset, YIN,
        │                              note & chord verification, tuner, tests
        ├── android/                   Oboe/AAudio engine, JNI, Kotlin module, CMake + Prefab
        └── ios/                       AVAudioEngine source/sink nodes, ObjC++ bridge, Swift module
```

## Quick commands

```bash
cd server && npm start                     # lesson server (prints the address for your phone)
cd app && npm install && npx expo install --fix
eas build -p android --profile development # cloud APK (see RUNNING.md), then: npx expo start --dev-client
npx expo run:android --device              # …or build locally with Android Studio
npm test                                   # app logic tests
cd modules/soloist-audio && npm run test:core && npm run test:e2e   # C++ engine tests (g++/clang)
```

## How it works (one paragraph)

The native engine plays the lesson's stems (click, bass, guide guitar) and reads the mic in the same real-time
callback. Every mic sample is mapped onto the song timeline through the hardware's own timestamps plus a
per-phone calibration, so a note's timing judgment doesn't depend on how laggy the phone is. Onsets are found in
2.7 ms steps. Pitch is then checked against the notes the chart expects ("did *this* note or chord just start?"),
which stays reliable when strings ring over each other. Once per frame, JavaScript makes one synchronous call that
collects the clock and new onsets, grades them, and hands the results to a Skia worklet. The worklet draws the
highway on the UI thread at the time each frame will actually appear on screen. Details and measurements:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
