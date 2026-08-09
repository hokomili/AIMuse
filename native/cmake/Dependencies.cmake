include(FetchContent)

# Every revision mirrors native/dependency-lock.json. Fetching is deliberately opt-in.
FetchContent_Declare(vst3sdk GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git GIT_TAG 9fad9770f2ae8542ab1a548a68c1ad1ac690abe0 GIT_SHALLOW FALSE)
FetchContent_Declare(clap GIT_REPOSITORY https://github.com/free-audio/clap.git GIT_TAG 195b42a004144fab0b3cf95e9c067187d15365b7 GIT_SHALLOW FALSE)
FetchContent_Declare(miniaudio GIT_REPOSITORY https://github.com/mackron/miniaudio.git GIT_TAG 9634bedb5b5a2ca38c1ee7108a9358a4e233f14d GIT_SHALLOW FALSE)
FetchContent_Declare(signalsmith_stretch GIT_REPOSITORY https://github.com/Signalsmith-Audio/signalsmith-stretch.git GIT_TAG 57b93f4e9206a089a45387eaa39bdc9f310d3308 GIT_SHALLOW FALSE)

if(AIMUSE_ENABLE_WASAPI)
  FetchContent_MakeAvailable(miniaudio)
endif()
if(AIMUSE_ENABLE_PLUGIN_SDKS)
  set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
  set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(vst3sdk clap)
endif()
