#include "audio_service_options.hpp"
#include "protocol.hpp"
#include "realtime_playback.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

struct EngineState {
  std::string project_id;
  std::int64_t graph_revision{0};
  std::int64_t prepared_revision{-1};
  std::int64_t tick{0};
  std::int64_t sample{0};
  std::int64_t loop_start{0};
  std::int64_t loop_end{15360};
  std::int64_t loop_start_sample{0};
  std::int64_t loop_end_sample{0};
  bool loop_enabled{false};
  std::string status{"stopped"};
};

std::string_view effective_playback_mode_name(const aimuse::audio::RealtimePlayback& playback) {
  const auto effective_mode = playback.effective_mode();
  return effective_mode ? aimuse::audio::playback_mode_name(*effective_mode) : "unavailable";
}

std::string state_json(const EngineState& state, const aimuse::audio::RealtimePlayback& playback) {
  return "{\"status\":\"" + state.status + "\",\"tick\":" + std::to_string(state.tick) +
    ",\"sample\":" + std::to_string(state.sample) + ",\"loopEnabled\":" + (state.loop_enabled ? "true" : "false") +
    ",\"loopStartTick\":" + std::to_string(state.loop_start) + ",\"loopEndTick\":" + std::to_string(state.loop_end) +
    ",\"cpuLoad\":0,\"xruns\":0,\"latencySamples\":" + std::to_string(playback.latency_samples()) +
    ",\"graphRevision\":" + std::to_string(state.graph_revision) + ",\"requestedPlaybackMode\":\"" +
    std::string(aimuse::audio::playback_mode_name(playback.requested_mode())) + "\",\"effectivePlaybackMode\":\"" +
    std::string(effective_playback_mode_name(playback)) + "\"}";
}

std::filesystem::path path_from_utf8(const std::string& value) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(value.data()), value.size()));
}

}  // namespace

