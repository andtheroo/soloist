module.exports = function (api) {
  api.cache(true);
  // babel-preset-expo (SDK 54+) auto-adds the react-native-worklets plugin needed by
  // Reanimated 4 / Skia worklets. Add 'react-native-worklets/plugin' LAST if you eject that.
  return { presets: ['babel-preset-expo'] };
};
