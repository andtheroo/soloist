// iOS device layer: AVAudioEngine with an AVAudioSourceNode (output) and AVAudioSinkNode
// (input), both running *our* C++ AudioCore on Core Audio's real-time render thread.
//
// Why not AVAudioPlayerNode + installTap?
//   * installTap delivers ~100 ms buffers on a non-RT thread with loose timestamps.
//   * AVAudioPlayerNode scheduling is sample-accurate but opaque; the source node lets the
//     same Mixer + ClockMap code run on both platforms, so sync logic is written once.
#import "SoloistAudioEngine.h"

#import <AVFoundation/AVFoundation.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "AudioCore.h"
#include "HostClock.h"

using namespace soloist;

static NSString *const kErrorDomain = @"SoloistAudio";
static const uint32_t kMaxRenderFrames = 4096;

@implementation SoloistAudioEngine {
  AVAudioEngine *_engine;
  AVAudioSourceNode *_source;
  AVAudioSinkNode *_sink;
  std::shared_ptr<AudioCore> _core;
  std::vector<float> _scratch;  // interleaved stereo render buffer (RT thread only)
  std::atomic<int64_t> _outLatencyNs;
  std::atomic<int64_t> _inLatencyNs;
  double _minHz, _maxHz;
  BOOL _running;
  NSMutableArray<id> *_observers;
}

- (instancetype)init {
  if ((self = [super init])) {
    _core = std::make_shared<AudioCore>();
    _scratch.assign(kMaxRenderFrames * 2, 0.f);
    _outLatencyNs = 0;
    _inLatencyNs = 0;
    _observers = [NSMutableArray array];
  }
  return self;
}

- (void)dealloc {
  [self shutdown];
}

#pragma mark - Lifecycle

- (BOOL)startWithMinFrequency:(double)minHz maxFrequency:(double)maxHz error:(NSError **)error {
  if (_running) return YES;
  _minHz = minHz;
  _maxHz = maxHz;

  AVAudioSession *session = AVAudioSession.sharedInstance;
  // .measurement disables AGC / noise suppression / EQ on the mic — essential for pitch
  // accuracy. We deliberately do NOT enable voice processing (its echo canceller would
  // "cancel" the guitar too).
  if (![session setCategory:AVAudioSessionCategoryPlayAndRecord
                        mode:AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionDefaultToSpeaker |
                             AVAudioSessionCategoryOptionAllowBluetoothA2DP
                       error:error]) {
    return NO;
  }
  [session setPreferredSampleRate:48000 error:nil];
  [session setPreferredIOBufferDuration:0.0029 error:nil];  // ask for 128 frames; iOS may round up
  if (![session setActive:YES error:error]) return NO;

  if (![self buildGraph:error]) return NO;
  [self installObservers];
  _core->startAnalysis(nullptr);  // iOS timestamps arrive with every render callback
  _running = YES;
  return YES;
}

- (void)shutdown {
  if (!_running) return;
  _running = NO;
  for (id o in _observers) [NSNotificationCenter.defaultCenter removeObserver:o];
  [_observers removeAllObjects];
  [_engine stop];
  _core->stopAnalysis();
  _engine = nil;
  _source = nil;
  _sink = nil;
  [AVAudioSession.sharedInstance setActive:NO
                               withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                     error:nil];
}

- (void)updateLatencies {
  AVAudioSession *s = AVAudioSession.sharedInstance;
  _outLatencyNs.store(static_cast<int64_t>(s.outputLatency * 1e9));
  _inLatencyNs.store(static_cast<int64_t>(s.inputLatency * 1e9));
}

