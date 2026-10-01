package expo.modules.soloistaudio

/** JNI surface of libsoloistaudio.so (see android/src/main/cpp/jni_bridge.cpp). */
internal object NativeBridge {
  init {
    System.loadLibrary("soloistaudio")
  }

  /** @return 0 on success, otherwise an oboe::Result code. */
  external fun start(apiLevel: Int, defaultSampleRate: Int, defaultBurst: Int, minHz: Double, maxHz: Double): Int
  external fun stop()

  /** @return song duration in ms, or -1 (see [lastError]). */
  external fun loadStems(ids: Array<String>, paths: Array<String>, gains: FloatArray): Double
  external fun lastError(): String

  external fun play()
  external fun pause()
  external fun seek(ms: Double)
  external fun setStemGain(id: String, gain: Float): Boolean
  external fun setCalibrationOffsetMs(ms: Double)
  external fun setExpectedNotes(flatTimeMidi: DoubleArray)
  external fun setLoop(startMs: Double, endMs: Double)
  external fun setTunerEnabled(on: Boolean)

  /** Header + detected-note events; layout documented in SoloistAudio.types.ts. */
  external fun pollState(): DoubleArray
  external fun latencyReport(): String
}
