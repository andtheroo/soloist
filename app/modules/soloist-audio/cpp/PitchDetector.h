#pragma once
// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002) with
// cumulative-mean-normalised difference and parabolic interpolation.
//
// Run once per detected onset (not continuously), on a window that starts a few ms
// after the attack so the pick transient doesn't pollute the estimate.
// Window = 2 * tauMax samples: guitar (minHz 70) needs ~29 ms, bass (minHz 38) ~53 ms.
#include <cstdint>
#include <vector>

namespace soloist {

struct PitchResult {
  float hz = 0.f;          // 0 = unpitched / not found
  float confidence = 0.f;  // 1 - aperiodicity, 0..1
};

class PitchDetector {
 public:
  PitchDetector(double sampleRate, double minHz, double maxHz, float threshold = 0.15f);
  int requiredSamples() const { return 2 * tauMax_; }
  int window() const { return tauMax_; }
  double sampleRate() const { return sr_; }
  PitchResult detect(const float* x);  // x must hold requiredSamples() samples

  static float hzToMidi(float hz);

  // Comb-filter probe used for *target-informed* verification (see AudioCore):
  // fraction of the window's energy that is periodic at `tau` samples (fractional ok).
  // ~1 = perfectly periodic at tau, ~0 = unrelated, <0 = anti-correlated.
  // x must hold W + ceil(tau) + 1 samples. `meanEnergy` receives mean power.
  static float periodicFraction(const float* x, int W, double tau, double& meanEnergy);

 private:
  double sr_;
  int tauMin_, tauMax_;
  float threshold_;
  std::vector<float> d_, buf_;
};

}  // namespace soloist
