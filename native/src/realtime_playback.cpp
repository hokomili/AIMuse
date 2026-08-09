#include "realtime_playback.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <utility>

#if defined(AIMUSE_ENABLE_WASAPI) && defined(_WIN32)
#define MINIAUDIO_IMPLEMENTATION
#if defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4244)
#endif
#include <miniaudio.h>
#if defined(_MSC_VER)
#pragma warning(pop)
#endif
#endif

namespace aimuse::audio {
namespace {

constexpr std::uint64_t max_preview_bytes = 1ULL * 1024ULL * 1024ULL * 1024ULL;

std::uint16_t little_u16(const std::array<unsigned char, 16>& bytes, const std::size_t offset) {
  return static_cast<std::uint16_t>(bytes[offset]) |
    static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[offset + 1U]) << 8U);
}

std::uint32_t little_u32(const std::array<unsigned char, 16>& bytes, const std::size_t offset) {
  return static_cast<std::uint32_t>(bytes[offset]) |
    (static_cast<std::uint32_t>(bytes[offset + 1U]) << 8U) |
    (static_cast<std::uint32_t>(bytes[offset + 2U]) << 16U) |
    (static_cast<std::uint32_t>(bytes[offset + 3U]) << 24U);
}

std::uint32_t little_u32(const std::array<unsigned char, 4>& bytes) {
  return static_cast<std::uint32_t>(bytes[0]) |
    (static_cast<std::uint32_t>(bytes[1]) << 8U) |
    (static_cast<std::uint32_t>(bytes[2]) << 16U) |
    (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

bool read_exact(std::ifstream& input, void* destination, const std::size_t bytes) {
  if (bytes > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())) return false;
  input.read(static_cast<char*>(destination), static_cast<std::streamsize>(bytes));
  return input.good() || input.gcount() == static_cast<std::streamsize>(bytes);
}

}  // namespace

std::size_t render_playback_frames(
  const PlaybackBuffer& buffer,
  PlaybackWindow& window,
  float* const output,
  const std::size_t frame_count) {
  if (output == nullptr) return 0U;
  std::fill_n(output, frame_count * 2U, 0.0F);
  if (!window.playing || buffer.frames == 0U || buffer.interleaved_stereo.size() < buffer.frames * 2U) return 0U;

  const auto loop_end = std::min(window.loop_end, buffer.frames);
  const auto loop_start = std::min(window.loop_start, loop_end);
  const bool can_loop = window.loop_enabled && loop_start < loop_end;
  std::size_t rendered = 0U;
  for (std::size_t frame = 0U; frame < frame_count; ++frame) {
    if (can_loop && window.cursor >= loop_end) window.cursor = loop_start;
    if (window.cursor >= buffer.frames) {
      window.playing = false;
      break;
    }
    const auto source = static_cast<std::size_t>(window.cursor * 2U);
    output[frame * 2U] = buffer.interleaved_stereo[source];
    output[frame * 2U + 1U] = buffer.interleaved_stereo[source + 1U];
    ++window.cursor;
    ++rendered;
  }
  if (!can_loop && window.cursor >= buffer.frames) window.playing = false;
  return rendered;
}

