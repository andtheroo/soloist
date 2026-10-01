require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The podspec lives at the module root (not ios/) so it can include the shared C++ core in
# cpp/ — CocoaPods only globs files beneath the podspec's directory.
Pod::Spec.new do |s|
  s.name           = 'SoloistAudio'
  s.version        = package['version']
  s.summary        = 'Low-latency playback + mic analysis engine for Soloist'
  s.license        = 'UNLICENSED'
  s.author         = 'Soloist'
  s.homepage       = 'https://example.com/soloist'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.{h,m,mm,swift}', 'cpp/*.{h,cpp}'
  s.exclude_files = 'cpp/tests/**/*'
  # Only the ObjC facade is public; C++ headers must stay out of the Swift umbrella header.
  s.public_header_files = 'ios/SoloistAudioEngine.h'

  s.frameworks = 'AVFoundation', 'AudioToolbox'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/cpp"',
    # Keep DSP fast in Debug builds too, or YIN/mixer can glitch on older devices.
    'GCC_OPTIMIZATION_LEVEL' => 's',
  }
end
