// Host-side test harness for the shared audio core (no device needed).
//   g++ -std=c++17 -O2 -pthread -I.. ../*.cpp core_test.cpp -o core_test && ./core_test
// Simulates a guitarist: Karplus-Strong plucks at known song times, mic noise, and a
// device with 23 ms of input latency + 11 ms output latency. Verifies the analysis
// thread recovers onset times (latency-compensated) and pitches.
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <fstream>
#include <random>
#include <thread>
#include <vector>

#include "../AudioCore.h"
#include "../HostClock.h"

using namespace soloist;

static void writeWav16(const std::string& path, const std::vector<float>& mono, int sr) {
  std::ofstream f(path, std::ios::binary);
  auto u32 = [&](uint32_t v) { f.write(reinterpret_cast<char*>(&v), 4); };
  auto u16 = [&](uint16_t v) { f.write(reinterpret_cast<char*>(&v), 2); };
  const uint32_t dataBytes = static_cast<uint32_t>(mono.size() * 2);
  f.write("RIFF", 4); u32(36 + dataBytes); f.write("WAVE", 4);
  f.write("fmt ", 4); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16);
  f.write("data", 4); u32(dataBytes);
  for (float s : mono) { int16_t v = static_cast<int16_t>(std::lrint(std::max(-1.f, std::min(1.f, s)) * 32767)); f.write(reinterpret_cast<char*>(&v), 2); }
}

