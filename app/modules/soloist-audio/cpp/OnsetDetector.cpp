#include "OnsetDetector.h"

#include <algorithm>
#include <cmath>

namespace soloist {

OnsetDetector::OnsetDetector(double sampleRate, OnsetConfig cfg)
    : cfg_(cfg),
      refractoryFrames_(static_cast<int64_t>(cfg.refractoryMs * 1e-3 * sampleRate)),
      hp_(cfg.hop, 0.f),
      prevHp_(cfg.hop, 0.f) {
  reset();
}

void OnsetDetector::reset() {
  std::fill(hp_.begin(), hp_.end(), 0.f);
  std::fill(prevHp_.begin(), prevHp_.end(), 0.f);
  hist_.fill(-120.f);
  powHist_.fill(1e-12);
  powIdx_ = 0;
  prevX_ = 0.f;
  floorDb_ = -80.f;
  lastOnset_ = INT64_MIN / 2;
  warmup_ = 8;  // let the floor settle after start / discontinuity
}

bool OnsetDetector::process(const float* x, int64_t absFrame, int64_t& onsetFrame) {
  const int n = cfg_.hop;
  std::swap(hp_, prevHp_);

  double energy = 0.0;
  float peak = 0.f;
  for (int i = 0; i < n; ++i) {
    const float y = x[i] - 0.97f * prevX_;  // pre-emphasis
    prevX_ = x[i];
    hp_[i] = y;
    energy += static_cast<double>(y) * y;
    peak = std::max(peak, std::fabs(y));
  }
  const float db = 10.f * std::log10(static_cast<float>(energy / n) + 1e-12f);
  lastDb_ = db;

  const float recentMin = std::min({hist_[0], hist_[1], hist_[2]});
  const float rise = db - recentMin;
  double meanPow = 0.0;
  for (double p : powHist_) meanPow += p;
  meanPow /= powHist_.size();
  const float riseOverMean = db - 10.f * std::log10(static_cast<float>(meanPow) + 1e-12f);

  bool fired = false;
  if (warmup_ > 0) {
    --warmup_;
  } else if (absFrame - lastOnset_ >= refractoryFrames_ && rise > cfg_.riseDb && riseOverMean > cfg_.riseOverMeanDb &&
             db > floorDb_ + cfg_.aboveFloorDb && db > cfg_.absMinDb) {
    // Refine: first sample in [prev hop, this hop] exceeding a fraction of the attack peak.
    const float thr = cfg_.refineFraction * peak;
    int64_t found = absFrame;
    bool hit = false;
    for (int i = 0; i < n && !hit; ++i) {
      if (std::fabs(prevHp_[i]) > thr) { found = absFrame - n + i; hit = true; }
    }
    for (int i = 0; i < n && !hit; ++i) {
      if (std::fabs(hp_[i]) > thr) { found = absFrame + i; hit = true; }
    }
    onsetFrame = found;
    lastOnset_ = found;
    fired = true;
  }

  // Asymmetric floor tracker: falls fast, rises slowly (so sustained notes don't raise it much).
  const float a = db < floorDb_ ? 0.2f : 0.002f;
  floorDb_ += a * (db - floorDb_);

  powHist_[powIdx_] = energy / n;
  powIdx_ = (powIdx_ + 1) % static_cast<int>(powHist_.size());
  hist_[2] = hist_[1];
  hist_[1] = hist_[0];
  hist_[0] = db;
  return fired;
}

}  // namespace soloist
