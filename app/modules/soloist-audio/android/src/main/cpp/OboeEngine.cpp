#include "OboeEngine.h"

#include <android/log.h>

#include <algorithm>
#include <cstdio>

#include "HostClock.h"

#define LOG_TAG "SoloistAudio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace soloist {

oboe::Result OboeEngine::start(const EngineOptions& opts) {
  std::lock_guard<std::mutex> lock(lifecycle_);
  opts_ = opts;
  // Pre-API-26 (OpenSL ES) paths need the device's native values to hit the fast mixer.
  oboe::DefaultStreamValues::SampleRate = opts.defaultSampleRate;
  oboe::DefaultStreamValues::FramesPerBurst = opts.defaultFramesPerBurst;
  const oboe::Result r = openAndStartLocked();
  if (r == oboe::Result::OK) core_.startAnalysis([this] { pollTimestamps(); });
  return r;
}

void OboeEngine::stop() {
  core_.stopAnalysis();
  std::lock_guard<std::mutex> lock(lifecycle_);
  closeLocked();
}

oboe::Result OboeEngine::openAndStartLocked() {
  // ---- output (drives the callback) ----
  oboe::AudioStreamBuilder ob;
  ob.setDirection(oboe::Direction::Output)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::Float)
      ->setFormatConversionAllowed(true)
      ->setChannelCount(oboe::ChannelCount::Stereo)
      ->setChannelConversionAllowed(true)
      ->setUsage(oboe::Usage::Game)
      ->setContentType(oboe::ContentType::Music)
      ->setDataCallback(this)
      ->setErrorCallback(this);
  oboe::Result r = ob.openStream(out_);
  if (r != oboe::Result::OK) {
    LOGE("output open failed: %s", oboe::convertToText(r));
    return r;
  }
  const int32_t sampleRate = out_->getSampleRate();
  const int32_t burst = out_->getFramesPerBurst();
  out_->setBufferSizeInFrames(burst * 2);
  tuner_ = std::make_unique<oboe::LatencyTuner>(*out_);

  // ---- input (read from inside the output callback) ----
  oboe::AudioStreamBuilder ib;
  ib.setDirection(oboe::Direction::Input)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
      ->setSharingMode(oboe::SharingMode::Exclusive)
      ->setFormat(oboe::AudioFormat::Float)
      ->setFormatConversionAllowed(true)
      ->setChannelCount(oboe::ChannelCount::Mono)
      ->setChannelConversionAllowed(true)
      ->setSampleRate(sampleRate)  // match output; Oboe resamples if the mic can't
      ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
      ->setInputPreset(opts_.apiLevel >= 29 ? oboe::InputPreset::VoicePerformance
                                            : oboe::InputPreset::VoiceRecognition);
  r = ib.openStream(in_);
  if (r != oboe::Result::OK) {
    LOGE("input open failed: %s", oboe::convertToText(r));
    closeLocked();
    return r;
  }

  inScratch_.assign(static_cast<size_t>(std::max(burst, 64) * 8), 0.f);
  outFramesWritten_ = 0;
  drainInput_ = true;
  core_.clock().reset();
  core_.configure(sampleRate, in_->getSampleRate(), opts_.minHz, opts_.maxHz);

  // Start input first so data is waiting when the first output callback fires.
  if ((r = in_->requestStart()) != oboe::Result::OK || (r = out_->requestStart()) != oboe::Result::OK) {
    LOGE("start failed: %s", oboe::convertToText(r));
    closeLocked();
    return r;
  }
  running_.store(true);
  LOGI("started: %d Hz, burst %d, api %s, out sharing %s", sampleRate, burst,
       out_->getAudioApi() == oboe::AudioApi::AAudio ? "AAudio" : "OpenSLES",
       out_->getSharingMode() == oboe::SharingMode::Exclusive ? "exclusive" : "shared");
  return oboe::Result::OK;
}

void OboeEngine::closeLocked() {
  running_.store(false);
  if (out_) {
    out_->stop();
    out_->close();
    out_.reset();
  }
  if (in_) {
    in_->stop();
    in_->close();
    in_.reset();
  }
  tuner_.reset();
}

