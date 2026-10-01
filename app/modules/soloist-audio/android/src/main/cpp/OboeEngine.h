#pragma once
// Android device layer: one full-duplex Oboe pair feeding the shared AudioCore.
//
// Design choices that matter for latency:
//  * Output stream: LowLatency + Exclusive (MMAP when the device supports it), Float,
//    device-native sample rate (never force 44.1k: resampling knocks you off the fast path).
//  * Buffer = 2 bursts (double buffering), grown by LatencyTuner only if we underrun.
//  * Input stream has NO callback; the output callback drains it non-blocking
//    (timeout 0). One RT thread, no cross-stream drift, same pattern as
//    oboe::FullDuplexStream.
//  * Input preset VoicePerformance (API 29+, designed for live monitoring, no AGC/NS)
//    else VoiceRecognition (minimal processing, widely on the fast path).
//  * Hardware timestamps (getTimestamp(CLOCK_MONOTONIC)) are polled from the analysis
//    thread, never from the callback.
#include <oboe/Oboe.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "AudioCore.h"

namespace soloist {

struct EngineOptions {
  int32_t apiLevel = 26;
  int32_t defaultSampleRate = 48000;   // AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE
  int32_t defaultFramesPerBurst = 192; // AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER
  double minHz = 70.0;
  double maxHz = 1400.0;
};

class OboeEngine : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
 public:
  explicit OboeEngine(AudioCore& core) : core_(core) {}
  ~OboeEngine() override { stop(); }

  oboe::Result start(const EngineOptions& opts);
  void stop();
  std::string latencyReportJson();

  // oboe callbacks
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) override;
  void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) override;

 private:
  oboe::Result openAndStartLocked();
  void closeLocked();
  void pollTimestamps();  // analysis thread

  AudioCore& core_;
  EngineOptions opts_;
  std::mutex lifecycle_;
  std::shared_ptr<oboe::AudioStream> out_;
  std::shared_ptr<oboe::AudioStream> in_;
  std::unique_ptr<oboe::LatencyTuner> tuner_;

  // audio-thread state
  std::vector<float> inScratch_;
  int64_t outFramesWritten_ = 0;
  bool drainInput_ = true;

  // callback -> poller fallback timing (when getTimestamp() is unavailable, e.g. OpenSL ES)
  std::atomic<int64_t> cbOutFrame_{0}, cbTimeNs_{0}, cbInFramesRead_{0};
  std::atomic<bool> running_{false};
};

}  // namespace soloist
