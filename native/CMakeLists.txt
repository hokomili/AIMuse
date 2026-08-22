cmake_minimum_required(VERSION 3.25)
project(AIMuseNative VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
foreach(config Debug Release RelWithDebInfo MinSizeRel)
  string(TOUPPER "${config}" config_upper)
  set("CMAKE_RUNTIME_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}")
endforeach()

option(AIMUSE_FETCH_AUDIO_DEPS "Fetch pinned third-party audio SDKs" OFF)
option(AIMUSE_ENABLE_WASAPI "Compile miniaudio WASAPI device support when dependencies are present" OFF)
option(AIMUSE_ENABLE_COREAUDIO "Compile miniaudio CoreAudio device support when dependencies are present" OFF)
option(AIMUSE_BUILD_RUNTIME_BINARIES "Build the audio service and plug-in helper processes" ON)
option(AIMUSE_ENABLE_PLUGIN_SDKS "Compile VST3 and CLAP host adapters when dependencies are present" OFF)
option(AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER "Build the opt-in QA private-root Node-API prototype" OFF)

if(AIMUSE_FETCH_AUDIO_DEPS)
  include(cmake/Dependencies.cmake)
endif()

add_library(aimuse-dsp STATIC
  src/dsp.cpp
  src/dsp.hpp
)
target_include_directories(aimuse-dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_compile_definitions(aimuse-dsp PUBLIC AIMUSE_NATIVE_VERSION="${PROJECT_VERSION}")

add_library(aimuse-playback STATIC
  src/midi_discovery_publisher.cpp
  src/midi_discovery_publisher.hpp
  src/midi_port_registry.cpp
  src/midi_port_registry.hpp
  src/realtime_playback.cpp
  src/realtime_playback.hpp
  src/windows_midi_discovery.cpp
  src/windows_midi_discovery.hpp
)
target_include_directories(aimuse-playback PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
if(AIMUSE_ENABLE_WASAPI)
  if(NOT WIN32)
    message(FATAL_ERROR "AIMUSE_ENABLE_WASAPI is only supported by the Windows build.")
  endif()
  if(NOT AIMUSE_FETCH_AUDIO_DEPS)
    message(FATAL_ERROR "AIMUSE_ENABLE_WASAPI requires AIMUSE_FETCH_AUDIO_DEPS so the pinned miniaudio revision is available.")
  endif()
  target_include_directories(aimuse-playback PRIVATE "${miniaudio_SOURCE_DIR}")
  target_compile_definitions(aimuse-playback PRIVATE AIMUSE_ENABLE_WASAPI=1 NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

if(WIN32)
  # The Windows SDK C++/WinRT projection supplies the MIDI selectors and
  # DeviceWatcher contract; WindowsApp resolves that projection at link time.
  find_path(AIMUSE_CPPWINRT_INCLUDE_DIR winrt/base.h
    HINTS
      "$ENV{WindowsSdkDir}/Include/$ENV{WindowsSDKVersion}/cppwinrt"
      "C:/Program Files (x86)/Windows Kits/10/Include/${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}/cppwinrt"
  )
  if(NOT AIMUSE_CPPWINRT_INCLUDE_DIR)
    message(FATAL_ERROR "Windows MIDI discovery requires the Windows SDK C++/WinRT projection (winrt/base.h).")
  endif()
  target_include_directories(aimuse-playback PRIVATE "${AIMUSE_CPPWINRT_INCLUDE_DIR}")
  target_compile_definitions(aimuse-playback PRIVATE AIMUSE_ENABLE_WINDOWS_MIDI_DISCOVERY=1)
  target_link_libraries(aimuse-playback PRIVATE windowsapp)
endif()

if(AIMUSE_ENABLE_COREAUDIO)
  if(NOT APPLE)
    message(FATAL_ERROR "AIMUSE_ENABLE_COREAUDIO is only valid for an Apple build.")
  endif()
  if(NOT AIMUSE_FETCH_AUDIO_DEPS)
    message(FATAL_ERROR "AIMUSE_ENABLE_COREAUDIO requires AIMUSE_FETCH_AUDIO_DEPS so the pinned miniaudio revision is available.")
  endif()
  target_include_directories(aimuse-playback PRIVATE "${miniaudio_SOURCE_DIR}")
  target_compile_definitions(aimuse-playback PRIVATE AIMUSE_ENABLE_COREAUDIO=1)
endif()

if(APPLE AND AIMUSE_BUILD_RUNTIME_BINARIES AND NOT AIMUSE_ENABLE_COREAUDIO)
  message(FATAL_ERROR "macOS runtime binaries require AIMUSE_ENABLE_COREAUDIO so the audio service cannot be staged as an offline placeholder.")
endif()

set(AIMUSE_WARNING_TARGETS aimuse-dsp aimuse-playback)
if(AIMUSE_BUILD_RUNTIME_BINARIES)
  add_executable(aimuse-audio src/audio_service.cpp src/audio_service_options.hpp src/protocol.hpp)
  target_link_libraries(aimuse-audio PRIVATE aimuse-dsp aimuse-playback)
  add_executable(aimuse-plugin-scanner src/plugin_scanner.cpp src/protocol.hpp)
  add_executable(aimuse-plugin-bridge src/plugin_bridge.cpp src/protocol.hpp)
  list(APPEND AIMUSE_WARNING_TARGETS aimuse-audio aimuse-plugin-scanner aimuse-plugin-bridge)

  if(WIN32)
    target_compile_definitions(aimuse-audio PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_compile_definitions(aimuse-plugin-scanner PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_compile_definitions(aimuse-plugin-bridge PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  endif()
endif()

if(AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER)
  if(NOT WIN32)
    message(FATAL_ERROR "The QA private-root Node-API provider is Windows-only.")
  endif()
  if(NOT AIMUSE_NODE_API_INCLUDE_DIR OR NOT EXISTS "${AIMUSE_NODE_API_INCLUDE_DIR}/node_api.h")
    message(FATAL_ERROR "AIMUSE_NODE_API_INCLUDE_DIR must identify an audited Node-API header directory.")
  endif()
  if(NOT AIMUSE_NODE_API_LIBRARY OR NOT EXISTS "${AIMUSE_NODE_API_LIBRARY}")
    message(FATAL_ERROR "AIMUSE_NODE_API_LIBRARY must identify an audited x64 Node import library.")
  endif()
  add_library(aimuse-qa-private-root-provider MODULE src/qa_private_root_provider.cpp)
  target_include_directories(aimuse-qa-private-root-provider PRIVATE "${AIMUSE_NODE_API_INCLUDE_DIR}")
  target_compile_definitions(aimuse-qa-private-root-provider PRIVATE
    NAPI_VERSION=8
    NODE_GYP_MODULE_NAME=aimuse_qa_private_root_provider
    NOMINMAX
    WIN32_LEAN_AND_MEAN
  )
  target_link_libraries(aimuse-qa-private-root-provider PRIVATE "${AIMUSE_NODE_API_LIBRARY}" Advapi32 Bcrypt)
  set_target_properties(aimuse-qa-private-root-provider PROPERTIES
    PREFIX ""
    SUFFIX ".node"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
  )
  foreach(config Debug Release RelWithDebInfo MinSizeRel)
    string(TOUPPER "${config}" config_upper)
    set_target_properties(aimuse-qa-private-root-provider PROPERTIES
      "LIBRARY_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}"
      "RUNTIME_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}"
    )
  endforeach()
endif()

if(MSVC)
  foreach(target IN LISTS AIMUSE_WARNING_TARGETS)
    target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
  endforeach()
  if(TARGET aimuse-qa-private-root-provider)
    target_compile_options(aimuse-qa-private-root-provider PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
  endif()
else()
  foreach(target IN LISTS AIMUSE_WARNING_TARGETS)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endforeach()
endif()

enable_testing()
add_executable(aimuse-native-tests tests/dsp_tests.cpp)
target_link_libraries(aimuse-native-tests PRIVATE aimuse-dsp aimuse-playback)
if(MSVC)
  target_compile_options(aimuse-native-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8)
else()
  target_compile_options(aimuse-native-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
add_test(NAME aimuse-native-dsp COMMAND aimuse-native-tests)
