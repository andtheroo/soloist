@echo off
"C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot\\bin\\java" ^
  --class-path ^
  "C:\\Users\\sirle\\.gradle\\caches\\modules-2\\files-2.1\\com.google.prefab\\cli\\2.1.0\\aa32fec809c44fa531f01dcfb739b5b3304d3050\\cli-2.1.0-all.jar" ^
  com.google.prefab.cli.AppKt ^
  --build-system ^
  cmake ^
  --platform ^
  android ^
  --abi ^
  arm64-v8a ^
  --os-version ^
  24 ^
  --stl ^
  c++_shared ^
  --ndk-version ^
  27 ^
  --output ^
  "C:\\Users\\sirle\\AppData\\Local\\Temp\\agp-prefab-staging15165425528452265176\\staged-cli-output" ^
  "C:\\Users\\sirle\\.gradle\\caches\\8.14.3\\transforms\\c2ae37c0a1ba9cdaf907a3452300fcb4\\transformed\\oboe-1.9.3\\prefab"
