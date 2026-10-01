// JNI surface for NativeBridge.kt. Thin by design: every call is O(1) or a control
// operation; nothing here runs on the audio thread.
#include <jni.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "AudioCore.h"
#include "OboeEngine.h"

using namespace soloist;

namespace {
std::mutex gMutex;  // serialises lifecycle/control calls
// shared_ptr + atomic_load so the per-frame pollState() (JS thread, lock-free) can never
// observe a core that stop() is destroying on another thread.
std::shared_ptr<AudioCore> gCore;
std::unique_ptr<OboeEngine> gEngine;
std::string gLastError;

std::shared_ptr<AudioCore> core() { return std::atomic_load(&gCore); }

std::string toString(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c);
  env->ReleaseStringUTFChars(s, c);
  return out;
}
}  // namespace

extern "C" {

JNIEXPORT jint JNICALL Java_expo_modules_soloistaudio_NativeBridge_start(
    JNIEnv*, jobject, jint apiLevel, jint defaultSampleRate, jint defaultBurst, jdouble minHz, jdouble maxHz) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (gEngine) return 0;  // idempotent
  auto c = std::make_shared<AudioCore>();
  gEngine = std::make_unique<OboeEngine>(*c);
  std::atomic_store(&gCore, c);
  EngineOptions opts{apiLevel, defaultSampleRate, defaultBurst, minHz, maxHz};
  const oboe::Result r = gEngine->start(opts);
  if (r != oboe::Result::OK) {
    gEngine.reset();
    std::atomic_store(&gCore, std::shared_ptr<AudioCore>());
  }
  return static_cast<jint>(r);
}

JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_stop(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (gEngine) gEngine->stop();
  gEngine.reset();
  std::atomic_store(&gCore, std::shared_ptr<AudioCore>());
}

JNIEXPORT jdouble JNICALL Java_expo_modules_soloistaudio_NativeBridge_loadStems(
    JNIEnv* env, jobject, jobjectArray ids, jobjectArray paths, jfloatArray gains) {
  std::lock_guard<std::mutex> lock(gMutex);
  auto c = core();
  if (!c) { gLastError = "engine not started"; return -1; }
  const jsize n = env->GetArrayLength(ids);
  std::vector<StemSpec> specs(static_cast<size_t>(n));
  jfloat* g = env->GetFloatArrayElements(gains, nullptr);
  for (jsize i = 0; i < n; ++i) {
    specs[i].id = toString(env, static_cast<jstring>(env->GetObjectArrayElement(ids, i)));
    specs[i].path = toString(env, static_cast<jstring>(env->GetObjectArrayElement(paths, i)));
    specs[i].gain = g[i];
  }
  env->ReleaseFloatArrayElements(gains, g, JNI_ABORT);
  double durationMs = 0;
  if (!c->loadStems(specs, durationMs, gLastError)) return -1;
  return durationMs;
}

JNIEXPORT jstring JNICALL Java_expo_modules_soloistaudio_NativeBridge_lastError(JNIEnv* env, jobject) {
  return env->NewStringUTF(gLastError.c_str());
}

JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_play(JNIEnv*, jobject) {
  if (auto c = core()) c->play();
}
JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_pause(JNIEnv*, jobject) {
  if (auto c = core()) c->pause();
}
JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_seek(JNIEnv*, jobject, jdouble ms) {
  if (auto c = core()) c->seekMs(ms);
}
JNIEXPORT jboolean JNICALL Java_expo_modules_soloistaudio_NativeBridge_setStemGain(
    JNIEnv* env, jobject, jstring id, jfloat gain) {
  auto c = core();
  return c && c->setStemGain(toString(env, id), gain);
}
JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_setCalibrationOffsetMs(
    JNIEnv*, jobject, jdouble ms) {
  if (auto c = core()) c->setCalibrationOffsetMs(ms);
}

JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_setLoop(
    JNIEnv*, jobject, jdouble startMs, jdouble endMs) {
  if (auto c = core()) c->setLoopMs(startMs, endMs);
}
JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_setTunerEnabled(
    JNIEnv*, jobject, jboolean on) {
  if (auto c = core()) c->setTunerEnabled(on == JNI_TRUE);
}

// Flat [timeMs, midi, timeMs, midi, ...]
JNIEXPORT void JNICALL Java_expo_modules_soloistaudio_NativeBridge_setExpectedNotes(
    JNIEnv* env, jobject, jdoubleArray flat) {
  auto c = core();
  if (!c) return;
  const jsize n = env->GetArrayLength(flat);
  std::vector<ExpectedNote> notes(static_cast<size_t>(n / 2));
  jdouble* d = env->GetDoubleArrayElements(flat, nullptr);
  for (jsize i = 0; i + 1 < n; i += 2) notes[i / 2] = {d[i], static_cast<float>(d[i + 1])};
  env->ReleaseDoubleArrayElements(flat, d, JNI_ABORT);
  c->setExpectedNotes(std::move(notes));
}

// Called once per UI frame from the JS thread via a synchronous Expo Function (JSI).
JNIEXPORT jdoubleArray JNICALL Java_expo_modules_soloistaudio_NativeBridge_pollState(JNIEnv* env, jobject) {
  thread_local std::vector<double> buf(kHeaderSize + 64 * (kEventFixedFields + 6));
  auto c = core();
  const int n = c ? c->pollState(buf.data(), static_cast<int>(buf.size())) : 0;
  jdoubleArray arr = env->NewDoubleArray(n);
  if (n > 0) env->SetDoubleArrayRegion(arr, 0, n, buf.data());
  return arr;
}

JNIEXPORT jstring JNICALL Java_expo_modules_soloistaudio_NativeBridge_latencyReport(JNIEnv* env, jobject) {
  std::lock_guard<std::mutex> lock(gMutex);
  return env->NewStringUTF(gEngine ? gEngine->latencyReportJson().c_str() : "{}");
}

}  // extern "C"