- (BOOL)buildGraph:(NSError **)error {
  _engine = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = _engine.inputNode;  // touching inputNode enables the mic path
  AVAudioFormat *inFmt = [input inputFormatForBus:0];
  if (inFmt.sampleRate <= 0 || inFmt.channelCount == 0) {
    if (error) *error = [NSError errorWithDomain:kErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey : @"No microphone input available"}];
    return NO;
  }
  const double outRate = AVAudioSession.sharedInstance.sampleRate;
  AVAudioFormat *outFmt = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:outRate channels:2];

  _core->clock().reset();
  _core->configure(outRate, inFmt.sampleRate, _minHz, _maxHz);
  [self updateLatencies];

  // Raw pointers captured by the RT blocks: no ObjC messaging / retain traffic on that thread.
  AudioCore *core = _core.get();
  float *scratch = _scratch.data();
  std::atomic<int64_t> *outLat = &_outLatencyNs;
  std::atomic<int64_t> *inLat = &_inLatencyNs;

  _source = [[AVAudioSourceNode alloc]
      initWithFormat:outFmt
         renderBlock:^OSStatus(BOOL *isSilence, const AudioTimeStamp *ts, AVAudioFrameCount frameCount,
                               AudioBufferList *abl) {
           // ===== REAL-TIME: no locks, no allocation, no ObjC =====
           const int64_t outFrame = static_cast<int64_t>(ts->mSampleTime);
           if (ts->mFlags & kAudioTimeStampHostTimeValid) {
             // Host time of this buffer + hardware output latency = when it is actually heard.
             core->clock().publishOutputTimestamp(
                 outFrame, hostTicksToNanos(ts->mHostTime) + outLat->load(std::memory_order_relaxed));
           }
           float *L = static_cast<float *>(abl->mBuffers[0].mData);
           float *R = abl->mNumberBuffers > 1 ? static_cast<float *>(abl->mBuffers[1].mData) : nullptr;
           for (uint32_t done = 0; done < frameCount;) {
             const uint32_t n = std::min<uint32_t>(frameCount - done, kMaxRenderFrames);
             core->renderOutput(scratch, static_cast<int32_t>(n), 2, outFrame + done);
             for (uint32_t i = 0; i < n; ++i) {
               L[done + i] = scratch[2 * i];
               if (R) R[done + i] = scratch[2 * i + 1];
             }
             done += n;
           }
           *isSilence = NO;
           return noErr;
         }];

  _sink = [[AVAudioSinkNode alloc] initWithReceiverBlock:^OSStatus(const AudioTimeStamp *ts,
                                                                   AVAudioFrameCount frameCount,
                                                                   const AudioBufferList *abl) {
    // ===== REAL-TIME =====
    const int64_t inFrame = static_cast<int64_t>(ts->mSampleTime);
    if (ts->mFlags & kAudioTimeStampHostTimeValid) {
      // Host time of this buffer minus hardware input latency = when the sound hit the mic.
      core->clock().publishInputTimestamp(
          inFrame, hostTicksToNanos(ts->mHostTime) - inLat->load(std::memory_order_relaxed));
    }
    core->onInputFrames(static_cast<const float *>(abl->mBuffers[0].mData),  // channel 0
                        static_cast<int32_t>(frameCount), inFrame);
    return noErr;
  }];

  [_engine attachNode:_source];
  [_engine attachNode:_sink];
  [_engine connect:_source to:_engine.mainMixerNode format:outFmt];
  [_engine connect:input to:_sink format:inFmt];
  [_engine prepare];
  return [_engine startAndReturnError:error];
}

- (void)rebuildAfterConfigurationChange {
  if (!_running) return;
  [_engine stop];
  NSError *err = nil;
  if ([self buildGraph:&err]) {
    _core->bumpDeviceGeneration();  // JS reloads stems if the sample rate changed
  } else {
    NSLog(@"[SoloistAudio] rebuild failed: %@", err);
  }
}

- (void)installObservers {
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  __weak SoloistAudioEngine *weakSelf = self;

  [_observers addObject:[nc addObserverForName:AVAudioSessionInterruptionNotification
                                        object:nil
                                         queue:NSOperationQueue.mainQueue
                                    usingBlock:^(NSNotification *note) {
    SoloistAudioEngine *s = weakSelf;
    if (!s) return;
    const auto type = static_cast<AVAudioSessionInterruptionType>(
        [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue]);
    if (type == AVAudioSessionInterruptionTypeBegan) {
      s->_core->pause();
    } else {
      [AVAudioSession.sharedInstance setActive:YES error:nil];
      [s rebuildAfterConfigurationChange];
    }
  }]];

  [_observers addObject:[nc addObserverForName:AVAudioSessionRouteChangeNotification
                                        object:nil
                                         queue:NSOperationQueue.mainQueue
                                    usingBlock:^(NSNotification *note) {
    [weakSelf updateLatencies];
  }]];

  // Fired when the hardware format changes (e.g. headphones with a different rate).
  [_observers addObject:[nc addObserverForName:AVAudioEngineConfigurationChangeNotification
                                        object:nil
                                         queue:NSOperationQueue.mainQueue
                                    usingBlock:^(NSNotification *note) {
    [weakSelf rebuildAfterConfigurationChange];
  }]];

  [_observers addObject:[nc addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                                        object:nil
                                         queue:NSOperationQueue.mainQueue
                                    usingBlock:^(NSNotification *note) {
    [weakSelf rebuildAfterConfigurationChange];
  }]];
}

