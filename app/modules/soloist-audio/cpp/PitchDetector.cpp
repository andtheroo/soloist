#include "PitchDetector.h"

#include <algorithm>
#include <cmath>

namespace soloist {

PitchDetector::PitchDetector(double sampleRate, double minHz, double maxHz, float threshold)
    : sr_(sampleRate),
      tauMin_(std::max(2, static_cast<int>(std::floor(sampleRate / maxHz)))),
      tauMax_(static_cast<int>(std::ceil(sampleRate / minHz)) + 2),
      threshold_(threshold),
      d_(tauMax_, 1.f),
      buf_(2 * tauMax_, 0.f) {}

float PitchDetector::hzToMidi(float hz) { return 69.f + 12.f * std::log2(hz / 440.f); }

float PitchDetector::periodicFraction(const float* x, int W, double tau, double& meanEnergy) {
  const int ti = static_cast<int>(tau);
  const float frac = static_cast<float>(tau - ti);
  double d = 0.0, e1 = 0.0, e2 = 0.0;
  for (int j = 0; j < W; ++j) {
    const float delayed = x[j + ti] + frac * (x[j + ti + 1] - x[j + ti]);  // linear fractional delay
    const float diff = x[j] - delayed;
    d += static_cast<double>(diff) * diff;
    e1 += static_cast<double>(x[j]) * x[j];
    e2 += static_cast<double>(delayed) * delayed;
  }
  meanEnergy = (e1 + e2) / (2.0 * W);
  const double denom = e1 + e2;
  return denom > 1e-12 ? static_cast<float>(1.0 - d / denom) : 0.f;
}

PitchResult PitchDetector::detect(const float* x) {
  const int W = tauMax_;
  const int N = 2 * tauMax_;

  // Remove DC so low-frequency rumble doesn't bias the difference function.
  double mean = 0.0;
  for (int i = 0; i < N; ++i) mean += x[i];
  mean /= N;
  for (int i = 0; i < N; ++i) buf_[i] = static_cast<float>(x[i] - mean);

  // Difference function + cumulative mean normalisation. O(W * tauMax) ≈ 0.4 M MACs for guitar.
  d_[0] = 1.f;
  double running = 0.0;
  for (int tau = 1; tau < tauMax_; ++tau) {
    double sum = 0.0;
    const float* a = buf_.data();
    const float* b = buf_.data() + tau;
    for (int j = 0; j < W; ++j) {
      const float diff = a[j] - b[j];
      sum += static_cast<double>(diff) * diff;
    }
    running += sum;
    d_[tau] = running > 0.0 ? static_cast<float>(sum * tau / running) : 1.f;
  }

  // Absolute threshold: first dip below threshold, then walk to its local minimum.
  int tauEst = -1;
  for (int tau = tauMin_; tau < tauMax_ - 1; ++tau) {
    if (d_[tau] < threshold_) {
      while (tau + 1 < tauMax_ - 1 && d_[tau + 1] < d_[tau]) ++tau;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) {  // fallback: global minimum, only if reasonably periodic
    tauEst = static_cast<int>(std::min_element(d_.begin() + tauMin_, d_.end() - 1) - d_.begin());
    if (d_[tauEst] > 0.35f) return {};
  }

  // Parabolic interpolation for sub-sample period (≈ ±2 cents at 82 Hz).
  float better = static_cast<float>(tauEst);
  if (tauEst > 0 && tauEst < tauMax_ - 1) {
    const float s0 = d_[tauEst - 1], s1 = d_[tauEst], s2 = d_[tauEst + 1];
    const float denom = 2.f * (s0 - 2.f * s1 + s2);
    if (std::fabs(denom) > 1e-9f) better += (s0 - s2) / denom;
  }
  PitchResult r;
  r.hz = static_cast<float>(sr_ / better);
  r.confidence = std::clamp(1.f - d_[tauEst], 0.f, 1.f);
  return r;
}

}  // namespace soloist