// ======================= REAL-TIME CALLBACK =======================
// No locks, no allocation, no logging, no JNI in here.
oboe::DataCallbackResult OboeEngine::onAudioReady(oboe::AudioStream* stream, void* audioData,
                                                  int32_t numFrames) {
  auto* out = static_cast<float*>(audioData);
  const int32_t channels = stream->getChannelCount();

  if (in_) {
    const int32_t cap = static_cast<int32_t>(inScratch_.size());
    if (drainInput_) {  // throw away input that piled up before output started
      for (int guard = 0; guard < 16; ++guard) {
        auto d = in_->read(inScratch_.data(), cap, 0);
        if (!d || d.value() <= 0) break;
      }
      drainInput_ = false;
    }
    auto rd = in_->read(inScratch_.data(), cap, 0);  // timeout 0 = non-blocking
    if (rd && rd.value() > 0) {
      const int64_t endPos = in_->getFramesRead();
      core_.onInputFrames(inScratch_.data(), rd.value(), endPos - rd.value());
      cbInFramesRead_.store(endPos, std::memory_order_relaxed);
    }
  }

  core_.renderOutput(out, numFrames, channels, outFramesWritten_);
  cbOutFrame_.store(outFramesWritten_, std::memory_order_relaxed);
  cbTimeNs_.store(hostNowNanos(), std::memory_order_relaxed);
  outFramesWritten_ += numFrames;

  if (tuner_) tuner_->tune();  // grows the buffer by one burst only after an underrun
  return oboe::DataCallbackResult::Continue;
}

// Headphones plugged/unplugged, USB interface attached, BT route change...
// Oboe calls this on its own thread after closing the failed stream.
void OboeEngine::onErrorAfterClose(oboe::AudioStream* /*stream*/, oboe::Result error) {
  LOGI("stream error %s — reopening", oboe::convertToText(error));
  std::lock_guard<std::mutex> lock(lifecycle_);
  closeLocked();
  if (openAndStartLocked() == oboe::Result::OK) core_.bumpDeviceGeneration();
}

// Analysis thread, every ~10 ms. try_lock: never block behind a device restart.
void OboeEngine::pollTimestamps() {
  std::unique_lock<std::mutex> lock(lifecycle_, std::try_to_lock);
  if (!lock.owns_lock() || !running_.load() || !out_ || !in_) return;
  const double sr = out_->getSampleRate();

  auto ots = out_->getTimestamp(CLOCK_MONOTONIC);
  if (ots) {
    core_.clock().publishOutputTimestamp(ots.value().position, ots.value().timestamp);
  } else {
    // Fallback: a frame written now is heard after the whole buffer drains.
    const int64_t t = cbTimeNs_.load(std::memory_order_relaxed);
    if (t > 0) {
      core_.clock().publishOutputTimestamp(
          cbOutFrame_.load(std::memory_order_relaxed),
          t + static_cast<int64_t>(out_->getBufferSizeInFrames() * 1e9 / sr));
    }
  }

  auto its = in_->getTimestamp(CLOCK_MONOTONIC);
  if (its) {
    core_.clock().publishInputTimestamp(its.value().position, its.value().timestamp);
  } else {
    const int64_t t = cbTimeNs_.load(std::memory_order_relaxed);
    if (t > 0) {
      core_.clock().publishInputTimestamp(
          cbInFramesRead_.load(std::memory_order_relaxed),
          t - static_cast<int64_t>(in_->getFramesPerBurst() * 1e9 / in_->getSampleRate()));
    }
  }
}

std::string OboeEngine::latencyReportJson() {
  std::lock_guard<std::mutex> lock(lifecycle_);
  if (!out_ || !in_) return "{}";
  auto outLat = out_->calculateLatencyMillis();
  auto inLat = in_->calculateLatencyMillis();
  auto xruns = out_->getXRunCount();
  char buf[640];
  snprintf(buf, sizeof(buf),
           "{\"platform\":\"android\",\"audioApi\":\"%s\",\"sampleRate\":%d,\"inputSampleRate\":%d,"
           "\"framesPerBurst\":%d,\"bufferSizeFrames\":%d,\"outputLatencyMs\":%.2f,"
           "\"inputLatencyMs\":%.2f,\"exclusive\":%s,\"lowLatency\":%s,\"mmap\":%s,\"xruns\":%d}",
           out_->getAudioApi() == oboe::AudioApi::AAudio ? "AAudio" : "OpenSLES", out_->getSampleRate(),
           in_->getSampleRate(), out_->getFramesPerBurst(), out_->getBufferSizeInFrames(),
           outLat ? outLat.value() : -1.0, inLat ? inLat.value() : -1.0,
           out_->getSharingMode() == oboe::SharingMode::Exclusive ? "true" : "false",
           out_->getPerformanceMode() == oboe::PerformanceMode::LowLatency ? "true" : "false",
           oboe::OboeExtensions::isMMapUsed(out_.get()) ? "true" : "false", xruns ? xruns.value() : -1);
  return buf;
}

}  // namespace soloist
