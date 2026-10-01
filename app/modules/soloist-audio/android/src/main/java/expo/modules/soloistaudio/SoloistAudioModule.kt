package expo.modules.soloistaudio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import org.json.JSONObject

class InitOptions : Record {
  @Field val minFrequencyHz: Double = 70.0     // guitar low E ≈ 82 Hz; bass: 38
  @Field val maxFrequencyHz: Double = 1400.0
  @Field val calibrationOffsetMs: Double = 0.0
}

class StemSpec : Record {
  @Field val id: String = ""
  @Field val uri: String = ""                  // file:// URI from expo-file-system
  @Field val gain: Double = 1.0
}

class MicPermissionException : CodedException("ERR_MIC_PERMISSION", "Microphone permission not granted", null)
class AudioStartException(code: Int) : CodedException("ERR_AUDIO_START", "Oboe failed to start (oboe::Result $code)", null)
class LoadException(msg: String) : CodedException("ERR_LOAD", msg, null)

class SoloistAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("SoloistAudio")

    AsyncFunction("requestMicPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions, promise, Manifest.permission.RECORD_AUDIO
      )
    }

    AsyncFunction("initialize") { opts: InitOptions ->
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw MicPermissionException()
      }
      val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val sr = am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 48000
      val burst = am.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() ?: 192
      val result = NativeBridge.start(Build.VERSION.SDK_INT, sr, burst, opts.minFrequencyHz, opts.maxFrequencyHz)
      if (result != 0) throw AudioStartException(result)
      NativeBridge.setCalibrationOffsetMs(opts.calibrationOffsetMs)
      latencyReport(am)
    }

    AsyncFunction("loadSong") { stems: List<StemSpec> ->
      val paths = stems.map { Uri.parse(it.uri).path ?: it.uri }.toTypedArray()
      val duration = NativeBridge.loadStems(
        stems.map { it.id }.toTypedArray(), paths, stems.map { it.gain.toFloat() }.toFloatArray()
      )
      if (duration < 0) throw LoadException(NativeBridge.lastError())
      mapOf("durationMs" to duration)
    }

    // Synchronous (JSI) functions — cheap, called from the JS thread.
    Function("play") { NativeBridge.play() }
    Function("pause") { NativeBridge.pause() }
    Function("seek") { ms: Double -> NativeBridge.seek(ms) }
    Function("setStemGain") { id: String, gain: Double -> NativeBridge.setStemGain(id, gain.toFloat()) }
    Function("setCalibrationOffsetMs") { ms: Double -> NativeBridge.setCalibrationOffsetMs(ms) }
    Function("setExpectedNotes") { flat: DoubleArray -> NativeBridge.setExpectedNotes(flat) }
    Function("setLoop") { startMs: Double, endMs: Double -> NativeBridge.setLoop(startMs, endMs) }
    Function("setTunerEnabled") { on: Boolean -> NativeBridge.setTunerEnabled(on) }
    Function("pollState") { NativeBridge.pollState() }

    AsyncFunction("getLatencyReport") {
      latencyReport(context.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
    }

    AsyncFunction("shutdown") { NativeBridge.stop() }

    OnActivityEntersBackground { NativeBridge.pause() }
    OnDestroy { NativeBridge.stop() }
  }

  private fun latencyReport(am: AudioManager): Map<String, Any?> {
    val json = JSONObject(NativeBridge.latencyReport())
    val out = mutableMapOf<String, Any?>()
    json.keys().forEach { k -> out[k] = json.get(k) }
    val pm = context.packageManager
    out["featureLowLatency"] = pm.hasSystemFeature(PackageManager.FEATURE_AUDIO_LOW_LATENCY)
    out["featurePro"] = pm.hasSystemFeature(PackageManager.FEATURE_AUDIO_PRO)
    // Bluetooth adds 100–300 ms of output latency; the UI warns and recommends wired/USB.
    out["bluetoothOutput"] = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
      it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
    }
    out["wiredOrUsbOutput"] = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
      it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
        it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
    }
    return out
  }
}
