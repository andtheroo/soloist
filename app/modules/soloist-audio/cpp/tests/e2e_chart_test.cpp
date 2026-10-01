// End-to-end: feed a generated "guide" stem (Karplus–Strong guitar playing exactly the chart)
// through AudioCore as if it were the microphone, and check every chart note is detected
// on time and pitch-verified. Chords count once (one strum = one onset).
//   e2e_chart_test <guide.wav> <notes.txt: "timeMs midi" per line>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <thread>
#include <vector>

#include "../AudioCore.h"
#include "../HostClock.h"
#include "../WavLoader.h"

using namespace soloist;

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: %s guide.wav notes.txt\n", argv[0]); return 2; }
  const double sr = 48000;
  DecodedAudio audio;
  std::string err;
  if (!loadWav(argv[1], sr, audio, err)) { fprintf(stderr, "%s\n", err.c_str()); return 2; }
  std::vector<ExpectedNote> notes;
  std::ifstream nf(argv[2]);
  // Optional 3rd arg: transpose the *expected* notes (a wrong-chord / wrong-note distractor run:
  // verification should then fail almost everywhere).
  const int transpose = argc > 3 ? std::atoi(argv[3]) : 0;
  for (double t, m; nf >> t >> m;) notes.push_back({t, static_cast<float>(m + transpose), 0});

  AudioCore core;
  core.configure(sr, sr, 70, 1400);
  const int64_t base = hostNowNanos();
  core.clock().publishOutputTimestamp(0, base);
  core.clock().publishInputTimestamp(0, base);  // identity mapping: input frame i == song frame i
  core.clock().publishAnchor(0, 0, true);
  core.setExpectedNotes(notes);
  core.startAnalysis(nullptr);

  std::vector<float> mono(static_cast<size_t>(audio.frames));
  for (int64_t i = 0; i < audio.frames; ++i) mono[i] = 0.5f * (audio.stereo[2 * i] + audio.stereo[2 * i + 1]) / 32768.f;
  for (size_t pos = 0; pos < mono.size(); pos += 192) {
    core.onInputFrames(&mono[pos], static_cast<int>(std::min<size_t>(192, mono.size() - pos)), static_cast<int64_t>(pos));
    if (pos % (192 * 32) == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  core.stopAnalysis();

  std::vector<double> buf(kHeaderSize + 512 * (kEventFixedFields + 6));
  core.pollState(buf.data(), static_cast<int>(buf.size()));
  struct Ev { double t; std::vector<int> verified; };
  std::vector<Ev> evs;
  for (int e = 0, w = kHeaderSize; e < static_cast<int>(buf[kEventCount]); ++e) {
    Ev ev{buf[w], {}};
    for (int k = 0; k < static_cast<int>(buf[w + 5]); ++k) ev.verified.push_back(static_cast<int>(buf[w + 6 + k]));
    evs.push_back(ev);
    w += kEventFixedFields + static_cast<int>(buf[w + 5]);
  }

  // Group chart notes into strums (within 15 ms), like the JS grader does.
  int groups = 0, detected = 0, verified = 0;
  double maxErr = 0;
  for (size_t i = 0; i < notes.size();) {
    size_t j = i + 1;
    while (j < notes.size() && notes[j].timeMs - notes[i].timeMs <= 15) ++j;
    ++groups;
    for (const auto& ev : evs) {
      if (std::fabs(ev.t - notes[i].timeMs) <= 25) {
        ++detected;
        maxErr = std::max(maxErr, std::fabs(ev.t - notes[i].timeMs));
        bool v = false;
        for (int idx : ev.verified) v |= (idx >= static_cast<int>(i) && idx < static_cast<int>(j));
        verified += v;
        break;
      }
    }
    i = j;
  }
  printf("%-28s strums %2d | onsets %2d/%2d (max err %.1f ms, %zu total events) | pitch-verified %2d/%2d\n",
         argv[2] + std::string(argv[2]).rfind('/') + 1, groups, detected, groups, maxErr, evs.size(), verified, groups);
  if (transpose != 0) return verified <= groups / 8 ? 0 : 1;  // distractor run: ≤12.5 % false accepts
  return (detected >= groups - 1 && verified >= detected * 3 / 4) ? 0 : 1;
}
