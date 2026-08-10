#pragma once

#include <atomic>
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

enum class PlaybackDeviceNotification {
  started,
  stopped,
  rerouted,
  interruption_began,
  interruption_ended,
  unlocked,
};

// Lock-free state shared by the platform device notification callback and the
// protocol thread. A backend stop or interruption makes playback unavailable
// immediately; reroutes remain observable without treating a successful route
// change as a failure.
class PlaybackDeviceHealth {
 public:
  void notify(PlaybackDeviceNotification notification, bool expected_stop = false) noexcept;

  [[nodiscard]] bool ready() const noexcept;
  [[nodiscard]] bool interruption_active() const noexcept;
  [[nodiscard]] std::uint64_t reroutes() const noexcept;
  [[nodiscard]] std::uint64_t interruptions() const noexcept;
  [[nodiscard]] std::uint64_t unexpected_stops() const noexcept;

 private:
  std::atomic<bool> started_{false};
  std::atomic<bool> interruption_active_{false};
  std::atomic<std::uint64_t> reroutes_{0U};
  std::atomic<std::uint64_t> interruptions_{0U};
  std::atomic<std::uint64_t> unexpected_stops_{0U};
};

struct PlaybackTelemetry {
  std::uint64_t callback_count{0U};
  std::uint64_t callback_frames{0U};
  std::uint64_t rendered_frames{0U};
  std::uint64_t device_reroutes{0U};
  std::uint64_t device_interruptions{0U};
  std::uint64_t device_unexpected_stops{0U};
  bool device_interruption_active{false};
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

// Pure callback kernel used by the platform real-time device and native golden/null tests.
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
  [[nodiscard]] PlaybackTelemetry telemetry() const;

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
