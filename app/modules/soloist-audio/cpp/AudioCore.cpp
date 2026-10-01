#include "AudioCore.h"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "HostClock.h"

#if defined(__ANDROID__)
#include <sys/resource.h>
#include <unistd.h>
#elif defined(__APPLE__)
#include <pthread.h>
#endif

namespace soloist {

namespace {
constexpr int kHistoryFrames = 1 << 15;  // ~680 ms @ 48 kHz — enough for bass YIN windows
constexpr double kPitchSkipMs = 8.0;      // skip the pick transient before measuring pitch

void raiseAnalysisThreadPriority() {
#if defined(__ANDROID__)
  setpriority(PRIO_PROCESS, static_cast<id_t>(gettid()), -16);  // best effort; may be denied
#elif defined(__APPLE__)
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#endif
}
}  // namespace

AudioCore::AudioCore() : history_(kHistoryFrames, 0.f) { pending_.reserve(16); }

AudioCore::~AudioCore() { stopAnalysis(); }

void AudioCore::configure(double outRate, double inRate, double minHz, double maxHz) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  const bool wasRunning = running_.load();
  auto poller = poller_;
  if (wasRunning) stopAnalysis();
  clock_.setRates(outRate, inRate);
  onset_ = std::make_unique<OnsetDetector>(inRate);
  pitch_ = std::make_unique<PitchDetector>(inRate, minHz, maxHz);
  scratch_.assign(std::max(pitch_->requiredSamples(), onset_->config().hop) + 2, 0.f);
  preScratch_.assign(scratch_.size(), 0.f);
  // Chords use a 2x longer window: several simultaneous periods need more cycles to separate.
  chordScratch_.assign(static_cast<size_t>(4 * pitch_->window() + 2), 0.f);
  chordPreScratch_.assign(chordScratch_.size(), 0.f);
  pitchSkipFrames_ = static_cast<int64_t>(kPitchSkipMs * 1e-3 * inRate);
  resetAnalysis();
  if (wasRunning) startAnalysis(poller);
}

bool AudioCore::loadStems(const std::vector<StemSpec>& stems, double& durationMs, std::string& error) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  auto bundle = std::make_unique<SongBundle>();
  for (const auto& spec : stems) {
    auto stem = std::make_unique<Stem>();
    stem->id = spec.id;
    if (!loadWav(spec.path, clock_.outRate(), stem->audio, error)) {
      error = spec.id + ": " + error;
      return false;
    }
    stem->targetGain.store(spec.gain);
    stem->currentGain = spec.gain;
    bundle->frames = std::max(bundle->frames, stem->audio.frames);
    bundle->stems.push_back(std::move(stem));
  }
  durationMs = bundle->frames * 1000.0 / clock_.outRate();
  durationMs_.store(durationMs);
  mixer_.setSong(std::move(bundle));
  return true;
}

void AudioCore::play() { mixer_.play(); }

void AudioCore::setExpectedNotes(std::vector<ExpectedNote> notes) {
  for (size_t i = 0; i < notes.size(); ++i) notes[i].index = static_cast<uint16_t>(i);
  std::stable_sort(notes.begin(), notes.end(),
            [](const ExpectedNote& a, const ExpectedNote& b) { return a.timeMs < b.timeMs; });
  std::lock_guard<std::mutex> lock(expectedMutex_);
  expected_ = std::move(notes);
}

void AudioCore::setLoopMs(double startMs, double endMs) {
  const double fpm = clock_.outRate() / 1000.0;
  if (endMs <= startMs) mixer_.setLoop(-1, -1);
  else mixer_.setLoop(static_cast<int64_t>(std::max(0.0, startMs) * fpm), static_cast<int64_t>(endMs * fpm));
}

void AudioCore::seekMs(double ms) {
  mixer_.seekFrames(static_cast<int64_t>(std::max(0.0, ms) * clock_.outRate() / 1000.0));
}

bool AudioCore::setStemGain(const std::string& id, float gain) {
  std::lock_guard<std::mutex> lock(controlMutex_);
  return mixer_.setStemGain(id, gain);
}

void AudioCore::startAnalysis(std::function<void()> timestampPoller) {
  if (running_.exchange(true)) return;
  poller_ = std::move(timestampPoller);
  thread_ = std::thread([this] { analysisLoop(); });
}

void AudioCore::stopAnalysis() {
  if (!running_.exchange(false)) return;
  if (thread_.joinable()) thread_.join();
}

void AudioCore::resetAnalysis() {
  if (onset_) onset_->reset();
  pending_.clear();
  std::fill(history_.begin(), history_.end(), 0.f);
  historyEnd_ = 0;
}

