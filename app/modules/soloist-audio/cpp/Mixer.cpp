#include "Mixer.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

namespace soloist {

Mixer::~Mixer() { delete current_.exchange(nullptr); }

void Mixer::setSong(std::unique_ptr<SongBundle> song) {
  wantPlaying_.store(false);
  const int64_t frames = song ? song->frames : 0;
  SongBundle* old = current_.exchange(song.release(), std::memory_order_seq_cst);
  // Hazard-pointer wait: the RT thread publishes the bundle it is using. Once it no
  // longer points at `old`, nobody can touch it. Bounded wait: if the stream is stopped
  // the hazard is already null.
  for (int i = 0; i < 500 && hazard_.load(std::memory_order_seq_cst) == old && old; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  delete old;
  songFrames_.store(frames, std::memory_order_release);
  setLoop(-1, -1);
  pendingSeek_.store(0, std::memory_order_release);
  ended_.store(false, std::memory_order_release);
}

bool Mixer::setStemGain(const std::string& id, float gain) {
  SongBundle* s = current_.load(std::memory_order_acquire);  // control thread owns lifetime
  if (!s) return false;
  for (auto& stem : s->stems) {
    if (stem->id == id) {
      stem->targetGain.store(gain, std::memory_order_relaxed);
      return true;
    }
  }
  return false;
}

SongBundle* Mixer::acquire() {
  SongBundle* p = current_.load(std::memory_order_seq_cst);
  for (int tries = 0; tries < 4; ++tries) {  // bounded: a swap is a rare event
    hazard_.store(p, std::memory_order_seq_cst);
    SongBundle* again = current_.load(std::memory_order_seq_cst);
    if (again == p) return p;
    p = again;
  }
  hazard_.store(p, std::memory_order_seq_cst);
  return p;
}

void Mixer::render(float* out, int32_t numFrames, int32_t channels, int64_t outFramePos) {
  std::memset(out, 0, sizeof(float) * static_cast<size_t>(numFrames) * channels);
  SongBundle* song = acquire();

  const int64_t seek = pendingSeek_.exchange(-1, std::memory_order_acq_rel);
  if (seek >= 0) {
    songFrame_ = seek;
    transportGain_ = 0.f;  // fade back in after a jump
    ended_.store(false, std::memory_order_release);
  }

  // Practice loop: wrap at the callback boundary.
  const int64_t le = loopEnd_.load(std::memory_order_acquire);
  const int64_t ls = loopStart_.load(std::memory_order_relaxed);
  const bool looping = ls >= 0 && le > ls;
  if (looping && songFrame_ >= le) {
    songFrame_ = ls;
    loopCount_.fetch_add(1, std::memory_order_release);
  }

  const bool want = wantPlaying_.load(std::memory_order_acquire) && song;
  const bool advancing = want || transportGain_ > 0.f;
  // Anchor = "output frame X carries song frame Y". Published every callback; ClockMap
  // turns it (plus the hardware timestamp) into an exact audible song position.
  clock_.publishAnchor(outFramePos, songFrame_, advancing && want);

  if (!advancing || !song) {
    release();
    return;
  }

  const int64_t start = songFrame_;
  for (int32_t i = 0; i < numFrames; ++i) {
    transportGain_ = want ? std::min(1.f, transportGain_ + kTransportRampPerFrame)
                          : std::max(0.f, transportGain_ - kTransportRampPerFrame);
    const int64_t sf = start + i;
    if (sf >= song->frames) break;
    float l = 0.f, r = 0.f;
    for (auto& stemPtr : song->stems) {
      Stem& st = *stemPtr;
      if (sf >= st.audio.frames) continue;
      const float g = st.currentGain;
      l += st.audio.stereo[2 * sf] * (g / 32768.f);
      r += st.audio.stereo[2 * sf + 1] * (g / 32768.f);
    }
    l *= transportGain_;
    r *= transportGain_;
    if (channels == 1) {
      out[i] = 0.5f * (l + r);
    } else {
      out[i * channels] = l;
      out[i * channels + 1] = r;
    }
  }

  // Per-block gain smoothing (one step per callback ≈ 2–5 ms; inaudible zipper-wise).
  for (auto& stemPtr : song->stems) {
    const float t = stemPtr->targetGain.load(std::memory_order_relaxed);
    stemPtr->currentGain += (t - stemPtr->currentGain) * 0.35f;
  }

  if (want || transportGain_ > 0.f) songFrame_ += numFrames;
  if (songFrame_ >= song->frames && !(looping && le <= song->frames)) {
    songFrame_ = song->frames;
    transportGain_ = 0.f;
    wantPlaying_.store(false, std::memory_order_release);
    ended_.store(true, std::memory_order_release);
  }
  release();
}

}  // namespace soloist
