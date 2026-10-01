#pragma once
// Lock-free single-producer / single-consumer float ring buffer.
//
// Producer: the real-time audio callback (mic input). Consumer: the analysis thread.
// Never blocks, never allocates after construction. Each sample carries an implicit
// *absolute device frame index* so downstream timing math stays exact even when the
// producer has to drop data (overflow) or the device restarts.
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <vector>

namespace soloist {

class SpscRingBuffer {
 public:
  explicit SpscRingBuffer(size_t capacityPow2)
      : data_(capacityPow2, 0.f), mask_(capacityPow2 - 1) {
    assert(capacityPow2 >= 2 && (capacityPow2 & (capacityPow2 - 1)) == 0);
  }

  // Producer only. `absFrame` is the device frame index of src[0].
  // Returns frames written; excess frames are dropped rather than blocking.
  size_t write(const float* src, size_t n, int64_t absFrame) {
    const uint64_t w = writeIdx_.load(std::memory_order_relaxed);
    const uint64_t r = readIdx_.load(std::memory_order_acquire);

    // Keep the ring-index -> device-frame mapping correct across gaps.
    const int64_t expectedOffset = absFrame - static_cast<int64_t>(w);
    if (expectedOffset != frameOffset_.load(std::memory_order_relaxed)) {
      frameOffset_.store(expectedOffset, std::memory_order_relaxed);
      discontinuities_.fetch_add(1, std::memory_order_relaxed);
    }

    const size_t freeSpace = data_.size() - static_cast<size_t>(w - r);
    const size_t toWrite = std::min(n, freeSpace);
    if (toWrite < n) overflows_.fetch_add(1, std::memory_order_relaxed);

    const size_t start = static_cast<size_t>(w) & mask_;
    const size_t first = std::min(toWrite, data_.size() - start);
    std::memcpy(&data_[start], src, first * sizeof(float));
    if (toWrite > first) std::memcpy(&data_[0], src + first, (toWrite - first) * sizeof(float));
    writeIdx_.store(w + toWrite, std::memory_order_release);
    return toWrite;
  }

  size_t availableToRead() const {
    return static_cast<size_t>(writeIdx_.load(std::memory_order_acquire) -
                               readIdx_.load(std::memory_order_relaxed));
  }

  // Consumer only. Reads exactly n frames if available. `absFrame` receives the device
  // frame index of dst[0]; `discontinuityCount` lets the consumer reset its DSP state.
  bool read(float* dst, size_t n, int64_t& absFrame, uint32_t& discontinuityCount) {
    const uint64_t r = readIdx_.load(std::memory_order_relaxed);
    const uint64_t w = writeIdx_.load(std::memory_order_acquire);
    if (w - r < n) return false;
    const size_t start = static_cast<size_t>(r) & mask_;
    const size_t first = std::min(n, data_.size() - start);
    std::memcpy(dst, &data_[start], first * sizeof(float));
    if (n > first) std::memcpy(dst + first, &data_[0], (n - first) * sizeof(float));
    absFrame = static_cast<int64_t>(r) + frameOffset_.load(std::memory_order_relaxed);
    discontinuityCount = discontinuities_.load(std::memory_order_relaxed);
    readIdx_.store(r + n, std::memory_order_release);
    return true;
  }

  uint32_t overflowCount() const { return overflows_.load(std::memory_order_relaxed); }

 private:
  std::vector<float> data_;
  const size_t mask_;
  alignas(64) std::atomic<uint64_t> writeIdx_{0};
  alignas(64) std::atomic<uint64_t> readIdx_{0};
  std::atomic<int64_t> frameOffset_{0};
  std::atomic<uint32_t> discontinuities_{0};
  std::atomic<uint32_t> overflows_{0};
};

// Fixed-capacity lock-free SPSC queue of trivially-copyable structs (detected notes).
template <typename T, size_t CapacityPow2>
class SpscQueue {
  static_assert((CapacityPow2 & (CapacityPow2 - 1)) == 0, "capacity must be a power of two");

 public:
  bool push(const T& v) {
    const uint64_t w = w_.load(std::memory_order_relaxed);
    if (w - r_.load(std::memory_order_acquire) >= CapacityPow2) return false;
    buf_[w & (CapacityPow2 - 1)] = v;
    w_.store(w + 1, std::memory_order_release);
    return true;
  }
  bool pop(T& out) {
    const uint64_t r = r_.load(std::memory_order_relaxed);
    if (r == w_.load(std::memory_order_acquire)) return false;
    out = buf_[r & (CapacityPow2 - 1)];
    r_.store(r + 1, std::memory_order_release);
    return true;
  }

 private:
  T buf_[CapacityPow2]{};
  alignas(64) std::atomic<uint64_t> w_{0};
  alignas(64) std::atomic<uint64_t> r_{0};
};

}  // namespace soloist
