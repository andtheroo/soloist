#pragma once
// ClockMap: converts between the three timelines that matter for grading.
//
//   input device frames  --(input timestamp)-->  host nanoseconds
//   host nanoseconds     --(output timestamp)--> output device frames
//   output device frames --(song anchor)------>  song frames / song ms
//
// Because every mic sample is mapped through *measured* hardware timestamps into the
// song timeline, grading precision does not depend on how large the round-trip latency
// is — only on how accurately the platform reports it. A per-device calibration offset
// (measured once, see src/audio/calibration.ts) absorbs whatever the timestamps miss
// (acoustic path, DSP in the codec, driver fibs).
#include <atomic>
#include <cstdint>
#include <cstring>
#include <type_traits>

namespace soloist {

// Lock-free seqlock for small POD structs. One writer, many readers, no UB:
// payload is stored as atomic 64-bit words.
template <typename T>
class SeqLock {
  static_assert(std::is_trivially_copyable_v<T>, "SeqLock payload must be trivially copyable");
  static constexpr size_t kWords = (sizeof(T) + 7) / 8;

 public:
  void store(const T& v) {
    uint64_t tmp[kWords] = {};
    std::memcpy(tmp, &v, sizeof(T));
    const uint32_t s = seq_.load(std::memory_order_relaxed);
    seq_.store(s + 1, std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_release);
    for (size_t i = 0; i < kWords; ++i) words_[i].store(tmp[i], std::memory_order_relaxed);
    seq_.store(s + 2, std::memory_order_release);
  }
  T load() const {
    uint64_t tmp[kWords];
    uint32_t s0, s1;
    do {
      s0 = seq_.load(std::memory_order_acquire);
      for (size_t i = 0; i < kWords; ++i) tmp[i] = words_[i].load(std::memory_order_relaxed);
      std::atomic_thread_fence(std::memory_order_acquire);
      s1 = seq_.load(std::memory_order_relaxed);
    } while ((s0 & 1u) || s0 != s1);
    T v;
    std::memcpy(&v, tmp, sizeof(T));
    return v;
  }

 private:
  std::atomic<uint32_t> seq_{0};
  std::atomic<uint64_t> words_[kWords]{};
};

struct FrameTime {
  int64_t frame = 0;   // device frame position
  int64_t timeNs = 0;  // host time at which that frame hit the DAC / left the ADC
  int32_t valid = 0;
};

struct SongAnchor {
  int64_t outFrame = 0;   // output device frame at the start of a render callback
  int64_t songFrame = 0;  // song frame rendered at that output frame
  int32_t playing = 0;    // transport advancing during that callback
  int32_t valid = 0;
  // The anchor that was current before the last discontinuity (seek, loop wrap, pause,
  // resume). Frames still queued in the device buffer from before the jump must be
  // mapped with it — otherwise onsets right around a loop point land in the wrong place.
  int64_t prevOutFrame = 0;
  int64_t prevSongFrame = 0;
  int32_t prevPlaying = 0;
  int32_t hasPrev = 0;
  // Output frame of the first callback after that discontinuity. Only audio heard before
  // this frame belongs to the previous anchor. (The anchor itself is republished every
  // callback, so its outFrame is always ahead of what is audible — it can't be the boundary.)
  int64_t jumpOutFrame = 0;
};

class ClockMap {
 public:
  void setRates(double outRate, double inRate) {
    outRate_ = outRate;
    inRate_ = inRate;
  }
  double outRate() const { return outRate_; }
  double inRate() const { return inRate_; }

  void publishOutputTimestamp(int64_t frame, int64_t timeNs) { out_.store({frame, timeNs, 1}); }
  void publishInputTimestamp(int64_t frame, int64_t timeNs) { in_.store({frame, timeNs, 1}); }
  // Called by the mixer once per render callback (single writer: the audio thread).
  void publishAnchor(int64_t outFrame, int64_t songFrame, bool playing) {
    SongAnchor a = lastAnchor_;  // writer-private copy, no seqlock read needed
    const bool continuous = a.valid && a.playing && playing &&
                            songFrame == a.songFrame + (outFrame - a.outFrame);
    if (!continuous && a.valid && (a.playing != (playing ? 1 : 0) || a.playing)) {
      a.prevOutFrame = a.outFrame;
      a.prevSongFrame = a.songFrame;
      a.prevPlaying = a.playing;
      a.hasPrev = 1;
      a.jumpOutFrame = outFrame;
    }
    a.outFrame = outFrame;
    a.songFrame = songFrame;
    a.playing = playing ? 1 : 0;
    a.valid = 1;
    lastAnchor_ = a;
    anchor_.store(a);
  }
  void setCalibrationOffsetMs(double ms) { calibrationMs_.store(ms, std::memory_order_relaxed); }
  double calibrationOffsetMs() const { return calibrationMs_.load(std::memory_order_relaxed); }
  void reset() {  // only while the audio thread is stopped
    out_.store({});
    in_.store({});
    anchor_.store({});
    lastAnchor_ = {};
  }

  // Host time at which a given input frame was captured.
  bool inputFrameToHostNs(int64_t inFrame, int64_t& hostNs) const {
    const FrameTime t = in_.load();
    if (!t.valid) return false;
    hostNs = t.timeNs + static_cast<int64_t>((inFrame - t.frame) * 1e9 / inRate_);
    return true;
  }

  // Song position (ms) that was *audible* at host time `hostNs`.
  bool songMsAtHostNs(int64_t hostNs, double& songMs, bool& playing) const {
    const FrameTime o = out_.load();
    const SongAnchor a = anchor_.load();
    if (!o.valid || !a.valid) return false;
    playing = a.playing != 0;
    const double outFrameAtT = o.frame + (hostNs - o.timeNs) * outRate_ / 1e9;
    // Audio heard at T that was written before the last discontinuity (seek, loop wrap,
    // pause, resume) still belongs to the anchor that was valid back then.
    int64_t refOut = a.outFrame, refSong = a.songFrame;
    bool refPlaying = playing;
    if (a.hasPrev && outFrameAtT < a.jumpOutFrame) {
      refOut = a.prevOutFrame;
      refSong = a.prevSongFrame;
      refPlaying = a.prevPlaying != 0;
    }
    const double songFrame = refPlaying ? refSong + (outFrameAtT - refOut) : static_cast<double>(refSong);
    songMs = songFrame * 1000.0 / outRate_;
    return true;
  }

  // THE key conversion for grading: which song position was the user hearing when this
  // mic sample was captured? (minus the calibrated residual offset)
  bool inputFrameToSongMs(int64_t inFrame, double& songMs) const {
    int64_t hostNs;
    bool playing;
    if (!inputFrameToHostNs(inFrame, hostNs)) return false;
    if (!songMsAtHostNs(hostNs, songMs, playing)) return false;
    songMs -= calibrationOffsetMs();
    return true;
  }

 private:
  SeqLock<FrameTime> out_;
  SeqLock<FrameTime> in_;
  SeqLock<SongAnchor> anchor_;
  SongAnchor lastAnchor_;  // audio-thread private
  double outRate_ = 48000.0;
  double inRate_ = 48000.0;
  std::atomic<double> calibrationMs_{0.0};
};

}  // namespace soloist
