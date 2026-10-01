#pragma once
// Single source of truth for "now" in the audio clock domain.
//
// This MUST match the timebase used by (a) the platform audio timestamps and
// (b) the UI frame timestamps that Reanimated hands to useFrameCallback, otherwise
// the scrolling tab and the audio will drift apart.
//
//  Android: AAudio getTimestamp(CLOCK_MONOTONIC) and Choreographer frameTimeNanos
//           are both CLOCK_MONOTONIC.
//  iOS:     AudioTimeStamp.mHostTime and CADisplayLink.timestamp are both
//           mach_absolute_time. NOTE: std::chrono::steady_clock on Apple is
//           mach_continuous_time (keeps counting during sleep) and diverges from
//           mach_absolute_time after the device has slept — so never use it here.
#include <cstdint>

#if defined(__APPLE__)
#include <mach/mach_time.h>
#else
#include <time.h>
#endif

namespace soloist {

#if defined(__APPLE__)
inline const mach_timebase_info_data_t& machTimebase() {
  static mach_timebase_info_data_t tb = [] {
    mach_timebase_info_data_t t{};
    mach_timebase_info(&t);
    return t;
  }();
  return tb;
}
inline int64_t hostTicksToNanos(uint64_t ticks) {
  const auto& tb = machTimebase();
  return static_cast<int64_t>((static_cast<__uint128_t>(ticks) * tb.numer) / tb.denom);
}
inline int64_t hostNowNanos() { return hostTicksToNanos(mach_absolute_time()); }
#else
inline int64_t hostNowNanos() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1'000'000'000LL + ts.tv_nsec;
}
#endif

}  // namespace soloist
