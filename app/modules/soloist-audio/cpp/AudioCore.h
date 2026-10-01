#pragma once
// AudioCore — platform-agnostic heart of the Soloist audio engine.
//
//   ┌──────────── RT audio thread (Oboe callback / AVAudioEngine render) ───────────┐
//   │ renderOutput(): Mixer -> device, publishes SongAnchor                          │
//   │ onInputFrames(): mic -> SpscRingBuffer (tagged with device frame index)        │
//   └───────────────────────────────┬────────────────────────────────────────────────┘
//                                   │ lock-free
//   ┌───────────── Analysis thread (high priority, NOT real-time) ───────────────────┐
//   │ OnsetDetector (2.7 ms hops) -> ClockMap: input frame -> song ms                 │
//   │ PitchDetector (YIN, once per onset) -> SpscQueue<DetectedNote>                  │
//   │ also polls hardware timestamps (Android) every ~10 ms                           │
//   └───────────────────────────────┬────────────────────────────────────────────────┘
//                                   │ pollState() — one synchronous JSI call per frame
//                               JS thread (grading) -> UI thread (Skia)
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "ClockMap.h"
#include "Mixer.h"
#include "OnsetDetector.h"
#include "PitchDetector.h"
#include "SpscRingBuffer.h"

namespace soloist {

struct DetectedNote {
  double songMs = 0;      // song position the user heard when they played it (latency-compensated)
  double detectedAtMs = 0;// host ms when analysis finished (diagnostics: feedback latency)
  float midi = -1.f;      // fractional MIDI (cents = fract*100), -1 = unpitched
  float confidence = 0.f;
  float levelDb = -120.f;
  uint32_t id = 0;
  // Indices (into the expected-note list) whose pitch was verified as newly sounding
  // at this onset. Robust where blind YIN fails: chords and ringing previous notes.
  uint8_t nVerified = 0;
  uint16_t verified[6] = {};
};

struct ExpectedNote {
  double timeMs;
  float midi;
  uint16_t index = 0;  // caller's index; assigned by setExpectedNotes (survives sorting)
};

struct StemSpec {
  std::string id;
  std::string path;  // local filesystem path (not a file:// URI)
  float gain = 1.f;
};

// pollState() output layout — mirrored in modules/soloist-audio/src/SoloistAudio.types.ts
enum PollField : int {
  kSongMs = 0, kHostNowMs, kPlaying, kEnded, kInputDb, kDurationMs, kOverflows, kDeviceGeneration,
  kTunerHz, kTunerConfidence, kLoopCount,
  kEventCount,
  kHeaderSize
};
// Each event: songMs, midi, confidence, levelDb, detectedAtMs, nVerified, verifiedIdx[nVerified]
constexpr int kEventFixedFields = 6;

struct PendingOnset {
  int64_t frame;
  double songMs;
  bool mapped;
  float levelDb;
  int64_t extraSkip;  // strummed chords: wait until all strings have sounded
  bool chordWindow;   // a 2+ note group is expected nearby: use the long chord window
};

class AudioCore {
 public:
  AudioCore();
  ~AudioCore();

  // Called by the platform layer once the device streams are open (rates are known).
  void configure(double outRate, double inRate, double minHz, double maxHz);

  // ---- RT thread ----
  void renderOutput(float* out, int32_t frames, int32_t channels, int64_t outFramePos) {
    mixer_.render(out, frames, channels, outFramePos);
  }
  void onInputFrames(const float* mono, int32_t frames, int64_t absFrame) {
    ring_.write(mono, static_cast<size_t>(frames), absFrame);
  }

  // ---- any thread ----
  ClockMap& clock() { return clock_; }

  // ---- control thread (JS-facing) ----
  bool loadStems(const std::vector<StemSpec>& stems, double& durationMs, std::string& error);
  void play();
  void pause() { mixer_.pause(); }
  void seekMs(double ms);
  bool setStemGain(const std::string& id, float gain);
  void setCalibrationOffsetMs(double ms) { clock_.setCalibrationOffsetMs(ms); }
  // Practice A–B loop in song ms; endMs <= startMs clears it.
  void setLoopMs(double startMs, double endMs);
  // Continuous pitch tracking for the tuner screen (cheap: one YIN every ~32 ms).
  void setTunerEnabled(bool on) { tunerEnabled_.store(on, std::memory_order_relaxed); }
  // Chart notes (sorted by time) for target-informed pitch verification.
  void setExpectedNotes(std::vector<ExpectedNote> notes);

  // Platform calls this after a device/route change that re-opened streams. JS watches the
  // counter and reloads the song if the sample rate changed.
  void bumpDeviceGeneration() { deviceGeneration_.fetch_add(1); }

  // `timestampPoller` runs on the analysis thread every ~10 ms (Android: getTimestamp()).
  void startAnalysis(std::function<void()> timestampPoller);
  void stopAnalysis();

  // Fills `dst` per PollField + events. Returns number of doubles written.
  int pollState(double* dst, int capacity);

 private:
  void analysisLoop();
  void processHop(const float* x, int64_t absFrame);
  void resetAnalysis();
  bool historyCopy(int64_t absStart, int n, float* dst) const;
  void verifyExpected(const PendingOnset& p, DetectedNote& ev);
  int largestGroupNear(double songMs);  // size of the biggest expected note group near songMs
  bool verifySingle(double tau, bool havePre, float& score);
  bool verifyChord(const std::vector<double>& taus, const PendingOnset& p);
  void updateTuner();

  ClockMap clock_;
  Mixer mixer_{clock_};
  SpscRingBuffer ring_{1 << 16};  // ~1.4 s @ 48 kHz of headroom for the analysis thread
  SpscQueue<DetectedNote, 256> events_;
  std::mutex controlMutex_;

  // analysis-thread state
  std::unique_ptr<OnsetDetector> onset_;
  std::unique_ptr<PitchDetector> pitch_;
  std::vector<float> history_;  // circular, indexed by absolute input frame
  int64_t historyEnd_ = 0;      // abs frame one past the newest sample
  std::vector<PendingOnset> pending_;
  std::vector<float> scratch_, preScratch_, chordScratch_, chordPreScratch_;
  bool pendingNeedsChordWindow(const PendingOnset& p) const { return p.chordWindow; }
  std::mutex expectedMutex_;
  std::vector<ExpectedNote> expected_;
  uint32_t lastDiscontinuity_ = 0;
  uint32_t nextId_ = 1;
  int64_t pitchSkipFrames_ = 0;
  float meterDb_ = -120.f;
  int tunerHopCounter_ = 0;
  float tunerHistory_[3] = {0, 0, 0};
  int tunerHistoryN_ = 0;
  int tunerSilentHops_ = 0;

  std::thread thread_;
  std::atomic<bool> running_{false};
  std::function<void()> poller_;
  std::atomic<float> inputDb_{-120.f};
  std::atomic<double> durationMs_{0};
  std::atomic<uint32_t> deviceGeneration_{0};
  std::atomic<bool> tunerEnabled_{false};
  std::atomic<float> tunerHz_{0.f};
  std::atomic<float> tunerConfidence_{0.f};
};

}  // namespace soloist
