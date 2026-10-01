#include "WavLoader.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>

namespace soloist {
namespace {

uint32_t rd32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (uint32_t(p[3]) << 24); }
uint16_t rd16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

float sampleAt(const uint8_t* p, int bits, bool isFloat) {
  if (isFloat && bits == 32) {
    float f;
    std::memcpy(&f, p, 4);
    return f;
  }
  switch (bits) {
    case 16: return static_cast<int16_t>(rd16(p)) / 32768.f;
    case 24: {
      int32_t v = (p[0] << 8) | (p[1] << 16) | (p[2] << 24);
      return (v >> 8) / 8388608.f;
    }
    case 32: return static_cast<int32_t>(rd32(p)) / 2147483648.f;
    default: return 0.f;
  }
}

inline int16_t toI16(float v) {
  v = std::clamp(v, -1.f, 1.f);
  return static_cast<int16_t>(std::lrintf(v * 32767.f));
}

// Cubic Hermite (Catmull-Rom) interpolation — cheap, far better than linear for music.
inline float hermite(float xm1, float x0, float x1, float x2, float t) {
  const float c = (x1 - xm1) * 0.5f;
  const float v = x0 - x1;
  const float w = c + v;
  const float a = w + v + (x2 - x0) * 0.5f;
  const float b = w + a;
  return (((a * t) - b) * t + c) * t + x0;
}

}  // namespace

bool loadWav(const std::string& path, double targetRate, DecodedAudio& out, std::string& error) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    error = "cannot open " + path;
    return false;
  }
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) || std::memcmp(bytes.data() + 8, "WAVE", 4)) {
    error = "not a RIFF/WAVE file";
    return false;
  }

  int channels = 0, bits = 0;
  uint32_t srcRate = 0;
  bool isFloat = false;
  const uint8_t* data = nullptr;
  size_t dataSize = 0;

  size_t pos = 12;
  while (pos + 8 <= bytes.size()) {
    const uint8_t* ck = bytes.data() + pos;
    const uint32_t size = rd32(ck + 4);
    const uint8_t* body = ck + 8;
    if (!std::memcmp(ck, "fmt ", 4) && size >= 16) {
      uint16_t fmt = rd16(body);
      channels = rd16(body + 2);
      srcRate = rd32(body + 4);
      bits = rd16(body + 14);
      if (fmt == 0xFFFE && size >= 40) fmt = rd16(body + 24);  // EXTENSIBLE subformat GUID
      isFloat = (fmt == 3);
      if (fmt != 1 && fmt != 3) {
        error = "unsupported WAV format tag";
        return false;
      }
    } else if (!std::memcmp(ck, "data", 4)) {
      data = body;
      dataSize = std::min<size_t>(size, bytes.size() - (pos + 8));
    }
    pos += 8 + size + (size & 1);  // chunks are word-aligned
  }
  if (!data || channels <= 0 || bits == 0 || srcRate == 0) {
    error = "missing fmt or data chunk";
    return false;
  }

  const int bytesPerSample = bits / 8;
  const size_t srcFrames = dataSize / (bytesPerSample * channels);

  // 1) decode to float stereo
  std::vector<float> L(srcFrames), R(srcFrames);
  for (size_t i = 0; i < srcFrames; ++i) {
    const uint8_t* fp = data + i * bytesPerSample * channels;
    const float l = sampleAt(fp, bits, isFloat);
    const float r = channels > 1 ? sampleAt(fp + bytesPerSample, bits, isFloat) : l;
    L[i] = l;
    R[i] = r;
  }

  // 2) resample to device rate so the RT thread does zero resampling work
  const double ratio = srcRate / targetRate;
  const int64_t dstFrames = static_cast<int64_t>(std::floor(srcFrames / ratio));
  out.stereo.resize(static_cast<size_t>(dstFrames) * 2);
  auto at = [&](const std::vector<float>& ch, int64_t i) {
    return ch[static_cast<size_t>(std::clamp<int64_t>(i, 0, static_cast<int64_t>(srcFrames) - 1))];
  };
  for (int64_t i = 0; i < dstFrames; ++i) {
    const double srcPos = i * ratio;
    const int64_t i0 = static_cast<int64_t>(srcPos);
    const float t = static_cast<float>(srcPos - i0);
    if (srcRate == static_cast<uint32_t>(targetRate)) {
      out.stereo[2 * i] = toI16(L[i]);
      out.stereo[2 * i + 1] = toI16(R[i]);
    } else {
      out.stereo[2 * i] = toI16(hermite(at(L, i0 - 1), at(L, i0), at(L, i0 + 1), at(L, i0 + 2), t));
      out.stereo[2 * i + 1] = toI16(hermite(at(R, i0 - 1), at(R, i0), at(R, i0 + 1), at(R, i0 + 2), t));
    }
  }
  out.frames = dstFrames;
  out.sampleRate = targetRate;
  return true;
}

}  // namespace soloist
