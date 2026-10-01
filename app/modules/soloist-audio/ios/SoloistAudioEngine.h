// Objective-C facade over the C++ AudioCore so Swift never sees C++ headers.
// (This is the only public header of the pod; C++ stays private.)
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SoloistAudioEngine : NSObject

- (BOOL)startWithMinFrequency:(double)minHz maxFrequency:(double)maxHz error:(NSError **)error;
- (void)shutdown;

/// stems: [{ id: String, path: String, gain: Number }]. Returns duration in ms.
- (nullable NSNumber *)loadStems:(NSArray<NSDictionary *> *)stems error:(NSError **)error;

- (void)play;
- (void)pause;
- (void)seekToMs:(double)ms;
- (BOOL)setGain:(float)gain forStem:(NSString *)stemId;
- (void)setCalibrationOffsetMs:(double)ms;
/// Flat [timeMs, midi, timeMs, midi, ...]
- (void)setExpectedNotes:(NSArray<NSNumber *> *)flat;

/// Practice A–B loop in song ms; endMs <= startMs clears it.
- (void)setLoopStartMs:(double)startMs endMs:(double)endMs;
- (void)setTunerEnabled:(BOOL)enabled;

/// Header + events, layout in SoloistAudio.types.ts. Called once per frame.
- (NSArray<NSNumber *> *)pollState;
- (NSDictionary<NSString *, id> *)latencyReport;

@end

NS_ASSUME_NONNULL_END