int main(const int argc, char* argv[]) {
  std::vector<std::string_view> arguments;
  arguments.reserve(argc > 1 ? static_cast<std::size_t>(argc - 1) : 0U);
  for (int index = 1; index < argc; ++index) arguments.emplace_back(argv[index]);
  const auto parsed_options = aimuse::audio::parse_audio_service_options(arguments);
  if (!parsed_options.ok) {
    std::cerr << parsed_options.error << '\n';
    return 2;
  }
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  EngineState state;
  aimuse::audio::RealtimePlayback playback(parsed_options.options.playback_mode);
  std::string line;
  while (std::getline(std::cin, line)) {
    const auto id = aimuse::protocol::string_field(line, "id").value_or("unknown");
    const auto method = aimuse::protocol::string_field(line, "method");
    if (line.size() > 64U * 1024U * 1024U) {
      std::cout << aimuse::protocol::failure(id, "request-too-large", "Native protocol request exceeded 64 MiB.", false) << '\n' << std::flush;
      continue;
    }
    if (!method) {
      std::cout << aimuse::protocol::failure(id, "invalid-request", "Request method is missing.", false) << '\n' << std::flush;
      continue;
    }

    if (*method == "hello") {
      const std::string result = "{\"protocolVersion\":1,\"serviceVersion\":\"" AIMUSE_NATIVE_VERSION
        "\",\"driver\":\"" + playback.driver() + "\",\"requestedPlaybackMode\":\"" +
        std::string(aimuse::audio::playback_mode_name(playback.requested_mode())) + "\",\"effectivePlaybackMode\":\"" +
        std::string(effective_playback_mode_name(playback)) + "\",\"sampleFormat\":\"float32\",\"realtimeBackendReady\":" +
        (playback.ready() ? "true" : "false") + ",\"sampleRate\":" + std::to_string(playback.sample_rate()) +
        ",\"latencySamples\":" + std::to_string(playback.latency_samples()) + ",\"diagnostic\":\"" +
        aimuse::protocol::escape(playback.diagnostic()) +
        "\",\"features\":[\"graph-prepare\",\"graph-commit\",\"transport-ack\",\"dsp-kernel\",\"managed-preview-playback\",\"wasapi-exclusive-opt-in\"]}";
      std::cout << aimuse::protocol::success(id, result) << '\n' << std::flush;
      continue;
    }
    if (*method == "prepare-project") {
      state.prepared_revision = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "revision").value_or(0));
      std::cout << aimuse::protocol::success(id, "{\"graphRevision\":" + std::to_string(state.prepared_revision) + ",\"prepared\":true}") << '\n' << std::flush;
      continue;
    }
    if (*method == "commit-project") {
      const auto revision = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "revision").value_or(0));
      if (revision != state.prepared_revision) {
        std::cout << aimuse::protocol::failure(id, "graph-revision-mismatch", "Committed graph does not match the prepared revision.", true) << '\n' << std::flush;
        continue;
      }
      const auto next_project_id = aimuse::protocol::string_field(line, "projectId").value_or("");
      const bool project_changed = !state.project_id.empty() && next_project_id != state.project_id;
      state.project_id = next_project_id;
      state.graph_revision = revision; state.prepared_revision = -1;
      if (project_changed) {
        state.status = "stopped"; state.tick = 0; state.sample = 0;
        playback.clear_preview();
      } else {
        state.sample = static_cast<std::int64_t>(std::min<std::uint64_t>(playback.cursor(), static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())));
      }
      std::cout << aimuse::protocol::success(id, "{\"graphRevision\":" + std::to_string(state.graph_revision) + ",\"committed\":true}") << '\n' << std::flush;
      continue;
    }
    if (*method == "abort-project") {
      state.prepared_revision = -1;
      std::cout << aimuse::protocol::success(id, "{\"aborted\":true}") << '\n' << std::flush;
      continue;
    }
    if (*method == "load-playback") {
      const auto project_id = aimuse::protocol::string_field(line, "projectId").value_or("");
      const auto revision = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "revision").value_or(-1));
      const auto preview_path = aimuse::protocol::string_field(line, "previewPath");
      if (project_id != state.project_id || revision != state.graph_revision) {
        std::cout << aimuse::protocol::failure(id, "graph-revision-mismatch", "Playback preview does not match the committed project graph.", true) << '\n' << std::flush;
        continue;
      }
      if (!preview_path) {
        std::cout << aimuse::protocol::failure(id, "invalid-preview", "Playback preview path is missing.", false) << '\n' << std::flush;
        continue;
      }
      std::string error;
      const bool preserve_transport = aimuse::protocol::boolean_field(line, "preserveTransport", false);
      if (!playback.load_preview(path_from_utf8(*preview_path), preserve_transport, error)) {
        std::cout << aimuse::protocol::failure(id, "playback-load-failed", error, true) << '\n' << std::flush;
        continue;
      }
      state.sample = static_cast<std::int64_t>(std::min<std::uint64_t>(playback.cursor(), static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())));
      std::cout << aimuse::protocol::success(id, "{\"loaded\":true,\"graphRevision\":" + std::to_string(state.graph_revision) +
        ",\"sampleRate\":" + std::to_string(playback.sample_rate()) + "}") << '\n' << std::flush;
      continue;
    }
    if (*method == "transport") {
      const auto action = aimuse::protocol::string_field(line, "action").value_or("");
      const auto requested_tick = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "tick").value_or(state.tick));
      const auto requested_sample = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "sample").value_or(state.sample));
      state.loop_enabled = aimuse::protocol::boolean_field(line, "loopEnabled", state.loop_enabled);
      state.loop_start = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "loopStartTick").value_or(state.loop_start));
      state.loop_end = std::max(state.loop_start + 1, aimuse::protocol::integer_field(line, "loopEndTick").value_or(state.loop_end));
      state.loop_start_sample = std::max<std::int64_t>(0, aimuse::protocol::integer_field(line, "loopStartSample").value_or(state.loop_start_sample));
      state.loop_end_sample = std::max(state.loop_start_sample + 1, aimuse::protocol::integer_field(line, "loopEndSample").value_or(state.loop_end_sample));
      playback.set_loop(state.loop_enabled, static_cast<std::uint64_t>(state.loop_start_sample), static_cast<std::uint64_t>(state.loop_end_sample));
      if (action == "play" || action == "record") {
        state.tick = requested_tick;
        playback.seek(static_cast<std::uint64_t>(requested_sample));
        std::string error;
        if (!playback.play(error)) {
          std::cout << aimuse::protocol::failure(id, "playback-unavailable", error, true) << '\n' << std::flush;
          continue;
        }
        state.status = action == "play" ? "playing" : "recording";
      }
      else if (action == "pause") { playback.pause(); state.status = "paused"; }
      else if (action == "stop") { playback.stop(); state.status = "stopped"; state.tick = 0; state.sample = 0; }
      else if (action == "seek") {
        state.tick = requested_tick;
        playback.seek(static_cast<std::uint64_t>(requested_sample));
      }
      else if (action == "loop") {
      } else {
        std::cout << aimuse::protocol::failure(id, "invalid-transport-action", "Unsupported transport action.", false) << '\n' << std::flush;
        continue;
      }
      const auto cursor = std::min<std::uint64_t>(playback.cursor(), static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()));
      state.sample = static_cast<std::int64_t>(cursor);
      std::cout << aimuse::protocol::success(id, state_json(state, playback)) << '\n' << std::flush;
      continue;
    }
    if (*method == "render") {
      std::cout << aimuse::protocol::failure(id, "native-render-unavailable", "The dependency-free service build does not include native media codecs; use the deterministic host renderer.", false) << '\n' << std::flush;
      continue;
    }
    if (*method == "shutdown") {
      std::cout << aimuse::protocol::success(id, "{\"stopped\":true}") << '\n' << std::flush;
      break;
    }
    std::cout << aimuse::protocol::failure(id, "method-not-found", "Unknown native audio method.", false) << '\n' << std::flush;
  }
  return 0;
}
