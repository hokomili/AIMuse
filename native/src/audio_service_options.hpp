#pragma once

#include "realtime_playback.hpp"

#include <span>
#include <string>
#include <string_view>

namespace aimuse::audio {

struct AudioServiceOptions {
  PlaybackMode playback_mode{PlaybackMode::shared};
};

struct AudioServiceOptionsResult {
  bool ok{true};
  AudioServiceOptions options;
  std::string error;
};

[[nodiscard]] inline AudioServiceOptionsResult parse_audio_service_options(
  const std::span<const std::string_view> arguments) {
  AudioServiceOptionsResult result;
  bool stdio_seen = false;
  bool playback_mode_seen = false;
  constexpr std::string_view playback_mode_prefix = "--playback-mode=";

  for (const auto argument : arguments) {
    if (argument == "--stdio") {
      if (stdio_seen) {
        result.ok = false;
        result.error = "The --stdio audio service option may be supplied only once.";
        return result;
      }
      stdio_seen = true;
      continue;
    }
    if (argument.starts_with(playback_mode_prefix)) {
      if (playback_mode_seen) {
        result.ok = false;
        result.error = "The playback mode may be supplied only once.";
        return result;
      }
      playback_mode_seen = true;
      const auto parsed = parse_playback_mode(argument.substr(playback_mode_prefix.size()));
      if (!parsed) {
        result.ok = false;
        result.error = "The playback mode must be 'shared' or 'exclusive'.";
        return result;
      }
      result.options.playback_mode = *parsed;
      continue;
    }
    result.ok = false;
    result.error = "The audio service received an unsupported option.";
    return result;
  }
  return result;
}

}  // namespace aimuse::audio