#pragma mark - Transport / content

- (nullable NSNumber *)loadStems:(NSArray<NSDictionary *> *)stems error:(NSError **)error {
  std::vector<StemSpec> specs;
  for (NSDictionary *d in stems) {
    StemSpec s;
    s.id = [d[@"id"] UTF8String] ?: "";
    s.path = [d[@"path"] UTF8String] ?: "";
    s.gain = [d[@"gain"] floatValue];
    specs.push_back(std::move(s));
  }
  double durationMs = 0;
  std::string err;
  if (!_core->loadStems(specs, durationMs, err)) {
    if (error) *error = [NSError errorWithDomain:kErrorDomain code:2 userInfo:@{NSLocalizedDescriptionKey : @(err.c_str())}];
    return nil;
  }
  return @(durationMs);
}

- (void)play { _core->play(); }
- (void)pause { _core->pause(); }
- (void)seekToMs:(double)ms { _core->seekMs(ms); }
- (BOOL)setGain:(float)gain forStem:(NSString *)stemId { return _core->setStemGain(stemId.UTF8String, gain); }
- (void)setCalibrationOffsetMs:(double)ms { _core->setCalibrationOffsetMs(ms); }

- (void)setExpectedNotes:(NSArray<NSNumber *> *)flat {
  std::vector<ExpectedNote> notes;
  notes.reserve(flat.count / 2);
  for (NSUInteger i = 0; i + 1 < flat.count; i += 2) {
    notes.push_back({flat[i].doubleValue, flat[i + 1].floatValue});
  }
  _core->setExpectedNotes(std::move(notes));
}

- (void)setLoopStartMs:(double)startMs endMs:(double)endMs { _core->setLoopMs(startMs, endMs); }
- (void)setTunerEnabled:(BOOL)enabled { _core->setTunerEnabled(enabled); }

- (NSArray<NSNumber *> *)pollState {
  static thread_local std::vector<double> buf(kHeaderSize + 64 * (kEventFixedFields + 6));
  const int n = _core->pollState(buf.data(), static_cast<int>(buf.size()));
  NSMutableArray<NSNumber *> *out = [NSMutableArray arrayWithCapacity:n];
  for (int i = 0; i < n; ++i) [out addObject:@(buf[i])];
  return out;
}

- (NSDictionary<NSString *, id> *)latencyReport {
  AVAudioSession *s = AVAudioSession.sharedInstance;
  BOOL bluetooth = NO, wired = NO;
  for (AVAudioSessionPortDescription *p in s.currentRoute.outputs) {
    if ([p.portType isEqualToString:AVAudioSessionPortBluetoothA2DP] ||
        [p.portType isEqualToString:AVAudioSessionPortBluetoothLE] ||
        [p.portType isEqualToString:AVAudioSessionPortBluetoothHFP]) bluetooth = YES;
    if ([p.portType isEqualToString:AVAudioSessionPortHeadphones] ||
        [p.portType isEqualToString:AVAudioSessionPortUSBAudio] ||
        [p.portType isEqualToString:AVAudioSessionPortLineOut]) wired = YES;
  }
  return @{
    @"platform" : @"ios",
    @"audioApi" : @"AVAudioEngine",
    @"sampleRate" : @(s.sampleRate),
    @"inputSampleRate" : @([_engine.inputNode inputFormatForBus:0].sampleRate),
    @"ioBufferMs" : @(s.IOBufferDuration * 1000.0),
    @"outputLatencyMs" : @(s.outputLatency * 1000.0),
    @"inputLatencyMs" : @(s.inputLatency * 1000.0),
    @"bluetoothOutput" : @(bluetooth),
    @"wiredOrUsbOutput" : @(wired),
  };
}

@end
