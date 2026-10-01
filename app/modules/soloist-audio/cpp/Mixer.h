#pragma once
// Real-time stem mixer + transport.
//
// Rules for everything reachable from render():
//   no locks, no allocation, no syscalls, no logging, bounded work.
// Control-thread -> audio-thread communication is via atomics only. Songs are swapped
// with a hazard-pointer handshake so the old bundle is freed off the audio thread.
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "ClockMap.h"
#include "WavLoader.h"

namespace soloist {

struct Stem {
  std::string id;
  DecodedAudio audio;
  std::atomic<float> targetGain{1.f};
  float currentGain = 1.f;  // audio-thread only (for click-free ramps)
};

struct SongBundle {
  std::vector<std::unique_ptr<Stem>> stems;
  int64_t frames = 0;
};

class Mixer {
 public:
  explicit Mixer(ClockMap& clock) : clock_(clock) {}
  ~Mixer();

  // ---- control thread ----
  void setSong(std::unique_ptr<SongBundle> song);  // blocks briefly until RT releases old song
  void play() { wantPlaying_.store(true, std::memory_order_release); }
  void pause() { wantPlaying_.store(false, std::memory_order_release); }
  void seekFrames(int64_t frame) { pendingSeek_.store(frame, std::memory_order_release); }
  bool setStemGain(const std::string& id, float gain);
  // A–B loop for practice mode. end <= start clears the loop. The wrap happens at a
  // callback boundary (≤ one buffer late, ~2–5 ms) — inaudible at bar lines, and ClockMap's
  // previous-anchor logic keeps onsets around the wrap correctly timed.
  void setLoop(int64_t startFrame, int64_t endFrame) {
    loopStart_.store(startFrame, std::memory_order_relaxed);
    loopEnd_.store(endFrame, std::memory_order_release);
  }
  uint32_t loopCount() const { return loopCount_.load(std::memory_order_acquire); }
  bool ended() const { return ended_.load(std::memory_order_acquire); }
  int64_t songFrames() const { return songFrames_.load(std::memory_order_acquire); }

  // ---- audio thread ----
  // `out` is interleaved with `channels` channels. `outFramePos` = device frame index of out[0].
  void render(float* out, int32_t numFrames, int32_t channels, int64_t outFramePos);

 private:
  SongBundle* acquire();
  void release() { hazard_.store(nullptr, std::memory_order_seq_cst); }

  ClockMap& clock_;
  std::atomic<SongBundle*> current_{nullptr};
  std::atomic<SongBundle*> hazard_{nullptr};
  std::atomic<bool> wantPlaying_{false};
  std::atomic<int64_t> pendingSeek_{-1};
  std::atomic<bool> ended_{false};
  std::atomic<int64_t> songFrames_{0};
  std::atomic<int64_t> loopStart_{-1};
  std::atomic<int64_t> loopEnd_{-1};
  std::atomic<uint32_t> loopCount_{0};

  // audio-thread state
  int64_t songFrame_ = 0;
  float transportGain_ = 0.f;  // 0 = paused, 1 = playing; ramped to avoid clicks
  static constexpr float kTransportRampPerFrame = 1.f / 256.f;  // ~5 ms at 48 kHz
};

}  // namespace soloist
