// Practice-loop, clock-across-discontinuity and tuner tests.
//   g++ -std=c++17 -O2 -pthread -I.. ../*.cpp feature_test.cpp -o feature_test && ./feature_test
#include <cmath>
#include <cstdio>
#include <fstream>
#include <thread>
#include <vector>

#include "../AudioCore.h"
#include "../HostClock.h"

using namespace soloist;

static int failures = 0;
#define CHECK(cond, msg)                         \
  do {                                           \
    if (!(cond)) { ++failures; printf("FAIL: %s\n", msg); } \
    else printf("ok   %s\n", msg);               \
  } while (0)

static void writeWav16(const std::string& path, size_t frames, int sr) {
  std::ofstream f(path, std::ios::binary);
  auto u32 = [&](uint32_t v) { f.write(reinterpret_cast<char*>(&v), 4); };
  auto u16 = [&](uint16_t v) { f.write(reinterpret_cast<char*>(&v), 2); };
  f.write("RIFF", 4); u32(36 + frames * 2); f.write("WAVE", 4);
  f.write("fmt ", 4); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16);
  f.write("data", 4); u32(frames * 2);
  for (size_t i = 0; i < frames; ++i) { int16_t v = static_cast<int16_t>(8000 * std::sin(2 * M_PI * 220 * i / sr)); f.write(reinterpret_cast<char*>(&v), 2); }
}

int main() {
  const double sr = 48000;

  // ---------------- 1. A–B loop in the mixer ----------------
  {
    writeWav16("/tmp/soloist_loop.wav", 48000 * 2, 48000);
    AudioCore core;
    core.configure(sr, sr, 70, 1400);
    double dur; std::string err;
    core.loadStems({{"t", "/tmp/soloist_loop.wav", 1.f}}, dur, err);
    core.setLoopMs(500, 1000);
    core.seekMs(500);
    core.play();
    std::vector<float> out(192 * 2);
    int64_t outFrame = 0;
    for (int b = 0; b < 1000; ++b, outFrame += 192) core.renderOutput(out.data(), 192, 2, outFrame);  // 4 s
    std::vector<double> buf(64);
    core.clock().publishOutputTimestamp(outFrame, hostNowNanos());
    core.pollState(buf.data(), 64);
    printf("     loop count after 4 s of a 0.5 s loop: %.0f, ended=%.0f\n", buf[kLoopCount], buf[kEnded]);
    CHECK(buf[kLoopCount] >= 7 && buf[kLoopCount] <= 8, "loop wraps ~8 times in 4 s");
    CHECK(buf[kEnded] == 0, "looping song never reports ended");
    CHECK(buf[kSongMs] >= 500 && buf[kSongMs] <= 1010, "audible position stays inside the loop");

    core.setLoopMs(0, 0);  // clear
    for (int b = 0; b < 600; ++b, outFrame += 192) core.renderOutput(out.data(), 192, 2, outFrame);
    core.pollState(buf.data(), 64);
    CHECK(buf[kEnded] == 1, "clearing the loop lets the song run to the end");
  }

  // ---------------- 2. ClockMap previous-anchor mapping across a jump ----------------
  {
    ClockMap c;
    c.setRates(sr, sr);
    const int64_t base = 1'000'000'000;
    // Output frame F is heard at base + F/sr.
    c.publishOutputTimestamp(0, base);
    // Song plays linearly from songFrame 10000 at outFrame 0 ...
    for (int64_t f = 0; f <= 4800; f += 192) c.publishAnchor(f, 10000 + f, true);
    // ... then a loop wrap: at outFrame 4992 the song jumps back to 500.
    c.publishAnchor(4992, 500, true);
    double ms; bool playing;
    // Audio still in the buffer from before the jump (outFrame 4900) must map to song 14900.
    c.songMsAtHostNs(base + static_cast<int64_t>(4900 / sr * 1e9), ms, playing);
    CHECK(std::fabs(ms - 14900 / 48.0) < 0.05, "pre-jump frames map with the previous anchor");
    c.songMsAtHostNs(base + static_cast<int64_t>(5100 / sr * 1e9), ms, playing);
    CHECK(std::fabs(ms - (500 + 108) / 48.0) < 0.05, "post-jump frames map with the new anchor");

    // Pause: frames queued before the pause keep advancing, later ones freeze.
    c.publishAnchor(5184, 692, false);
    c.songMsAtHostNs(base + static_cast<int64_t>(5100 / sr * 1e9), ms, playing);
    CHECK(std::fabs(ms - (500 + 108) / 48.0) < 0.05 && !playing, "draining audio after pause still maps correctly");
    c.songMsAtHostNs(base + static_cast<int64_t>(6000 / sr * 1e9), ms, playing);
    CHECK(std::fabs(ms - 692 / 48.0) < 0.05, "paused position is frozen");
  }

  // ---------------- 3. Tuner ----------------
  {
    AudioCore core;
    core.configure(sr, sr, 70, 1400);
    core.setTunerEnabled(true);
    core.startAnalysis(nullptr);
    const double hz = 110.0 * std::pow(2.0, 7.0 / 1200.0);  // A2, 7 cents sharp
    std::vector<float> x(static_cast<size_t>(sr * 0.6));
    for (size_t i = 0; i < x.size(); ++i) {
      const double t = i / sr;
      x[i] = static_cast<float>(0.3 * (std::sin(2 * M_PI * hz * t) + 0.5 * std::sin(4 * M_PI * hz * t) +
                                       0.25 * std::sin(6 * M_PI * hz * t)) * std::exp(-t * 1.5));
    }
    for (size_t p = 0; p < x.size(); p += 192) {
      core.onInputFrames(&x[p], 192, static_cast<int64_t>(p));
      std::this_thread::sleep_for(std::chrono::microseconds(800));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    std::vector<double> buf(64);
    core.pollState(buf.data(), 64);
    const double cents = 1200 * std::log2(buf[kTunerHz] / 110.0);
    printf("     tuner: %.2f Hz (%+.1f cents vs A2), confidence %.2f\n", buf[kTunerHz], cents, buf[kTunerConfidence]);
    CHECK(std::fabs(cents - 7.0) < 2.0, "tuner reads A2 +7 cents within 2 cents");
    CHECK(buf[kTunerConfidence] > 0.8, "tuner confidence high on a clean tone");

    std::vector<float> silence(static_cast<size_t>(sr * 0.8), 0.f);
    for (size_t p = 0; p < silence.size(); p += 192) {
      core.onInputFrames(&silence[p], 192, static_cast<int64_t>(x.size() + p));
      std::this_thread::sleep_for(std::chrono::microseconds(800));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    core.pollState(buf.data(), 64);
    CHECK(buf[kTunerConfidence] == 0, "tuner releases on silence");
    core.stopAnalysis();
  }

  puts(failures ? "SOME FEATURE TESTS FAILED" : "ALL FEATURE TESTS PASSED");
  return failures ? 1 : 0;
}