std::shared_ptr<const PlaybackBuffer> load_float32_wav(const std::filesystem::path& path, std::string& error) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    error = "The managed playback preview could not be opened.";
    return {};
  }

  std::array<char, 12> riff{};
  if (!read_exact(input, riff.data(), riff.size()) || std::memcmp(riff.data(), "RIFF", 4U) != 0 ||
      std::memcmp(riff.data() + 8U, "WAVE", 4U) != 0) {
    error = "The managed playback preview is not RIFF/WAVE.";
    return {};
  }

  std::uint16_t format = 0U;
  std::uint16_t channels = 0U;
  std::uint16_t bits = 0U;
  std::uint32_t sample_rate = 0U;
  std::streampos data_position{};
  std::uint32_t data_bytes = 0U;
  bool found_format = false;
  bool found_data = false;

  while (input && !(found_format && found_data)) {
    std::array<char, 4> chunk_id{};
    std::array<unsigned char, 4> chunk_size_bytes{};
    if (!read_exact(input, chunk_id.data(), chunk_id.size()) || !read_exact(input, chunk_size_bytes.data(), chunk_size_bytes.size())) break;
    const auto chunk_bytes = little_u32(chunk_size_bytes);
    const auto chunk_start = input.tellg();
    if (std::memcmp(chunk_id.data(), "fmt ", 4U) == 0) {
      if (chunk_bytes < 16U) {
        error = "The managed playback preview has a truncated format chunk.";
        return {};
      }
      std::array<unsigned char, 16> header{};
      if (!read_exact(input, header.data(), header.size())) {
        error = "The managed playback preview format could not be read.";
        return {};
      }
      format = little_u16(header, 0U);
      channels = little_u16(header, 2U);
      sample_rate = little_u32(header, 4U);
      bits = little_u16(header, 14U);
      found_format = true;
    } else if (std::memcmp(chunk_id.data(), "data", 4U) == 0) {
      data_position = chunk_start;
      data_bytes = chunk_bytes;
      found_data = true;
    }
    const auto padded = static_cast<std::streamoff>(chunk_bytes) + static_cast<std::streamoff>(chunk_bytes & 1U);
    input.seekg(chunk_start + padded);
  }

  if (!found_format || !found_data || format != 3U || bits != 32U || (channels != 1U && channels != 2U) ||
      (sample_rate != 44'100U && sample_rate != 48'000U && sample_rate != 96'000U)) {
    error = "The managed playback preview must be mono/stereo float32 WAV at 44.1, 48, or 96 kHz.";
    return {};
  }
  const auto bytes_per_frame = static_cast<std::uint64_t>(channels) * sizeof(float);
  if (data_bytes == 0U || data_bytes > max_preview_bytes || static_cast<std::uint64_t>(data_bytes) % bytes_per_frame != 0U) {
    error = "The managed playback preview data size is invalid or exceeds 1 GiB.";
    return {};
  }
  const auto frames = static_cast<std::uint64_t>(data_bytes) / bytes_per_frame;
  if (frames > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() / 2U)) {
    error = "The managed playback preview is too large for this process.";
    return {};
  }

  input.clear();
  input.seekg(data_position);
  auto buffer = std::make_shared<PlaybackBuffer>();
  buffer->sample_rate = sample_rate;
  buffer->frames = frames;
  buffer->interleaved_stereo.resize(static_cast<std::size_t>(frames * 2U));
  if (channels == 2U) {
    if (!read_exact(input, buffer->interleaved_stereo.data(), static_cast<std::size_t>(data_bytes))) {
      error = "The managed playback preview ended before its declared audio data.";
      return {};
    }
  } else {
    std::vector<float> mono(static_cast<std::size_t>(frames));
    if (!read_exact(input, mono.data(), static_cast<std::size_t>(data_bytes))) {
      error = "The managed playback preview ended before its declared audio data.";
      return {};
    }
    for (std::size_t frame = 0U; frame < mono.size(); ++frame) {
      buffer->interleaved_stereo[frame * 2U] = mono[frame];
      buffer->interleaved_stereo[frame * 2U + 1U] = mono[frame];
    }
  }
  if (std::any_of(buffer->interleaved_stereo.begin(), buffer->interleaved_stereo.end(), [](const float value) { return !std::isfinite(value); })) {
    error = "The managed playback preview contains non-finite samples.";
    return {};
  }
  return buffer;
}

