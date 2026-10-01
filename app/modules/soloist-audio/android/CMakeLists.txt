cmake_minimum_required(VERSION 3.22.1)
project(soloistaudio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Oboe comes from the com.google.oboe:oboe AAR via Prefab (see build.gradle).
find_package(oboe REQUIRED CONFIG)

set(CORE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../cpp)   # shared with iOS
file(GLOB CORE_SOURCES ${CORE_DIR}/*.cpp)

add_library(soloistaudio SHARED
    src/main/cpp/OboeEngine.cpp
    src/main/cpp/jni_bridge.cpp
    ${CORE_SOURCES})

target_include_directories(soloistaudio PRIVATE ${CORE_DIR} src/main/cpp)
# -O3 even in debug builds: an unoptimised YIN/mixer can underrun on low-end devices.
# Deliberately NOT -ffast-math (YIN relies on well-defined NaN/denormal behaviour).
target_compile_options(soloistaudio PRIVATE -O3 -Wall -Wextra)
target_link_libraries(soloistaudio PRIVATE oboe::oboe log android)