void AudioCore::analysisLoop() {
  raiseAnalysisThreadPriority();
  const int hop = onset_->config().hop;
  std::vector<float> block(hop);
  auto lastPoll = std::chrono::steady_clock::now() - std::chrono::seconds(1);

  while (running_.load(std::memory_order_acquire)) {
    const auto now = std::chrono::steady_clock::now();
    if (poller_ && now - lastPoll >= std::chrono::milliseconds(10)) {
      poller_();
      lastPoll = now;
    }
    if (ring_.availableToRead() < static_cast<size_t>(hop)) {
      // Hop is 2.7 ms; sleeping 1 ms keeps detection latency low at negligible CPU cost.
      // (Can't signal a condvar from the RT thread without risking a syscall there.)
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    int64_t absFrame;
    uint32_t disc;
    while (ring_.read(block.data(), hop, absFrame, disc)) {
      if (disc != lastDiscontinuity_) {
        lastDiscontinuity_ = disc;
        resetAnalysis();
      }
      processHop(block.data(), absFrame);
    }
  }
}

bool AudioCore::historyCopy(int64_t absStart, int n, float* dst) const {
  if (absStart < historyEnd_ - kHistoryFrames || absStart + n > historyEnd_) return false;
  for (int i = 0; i < n; ++i) dst[i] = history_[static_cast<size_t>(absStart + i) & (kHistoryFrames - 1)];
  return true;
}

void AudioCore::processHop(const float* x, int64_t absFrame) {
  const int n = onset_->config().hop;

  // 1) Append to history (absolute-indexed circular buffer).
  for (int i = 0; i < n; ++i) history_[static_cast<size_t>(absFrame + i) & (kHistoryFrames - 1)] = x[i];
  historyEnd_ = absFrame + n;

  // 2) Level meter (fast attack, ~300 ms release) for the "is your mic working?" UI.
  double e = 0;
  for (int i = 0; i < n; ++i) e += static_cast<double>(x[i]) * x[i];
  const float db = 10.f * std::log10(static_cast<float>(e / n) + 1e-12f);
  meterDb_ = db > meterDb_ ? db : meterDb_ + 0.03f * (db - meterDb_);
  inputDb_.store(meterDb_, std::memory_order_relaxed);

  // 3) Onset detection. Map to song time *immediately* while timestamps are fresh.
  int64_t onsetFrame;
  if (onset_->process(x, absFrame, onsetFrame)) {
    PendingOnset p{onsetFrame, 0.0, false, onset_->lastLevelDb(), 0, false};
    p.mapped = clock_.inputFrameToSongMs(onsetFrame, p.songMs);
    const int group = p.mapped ? largestGroupNear(p.songMs) : 1;
    p.chordWindow = group >= 2;
    if (group >= 3) p.extraSkip = static_cast<int64_t>(0.027 * clock_.inRate());  // strum spread
    if (pending_.size() < 16) pending_.push_back(p);
  }

  // 4) Tuner (only when the tuner screen is open).
  if (tunerEnabled_.load(std::memory_order_relaxed) && ++tunerHopCounter_ >= 12) {
    tunerHopCounter_ = 0;
    updateTuner();
  }

  // 5) Pitch for any onset whose analysis window is now complete.
  for (auto it = pending_.begin(); it != pending_.end();) {
    const int need = pendingNeedsChordWindow(*it) ? static_cast<int>(chordScratch_.size())
                                                  : pitch_->requiredSamples() + 2;
    const int64_t start = it->frame + pitchSkipFrames_ + it->extraSkip;
    if (start + need > historyEnd_) { ++it; continue; }
    DetectedNote ev;
    ev.id = nextId_++;
    ev.songMs = it->songMs;
    ev.levelDb = it->levelDb;
    ev.detectedAtMs = hostNowNanos() / 1e6;
    if (historyCopy(start, static_cast<int>(scratch_.size()), scratch_.data())) {
      const PitchResult pr = pitch_->detect(scratch_.data());
      if (pr.hz > 0.f) {
        ev.midi = PitchDetector::hzToMidi(pr.hz);
        ev.confidence = pr.confidence;
      }
      verifyExpected(*it, ev);
    }
    if (it->mapped) events_.push(ev);  // unmapped = clocks not ready yet; drop
    it = pending_.erase(it);
  }
}

// Target-informed verification. Blind pitch estimation breaks down when earlier notes
// are still ringing or the user strums a chord. But we KNOW which notes the chart
// expects around this onset, so for each candidate we ask a narrower question:
// "did energy that is periodic at this note's period appear at this onset?"
//   rise   = periodicPower(after onset) - periodicPower(before onset)
//            (subtracting 'before' cancels notes that were already ringing, incl. octaves)
//   purity = pf(tau) - pf(tau/2) (rejects the user playing an octave *above* the target,
//            whose period also divides tau)
void AudioCore::verifyExpected(const PendingOnset& p, DetectedNote& ev) {
  std::unique_lock<std::mutex> lock(expectedMutex_, std::try_to_lock);
  if (!lock.owns_lock() || expected_.empty() || !p.mapped) return;

  constexpr double kSearchMs = 160.0;
  constexpr double kChordMs = 15.0;  // same tolerance as the JS grader
  auto lo = std::lower_bound(expected_.begin(), expected_.end(), p.songMs - kSearchMs,
                             [](const ExpectedNote& n, double t) { return n.timeMs < t; });
  const int L = static_cast<int>(scratch_.size());
  const int64_t guard = static_cast<int64_t>(0.002 * pitch_->sampleRate());
  const bool havePre = historyCopy(p.frame - guard - L, L, preScratch_.data());

  // Walk candidate groups (single notes or chords) near the onset.
  auto it = lo;
  while (it != expected_.end() && it->timeMs <= p.songMs + kSearchMs && ev.nVerified < 6) {
    auto groupEnd = it;
    while (groupEnd != expected_.end() && groupEnd->timeMs - it->timeMs <= kChordMs) ++groupEnd;
    std::vector<double> taus;
    for (auto g = it; g != groupEnd; ++g) {
      taus.push_back(pitch_->sampleRate() / (440.0 * std::pow(2.0, (g->midi - 69.0) / 12.0)));
    }
    bool ok = false;
    if (taus.size() == 1) {
      float score;
      ok = verifySingle(taus[0], havePre, score);
    } else {
      ok = verifyChord(taus, p);
    }
    if (ok) {
      for (auto g = it; g != groupEnd && ev.nVerified < 6; ++g) ev.verified[ev.nVerified++] = g->index;
    }
    it = groupEnd;
  }
}

int AudioCore::largestGroupNear(double songMs) {
  std::unique_lock<std::mutex> lock(expectedMutex_, std::try_to_lock);
  if (!lock.owns_lock()) return 1;
  int best = 1;
  auto it = std::lower_bound(expected_.begin(), expected_.end(), songMs - 160.0,
                             [](const ExpectedNote& n, double t) { return n.timeMs < t; });
  for (; it != expected_.end() && it->timeMs <= songMs + 160.0; ++it) {
    int n = 0;
    for (auto g = it; g != expected_.end() && g->timeMs - it->timeMs <= 15.0; ++g) ++n;
    best = std::max(best, n);
  }
  return best;
}

// Single note. "Did energy periodic at this note's period appear at this onset?"
//   rise   = periodic power after the onset minus before (cancels strings already ringing)
//   purity = more periodic at tau than at tau/2 (octave above) and 2*tau (octave below)
//   localMax = more periodic at tau than a semitone either side (near-sinusoidal high notes)
bool AudioCore::verifySingle(double tau, bool havePre, float& score) {
  const int W = pitch_->window();
  const int L = static_cast<int>(scratch_.size());
  score = 0.f;
  if (tau + 2 >= L - W) return false;  // below the configured minimum frequency

  double ePost, eHalf, ePre = 0.0, eN;
  const float pfPost = PitchDetector::periodicFraction(scratch_.data(), W, tau, ePost);
  const float pfHalf = PitchDetector::periodicFraction(scratch_.data(), W, tau * 0.5, eHalf);
  const float pfPre = havePre ? PitchDetector::periodicFraction(preScratch_.data(), W, tau, ePre) : 0.f;
  float pfDouble = -1.f;
  if (2.0 * tau + 2 < L - W) pfDouble = PitchDetector::periodicFraction(scratch_.data(), W, tau * 2.0, eN);
  constexpr double kSemi = 1.0594630943592953;
  const float pfSharp = PitchDetector::periodicFraction(scratch_.data(), W, tau / kSemi, eN);
  float pfFlat = -1.f;
  if (tau * kSemi + 2 < L - W) pfFlat = PitchDetector::periodicFraction(scratch_.data(), W, tau * kSemi, eN);

  const bool localMax = pfPost >= std::max(pfSharp, pfFlat) - 0.02f;
  const double periodicPost = std::max(0.f, pfPost) * ePost;
  const double periodicPre = std::max(0.f, pfPre) * ePre;
  const bool rose = (periodicPost - periodicPre) > 0.2 * ePost;
  const bool pure = pfPost > 0.35f && localMax && (pfPost - pfHalf) > 0.2f && (pfDouble - pfPost) < 0.25f;
  score = pfPost;
  return rose && pure;
}

// Chord (2+ notes struck together). Each note only carries a fraction of the energy, so
// per-note thresholds don't work. Instead compare the *whole chord shape* against the same
// shape transposed a semitone up and down: the played chord must fit clearly better than
// its neighbours, and its periodic energy must have risen at this onset.
bool AudioCore::verifyChord(const std::vector<double>& taus, const PendingOnset& p) {
  const int W = 3 * pitch_->window();
  const int L = static_cast<int>(chordScratch_.size());
  const int64_t start = p.frame + pitchSkipFrames_ + p.extraSkip;
  const int64_t guard = static_cast<int64_t>(0.002 * pitch_->sampleRate());
  if (!historyCopy(start, L, chordScratch_.data())) return false;
  const bool havePre = historyCopy(p.frame - guard - L, L, chordPreScratch_.data());
  constexpr double kSemi = 1.0594630943592953;
  auto score = [&](const float* x, double factor, double& energy) {
    double sum = 0.0;
    int n = 0;
    energy = 0.0;
    for (double tau : taus) {
      const double t = tau * factor;
      if (t + 2 >= L - W) continue;
      double e;
      sum += PitchDetector::periodicFraction(x, W, t, e);
      energy = e;
      ++n;
    }
    return n ? static_cast<float>(sum / n) : -1.f;
  };
  double ePost, eTmp, ePre = 0.0;
  const float s0 = score(chordScratch_.data(), 1.0, ePost);
  const float sUp = score(chordScratch_.data(), 1.0 / kSemi, eTmp);
  const float sDown = score(chordScratch_.data(), kSemi, eTmp);
  const float sPre = havePre ? score(chordPreScratch_.data(), 1.0, ePre) : 0.f;
  const bool fits = s0 > 0.12f && s0 - std::max(sUp, sDown) > 0.1f;
  const bool rose = std::max(0.f, s0) * ePost - std::max(0.f, sPre) * ePre > 0.1 * ePost;
  return fits && rose;
}

// Tuner: YIN on the newest window every ~32 ms, median-of-3 smoothing, and a hold so the
// needle doesn't drop out between plucks. Silence (< -58 dBFS) fades confidence to 0.
void AudioCore::updateTuner() {
  const int need = pitch_->requiredSamples();
  if (meterDb_ < -58.f || !historyCopy(historyEnd_ - need, need, scratch_.data())) {
    if (++tunerSilentHops_ > 10) tunerConfidence_.store(0.f, std::memory_order_relaxed);
    return;
  }
  const PitchResult pr = pitch_->detect(scratch_.data());
  if (pr.hz <= 0.f || pr.confidence < 0.75f) {
    if (++tunerSilentHops_ > 10) tunerConfidence_.store(0.f, std::memory_order_relaxed);
    return;
  }
  tunerSilentHops_ = 0;
  // A jump of more than ~a semitone restarts the median (new string plucked).
  const float last = tunerHistoryN_ ? tunerHistory_[(tunerHistoryN_ - 1) % 3] : 0.f;
  if (last > 0.f && std::fabs(12.f * std::log2(pr.hz / last)) > 0.8f) tunerHistoryN_ = 0;
  tunerHistory_[tunerHistoryN_ % 3] = pr.hz;
  ++tunerHistoryN_;
  float hz = pr.hz;
  if (tunerHistoryN_ >= 3) {
    float a = tunerHistory_[0], b = tunerHistory_[1], c = tunerHistory_[2];
    hz = std::max(std::min(a, b), std::min(std::max(a, b), c));  // median of 3
  }
  tunerHz_.store(hz, std::memory_order_relaxed);
  tunerConfidence_.store(pr.confidence, std::memory_order_relaxed);
}

int AudioCore::pollState(double* dst, int capacity) {
  if (capacity < kHeaderSize) return 0;
  const int64_t nowNs = hostNowNanos();
  double songMs = 0;
  bool playing = false;
  clock_.songMsAtHostNs(nowNs, songMs, playing);
  dst[kSongMs] = songMs;
  dst[kHostNowMs] = nowNs / 1e6;
  dst[kPlaying] = playing ? 1 : 0;
  dst[kEnded] = mixer_.ended() ? 1 : 0;
  dst[kInputDb] = inputDb_.load(std::memory_order_relaxed);
  dst[kDurationMs] = durationMs_.load();
  dst[kOverflows] = ring_.overflowCount();
  dst[kDeviceGeneration] = deviceGeneration_.load();
  dst[kTunerHz] = tunerHz_.load(std::memory_order_relaxed);
  dst[kTunerConfidence] = tunerConfidence_.load(std::memory_order_relaxed);
  dst[kLoopCount] = mixer_.loopCount();

  int count = 0;
  int w = kHeaderSize;
  DetectedNote ev;
  while (w + kEventFixedFields + 6 <= capacity && events_.pop(ev)) {
    dst[w++] = ev.songMs;
    dst[w++] = ev.midi;
    dst[w++] = ev.confidence;
    dst[w++] = ev.levelDb;
    dst[w++] = ev.detectedAtMs;
    dst[w++] = ev.nVerified;
    for (int i = 0; i < ev.nVerified; ++i) dst[w++] = ev.verified[i];
    ++count;
  }
  dst[kEventCount] = count;
  return w;
}

}  // namespace soloist
