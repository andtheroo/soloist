#pragma once
// Time-domain onset detector tuned for plucked strings.
//
// Pipeline per hop (default 128 samples = 2.7 ms @ 48 kHz):
//   pre-emphasis high-pass (pick attacks are broadband) -> hop energy in dB
//   -> rise vs. min of the previous 3 hops, gated by an adaptive noise floor
//   -> refractory period -> sub-hop refinement to the first sample that crosses
//      a fraction of the attack peak (gives ~0.1–1 ms onset precision).
//
// Deliberately FFT-free so it runs comfortably on low-end Android. Known gap: legato
// (hammer-ons / slides) produce no energy rise; those need pitch-change onsets (roadmap).
#include <array>
#include <cstdint>
#include <vector>

namespace soloist {

struct OnsetConfig {
  int hop = 128;
  float riseDb = 9.f;          // required jump over the recent minimum
  float riseOverMeanDb = 6.f;  // ...and over the mean power of the last ~32 ms. Rejects
                               // beating between decaying strings (deep dips, small peaks).
  float aboveFloorDb = 14.f;   // required height above the tracked noise floor
  float absMinDb = -62.f;      // ignore anything quieter than this outright
  float refractoryMs = 45.f;   // min spacing between onsets (~16ths @ 330 bpm)
  float refineFraction = 0.3f; // threshold (fraction of hop peak) for sub-hop refinement
};

class OnsetDetector {
 public:
  OnsetDetector(double sampleRate, OnsetConfig cfg = {});
  void reset();
  // Feed exactly cfg.hop samples whose first sample is device frame `absFrame`.
  // Returns true and sets onsetFrame if an onset begins in this or the previous hop.
  bool process(const float* x, int64_t absFrame, int64_t& onsetFrame);
  float lastLevelDb() const { return lastDb_; }
  const OnsetConfig& config() const { return cfg_; }

 private:
  OnsetConfig cfg_;
  int64_t refractoryFrames_;
  std::vector<float> hp_, prevHp_;
  float prevX_ = 0.f;
  std::array<float, 3> hist_{};
  std::array<double, 12> powHist_{};  // linear power of the last 12 hops
  int powIdx_ = 0;
  float floorDb_ = -80.f;
  float lastDb_ = -120.f;
  int64_t lastOnset_ = INT64_MIN / 2;
  int warmup_ = 0;
};

}  // namespace soloist
