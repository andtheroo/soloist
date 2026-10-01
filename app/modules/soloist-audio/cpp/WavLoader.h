#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace soloist {

// Decoded stem, stored as interleaved stereo int16 to halve memory
// (a 40 s exercise x 4 stems = ~30 MB instead of ~60 MB as float).
struct DecodedAudio {
  std::vector<int16_t> stereo;  // interleaved L/R
  int64_t frames = 0;
  double sampleRate = 0;
};

// Loads PCM16/24/32 or float32 WAV (incl. WAVE_FORMAT_EXTENSIBLE), converts to stereo
// and resamples (cubic Hermite) to `targetRate` so the render callback never resamples.
// MVP scope: the mock API serves WAV. Production: decode AAC/Opus with
// AMediaCodec / AVAudioFile into the same struct.
bool loadWav(const std::string& path, double targetRate, DecodedAudio& out, std::string& error);

}  // namespace soloist