class RealtimePlayback::Impl {
 public:
  explicit Impl(const PlaybackMode mode) : requested_mode(mode) { initialize_device(48'000U); }
  ~Impl() { shutdown_device(); }

  std::atomic<std::shared_ptr<const PlaybackBuffer>> active;
  std::atomic<std::uint64_t> cursor{0U};
  std::atomic<std::uint64_t> loop_start{0U};
  std::atomic<std::uint64_t> loop_end{0U};
  std::atomic<bool> loop_enabled{false};
  std::atomic<bool> playing{false};
  const PlaybackMode requested_mode;
  std::optional<PlaybackMode> effective_mode;
  bool device_ready{false};
  std::uint32_t current_sample_rate{48'000U};
  std::uint32_t current_latency_samples{256U};
  std::string device_diagnostic;

  bool initialize_device(const std::uint32_t requested_sample_rate) {
    shutdown_device();
    current_sample_rate = requested_sample_rate;
#if defined(AIMUSE_ENABLE_WASAPI) && defined(_WIN32)
    constexpr ma_backend backends[] = {ma_backend_wasapi};
    auto result = ma_context_init(backends, 1U, nullptr, &context);
    if (result != MA_SUCCESS) {
      device_diagnostic = "WASAPI " + std::string(playback_mode_name(requested_mode)) +
        " output context initialization failed: " + ma_result_description(result);
      return false;
    }
    context_initialized = true;
    auto config = ma_device_config_init(ma_device_type_playback);
    config.playback.format = ma_format_f32;
    config.playback.channels = 2U;
    config.playback.shareMode = requested_mode == PlaybackMode::exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;
    config.sampleRate = requested_sample_rate;
    config.periodSizeInFrames = 256U;
    config.dataCallback = &Impl::device_callback;
    config.pUserData = this;
    result = ma_device_init(&context, &config, &device);
    if (result != MA_SUCCESS) {
      device_diagnostic = "WASAPI " + std::string(playback_mode_name(requested_mode)) +
        " output initialization failed: " + ma_result_description(result);
      shutdown_device();
      return false;
    }
    device_initialized = true;
    result = ma_device_start(&device);
    if (result != MA_SUCCESS) {
      device_diagnostic = "WASAPI " + std::string(playback_mode_name(requested_mode)) +
        " output start failed: " + ma_result_description(result);
      shutdown_device();
      return false;
    }
    device_ready = true;
    effective_mode = requested_mode;
    current_latency_samples = 256U;
    device_diagnostic = "WASAPI " + std::string(playback_mode_name(requested_mode)) + " output is ready.";
    return true;
#else
    device_diagnostic = "WASAPI support is not compiled into this build.";
    return false;
#endif
  }

  void shutdown_device() {
    playing.store(false, std::memory_order_release);
#if defined(AIMUSE_ENABLE_WASAPI) && defined(_WIN32)
    if (device_initialized) {
      ma_device_uninit(&device);
      device_initialized = false;
    }
    if (context_initialized) {
      ma_context_uninit(&context);
      context_initialized = false;
    }
#endif
    device_ready = false;
    effective_mode.reset();
  }

#if defined(AIMUSE_ENABLE_WASAPI) && defined(_WIN32)
  static void device_callback(ma_device* device_pointer, void* output, const void*, const ma_uint32 frame_count) {
    auto* self = static_cast<Impl*>(device_pointer->pUserData);
    auto* samples = static_cast<float*>(output);
    const auto buffer = self->active.load(std::memory_order_acquire);
    if (!buffer) {
      std::fill_n(samples, static_cast<std::size_t>(frame_count) * 2U, 0.0F);
      return;
    }
    PlaybackWindow window{
      self->cursor.load(std::memory_order_relaxed),
      self->loop_start.load(std::memory_order_relaxed),
      self->loop_end.load(std::memory_order_relaxed),
      self->loop_enabled.load(std::memory_order_relaxed),
      self->playing.load(std::memory_order_acquire),
    };
    render_playback_frames(*buffer, window, samples, static_cast<std::size_t>(frame_count));
    self->cursor.store(window.cursor, std::memory_order_release);
    self->playing.store(window.playing, std::memory_order_release);
  }

  ma_context context{};
  ma_device device{};
  bool context_initialized{false};
  bool device_initialized{false};
#endif
};

RealtimePlayback::RealtimePlayback(const PlaybackMode requested_mode) : impl_(std::make_unique<Impl>(requested_mode)) {}
RealtimePlayback::~RealtimePlayback() = default;

bool RealtimePlayback::ready() const { return impl_->device_ready; }
std::string RealtimePlayback::driver() const { return ready() ? "wasapi" : "offline"; }
std::string RealtimePlayback::diagnostic() const { return impl_->device_diagnostic; }
PlaybackMode RealtimePlayback::requested_mode() const { return impl_->requested_mode; }
std::optional<PlaybackMode> RealtimePlayback::effective_mode() const { return impl_->effective_mode; }
std::uint32_t RealtimePlayback::sample_rate() const { return impl_->current_sample_rate; }
std::uint32_t RealtimePlayback::latency_samples() const { return impl_->current_latency_samples; }
std::uint64_t RealtimePlayback::cursor() const { return impl_->cursor.load(std::memory_order_acquire); }

bool RealtimePlayback::load_preview(const std::filesystem::path& path, const bool preserve_transport, std::string& error) {
  auto preview = load_float32_wav(path, error);
  if (!preview) return false;
  const auto previous_cursor = impl_->cursor.load(std::memory_order_acquire);
  const auto was_playing = impl_->playing.load(std::memory_order_acquire);
  const auto preview_frames = preview->frames;
  if (!impl_->device_ready || impl_->current_sample_rate != preview->sample_rate) {
    if (!impl_->initialize_device(preview->sample_rate)) {
      error = impl_->device_diagnostic;
      return false;
    }
  }
  impl_->playing.store(false, std::memory_order_release);
  impl_->active.store(std::move(preview), std::memory_order_release);
  impl_->cursor.store(preserve_transport ? std::min(previous_cursor, preview_frames) : 0U, std::memory_order_release);
  impl_->playing.store(preserve_transport && was_playing, std::memory_order_release);
  return true;
}

void RealtimePlayback::clear_preview() {
  impl_->playing.store(false, std::memory_order_release);
  impl_->active.store({}, std::memory_order_release);
  impl_->cursor.store(0U, std::memory_order_release);
}

bool RealtimePlayback::play(std::string& error) {
  if (!impl_->device_ready) {
    error = impl_->device_diagnostic;
    return false;
  }
  const auto buffer = impl_->active.load(std::memory_order_acquire);
  if (!buffer) {
    error = "No playback preview is loaded for the committed graph revision.";
    return false;
  }
  if (impl_->cursor.load(std::memory_order_acquire) >= buffer->frames) impl_->cursor.store(0U, std::memory_order_release);
  impl_->playing.store(true, std::memory_order_release);
  return true;
}

void RealtimePlayback::pause() { impl_->playing.store(false, std::memory_order_release); }

void RealtimePlayback::stop() {
  impl_->playing.store(false, std::memory_order_release);
  impl_->cursor.store(0U, std::memory_order_release);
}

void RealtimePlayback::seek(const std::uint64_t sample) {
  const auto buffer = impl_->active.load(std::memory_order_acquire);
  impl_->cursor.store(buffer ? std::min(sample, buffer->frames) : sample, std::memory_order_release);
}

void RealtimePlayback::set_loop(const bool enabled, const std::uint64_t start_sample, const std::uint64_t end_sample) {
  impl_->loop_enabled.store(enabled, std::memory_order_release);
  impl_->loop_start.store(start_sample, std::memory_order_release);
  impl_->loop_end.store(std::max(start_sample + 1U, end_sample), std::memory_order_release);
}

}  // namespace aimuse::audio