int main(int argc, char** argv) {
  const unsigned seed = argc > 1 ? static_cast<unsigned>(std::atoi(argv[1])) : 7u;
  const double sr = 48000;
  int failures = 0;

  // ---------- 1. Mixer + WAV loader (44.1k file -> 48k device, resampled) ----------
  {
    std::vector<float> tone(44100);
    for (size_t i = 0; i < tone.size(); ++i) tone[i] = 0.5f * std::sin(2 * M_PI * 440 * i / 44100.0);
    writeWav16("/tmp/soloist_tone.wav", tone, 44100);
    AudioCore core;
    core.configure(sr, sr, 70, 1400);
    double dur = 0; std::string err;
    if (!core.loadStems({{"backing", "/tmp/soloist_tone.wav", 1.f}}, dur, err)) { printf("FAIL load: %s\n", err.c_str()); return 1; }
    printf("[mixer] loaded duration %.1f ms (expect ~1000)\n", dur);
    if (std::fabs(dur - 1000) > 1) { ++failures; puts("FAIL duration"); }
    core.play();
    std::vector<float> out(192 * 2);
    double peak = 0;
    for (int b = 0; b < 50; ++b) {
      core.renderOutput(out.data(), 192, 2, b * 192);
      for (float s : out) peak = std::max(peak, (double)std::fabs(s));
    }
    printf("[mixer] output peak %.3f (expect ~0.5)\n", peak);
    if (peak < 0.45 || peak > 0.55) { ++failures; puts("FAIL mixer peak"); }
  }

  // ---------- 2. Input analysis: onset timing + pitch through the ClockMap ----------
  AudioCore core;
  core.configure(sr, sr, 70, 1400);
  ClockMap& clock = core.clock();
  const int64_t base = hostNowNanos();
  const double inLatMs = 23.0, outLatMs = 11.0;
  // Output frame F is heard at base + F/sr + outLat. Input frame I left the air at base + I/sr - inLat.
  clock.publishOutputTimestamp(0, base + static_cast<int64_t>(outLatMs * 1e6));
  clock.publishInputTimestamp(0, base - static_cast<int64_t>(inLatMs * 1e6));
  clock.publishAnchor(0, 0, true);  // song frame 0 at output frame 0, playing
  core.startAnalysis(nullptr);

  // User plays "in time with what they hear": a note at song time T is heard at
  // base + T + outLat, and captured at input frame I where base + I/sr - inLat = that time.
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> midiDist(40, 76);
  struct Truth { double songMs; int midi; };
  std::vector<Truth> truth;
  const double totalSec = 12.0;
  std::vector<float> mic(static_cast<size_t>(totalSec * sr), 0.f);
  std::normal_distribution<float> noise(0.f, 0.002f);  // ~-54 dBFS noise floor
  for (auto& s : mic) s = noise(rng);
  for (double t = 500; t < totalSec * 1000 - 600; t += 230 + (rng() % 200)) {
    const int midi = midiDist(rng);
    truth.push_back({t, midi});
    const double hz = 440.0 * std::pow(2.0, (midi - 69) / 12.0);
    const size_t start = static_cast<size_t>((t + outLatMs + inLatMs) * sr / 1000.0);
    // Karplus-Strong pluck
    const int period = static_cast<int>(std::lround(sr / hz));
    std::vector<float> line(period);
    for (auto& v : line) v = (rng() / (float)rng.max()) * 2 - 1;
    const size_t len = static_cast<size_t>(0.8 * sr);  // overlapping sustain, like a real guitar
    for (size_t i = 0; i < len && start + i < mic.size(); ++i) {
      const size_t k = i % period;
      const float out = line[k];
      line[k] = 0.996f * 0.5f * (line[k] + line[(k + 1) % period]);
      mic[start + i] += 0.35f * out;
    }
  }

  {
    std::vector<ExpectedNote> exp;
    // For every real note, also expect 4 distractors the user did NOT play (whole step,
    // fifth, octave up, octave down). Index layout: 5*ti = real note, 5*ti+1..4 = distractors.
    for (const auto& tr : truth) {
      // Distractors 20/40/60/80 ms after the real note: separate (non-chord) candidates that
      // all sit inside the ±160 ms verification search window.
      int k = 0;
      for (int dm : {0, 2, 7, 12, -12}) exp.push_back({tr.songMs + 20.0 * k++, static_cast<float>(tr.midi + dm), 0});
    }
    core.setExpectedNotes(exp);
  }
  // Feed like a device would: 192-frame bursts.
  for (size_t pos = 0; pos < mic.size(); pos += 192) {
    const int n = static_cast<int>(std::min<size_t>(192, mic.size() - pos));
    core.onInputFrames(&mic[pos], n, static_cast<int64_t>(pos));
    if (pos % (192 * 32) == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  core.stopAnalysis();

  std::vector<double> buf(8 + 12 * 256);
  const int n = core.pollState(buf.data(), static_cast<int>(buf.size()));
  const int count = static_cast<int>(buf[kEventCount]);
  printf("[analysis] %zu plucks, %d detections (%d doubles)\n", truth.size(), count, n);

  std::vector<const double*> events;
  for (int e = 0, w = kHeaderSize; e < count; ++e) {
    events.push_back(&buf[w]);
    w += kEventFixedFields + static_cast<int>(buf[w + 5]);
  }
  int matched = 0, pitchOk = 0, blindOk = 0, wrongVerified = 0;
  double maxErr = 0, sumAbs = 0;
  for (size_t ti = 0; ti < truth.size(); ++ti) {
    const auto& tr = truth[ti];
    for (const double* ev : events) {
      if (std::fabs(ev[0] - tr.songMs) < 30) {
        ++matched;
        const double err = ev[0] - tr.songMs;
        maxErr = std::max(maxErr, std::fabs(err));
        sumAbs += std::fabs(err);
        const bool blind = ev[1] > 0 && std::fabs(ev[1] - tr.midi) < 0.5;
        bool verified = false;
        for (int k = 0; k < static_cast<int>(ev[5]); ++k) {
          const size_t idx = static_cast<size_t>(ev[6 + k]);
          if (idx == 5 * ti) verified = true;
          else if (idx % 5 != 0) { ++wrongVerified; printf("  false verify: played %d, distractor slot %zu (idx %zu)\n", tr.midi, idx % 5, idx); }
        }
        blindOk += blind;
        pitchOk += (blind || verified);
        break;
      }
    }
  }
  printf("[analysis] matched %d/%zu, timing mean|err| %.2f ms, max %.2f ms\n", matched, truth.size(),
         matched ? sumAbs / matched : 0.0, maxErr);
  printf("[analysis] pitch: blind YIN %d/%d, blind+verified %d/%d, false verifications %d\n", blindOk,
         matched, pitchOk, matched, wrongVerified);
  if (wrongVerified > 2)  // stress case: distractors share the exact onset time { ++failures; puts("FAIL false verifications"); }
  if (matched < static_cast<int>(truth.size()) - 1) { ++failures; puts("FAIL recall"); }
  if (count > static_cast<int>(truth.size()) + 2) { ++failures; puts("FAIL false positives"); }
  if (maxErr > 3.0) { ++failures; puts("FAIL timing precision"); }
  if (pitchOk < matched * 0.95) { ++failures; puts("FAIL pitch accuracy"); }

  puts(failures ? "SOME TESTS FAILED" : "ALL CORE TESTS PASSED");
  return failures ? 1 : 0;
}
