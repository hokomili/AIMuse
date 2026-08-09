#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace aimuse::audio {

enum class PlaybackMode {
  shared,
  exclusive,
};

[[nodiscard]] constexpr std::string_view playback_mode_name(const PlaybackMode mode) noexcept {
  return mode == PlaybackMode::exclusive ? "exclusive" : "shared";
}

[[nodiscard]] constexpr std::optional<PlaybackMode> parse_playback_mode(const std::string_view value) noexcept {
  if (value == "shared") return PlaybackMode::shared;
  if (value == "exclusive") return PlaybackMode::exclusive;
  return std::nullopt;
}

struct PlaybackBuffer {
  std::uint32_t sample_rate{48'000U};
  std::uint64_t frames{0U};
  std::vector<float> interleaved_stereo;
};

struct PlaybackWindow {
  std::uint64_t cursor{0U};
  std::uint64_t loop_start{0U};
  std::uint64_t loop_end{0U};
  bool loop_enabled{false};
  bool playing{false};
};

// Pure callback kernel used by the WASAPI device and native golden/null tests.
std::size_t render_playback_frames(
  const PlaybackBuffer& buffer,
  PlaybackWindow& window,
  float* output_interleaved_stereo,
  std::size_t frame_count);

std::shared_ptr<const PlaybackBuffer> load_float32_wav(
  const std::filesystem::path& path,
  std::string& error);

class RealtimePlayback {
 public:
  explicit RealtimePlayback(PlaybackMode requested_mode = PlaybackMode::shared);
  ~RealtimePlayback();
  RealtimePlayback(const RealtimePlayback&) = delete;
  RealtimePlayback& operator=(const RealtimePlayback&) = delete;

  [[nodiscard]] bool ready() const;
  [[nodiscard]] std::string driver() const;
  [[nodiscard]] std::string diagnostic() const;
  [[nodiscard]] PlaybackMode requested_mode() const;
  [[nodiscard]] std::optional<PlaybackMode> effective_mode() const;
  [[nodiscard]] std::uint32_t sample_rate() const;
  [[nodiscard]] std::uint32_t latency_samples() const;
  [[nodiscard]] std::uint64_t cursor() const;

  bool load_preview(const std::filesystem::path& path, bool preserve_transport, std::string& error);
  void clear_preview();
  bool play(std::string& error);
  void pause();
  void stop();
  void seek(std::uint64_t sample);
  void set_loop(bool enabled, std::uint64_t start_sample, std::uint64_t end_sample);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aimuse::audio
