import AVFoundation
import ExpoModulesCore

struct InitOptions: Record {
  @Field var minFrequencyHz: Double = 70
  @Field var maxFrequencyHz: Double = 1400
  @Field var calibrationOffsetMs: Double = 0
}

struct StemSpec: Record {
  @Field var id: String = ""
  @Field var uri: String = ""  // file:// URI from expo-file-system
  @Field var gain: Double = 1
}

public class SoloistAudioModule: Module {
  private let engine = SoloistAudioEngine()

  public func definition() -> ModuleDefinition {
    Name("SoloistAudio")

    AsyncFunction("requestMicPermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        promise.resolve([
          "granted": granted,
          "status": granted ? "granted" : "denied",
          "canAskAgain": false,
          "expires": "never",
        ])
      }
    }

    AsyncFunction("initialize") { (opts: InitOptions) throws -> [String: Any] in
      try self.engine.start(withMinFrequency: opts.minFrequencyHz, maxFrequency: opts.maxFrequencyHz)
      self.engine.setCalibrationOffsetMs(opts.calibrationOffsetMs)
      return self.engine.latencyReport()
    }.runOnQueue(.main)  // AVAudioSession configuration is safest on main

    AsyncFunction("loadSong") { (stems: [StemSpec]) throws -> [String: Any] in
      let specs: [[String: Any]] = stems.map {
        ["id": $0.id, "path": URL(string: $0.uri)?.path ?? $0.uri, "gain": $0.gain]
      }
      let duration = try self.engine.loadStems(specs)
      return ["durationMs": duration.doubleValue]
    }

    // Synchronous JSI functions, called from the JS thread.
    Function("play") { self.engine.play() }
    Function("pause") { self.engine.pause() }
    Function("seek") { (ms: Double) in self.engine.seek(toMs: ms) }
    Function("setStemGain") { (id: String, gain: Double) -> Bool in
      self.engine.setGain(Float(gain), forStem: id)
    }
    Function("setCalibrationOffsetMs") { (ms: Double) in self.engine.setCalibrationOffsetMs(ms) }
    Function("setExpectedNotes") { (flat: [Double]) in
      self.engine.setExpectedNotes(flat.map { NSNumber(value: $0) })
    }
    Function("setLoop") { (startMs: Double, endMs: Double) in
      self.engine.setLoopStartMs(startMs, endMs: endMs)
    }
    Function("setTunerEnabled") { (on: Bool) in self.engine.setTunerEnabled(on) }
    Function("pollState") { () -> [Double] in
      self.engine.pollState().map { $0.doubleValue }
    }

    AsyncFunction("getLatencyReport") { () -> [String: Any] in
      self.engine.latencyReport()
    }.runOnQueue(.main)

    AsyncFunction("shutdown") { self.engine.shutdown() }.runOnQueue(.main)

    OnAppEntersBackground { self.engine.pause() }
    OnDestroy { self.engine.shutdown() }
  }
}
