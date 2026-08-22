#include "audio_service_options.hpp"
#include "dsp.hpp"
#include "midi_discovery_publisher.hpp"
#include "midi_port_registry.hpp"
#include "realtime_playback.hpp"
#include "windows_midi_discovery.hpp"

#include <array>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace {

bool near(const float left, const float right, const float tolerance = 1.0e-4F) { return std::abs(left - right) <= tolerance; }
void expect(const bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

void gain_null_and_pan_test() {
  std::array<float, 4> left{1.0F, -1.0F, 0.5F, 0.0F};
  std::array<float, 4> right = left;
  aimuse::dsp::StereoGain gain;
  gain.set_gain_db(0.0F);
  gain.set_pan(0.0F);
  gain.process(left.data(), right.data(), left.size());
  expect(near(left[0], 0.70710678F), "center pan left golden mismatch");
  expect(near(right[1], -0.70710678F), "center pan right golden mismatch");
  gain.set_gain_db(-120.0F);
  gain.process(left.data(), right.data(), left.size());
  expect(aimuse::dsp::peak(left.data(), left.size()) < 1.0e-5F, "minus infinity gain null failed");
}

void low_pass_stability_test() {
  aimuse::dsp::BiquadLowPass filter;
  filter.configure(48000.0F, 1000.0F, 0.70710678F);
  float output = filter.process(1.0F);
  expect(std::isfinite(output), "low-pass impulse was not finite");
  for (int index = 0; index < 48000; ++index) output = filter.process(1.0F);
  expect(near(output, 1.0F, 2.0e-3F), "low-pass DC response mismatch");
  filter.reset();
  expect(std::isfinite(filter.process(0.0F)), "low-pass reset produced invalid output");
}

void compression_test() {
  aimuse::dsp::Compressor compressor;
  compressor.configure(48000.0F, -18.0F, 4.0F, 0.0001F, 0.1F);
  float output = 0.0F;
  for (int index = 0; index < 48000; ++index) output = compressor.process(1.0F);
  expect(output > 0.0F && output < 0.3F, "compressor gain reduction mismatch");
}

void delay_impulse_test() {
  aimuse::dsp::FractionalDelay delay(64U);
  delay.configure(10.0F, 0.0F, 1.0F);
  for (int index = 0; index < 20; ++index) {
    const float output = delay.process(index == 0 ? 1.0F : 0.0F);
    if (index == 10) expect(near(output, 1.0F), "delay impulse did not arrive at configured sample");
    else expect(near(output, 0.0F), "delay emitted an unexpected sample");
  }
}

void deterministic_synth_test() {
  constexpr std::size_t frames = 48000U;
  std::vector<float> left_a(frames), right_a(frames), left_b(frames), right_b(frames);
  const aimuse::dsp::SynthNote note{0, 24000, 69, 0.8F};
  aimuse::dsp::render_sine_note(note, 0, 48000.0F, left_a.data(), right_a.data(), frames);
  aimuse::dsp::render_sine_note(note, 0, 48000.0F, left_b.data(), right_b.data(), frames);
  expect(left_a == left_b && right_a == right_b, "offline synth render was not deterministic");
  expect(aimuse::dsp::peak(left_a.data(), frames) > 0.09F, "offline synth peak was too low");
  expect(aimuse::dsp::peak(left_a.data(), frames) <= 0.1F, "offline synth peak exceeded golden bound");
  expect(near(left_a.back(), 0.0F), "offline synth tail did not return to zero");
}

void realtime_playback_callback_test() {
  aimuse::audio::PlaybackBuffer buffer;
  buffer.sample_rate = 48'000U;
  buffer.frames = 4U;
  buffer.interleaved_stereo = {0.1F, 0.2F, 0.3F, 0.4F, 0.5F, 0.6F, 0.7F, 0.8F};

  std::array<float, 12> one_shot{};
  aimuse::audio::PlaybackWindow one_shot_window{0U, 0U, 0U, false, true};
  const auto rendered = aimuse::audio::render_playback_frames(buffer, one_shot_window, one_shot.data(), one_shot.size() / 2U);
  expect(rendered == 4U, "real-time callback rendered the wrong one-shot length");
  expect(!one_shot_window.playing && one_shot_window.cursor == 4U, "real-time callback did not stop at preview EOF");
  expect(near(one_shot[0], 0.1F) && near(one_shot[7], 0.8F), "real-time callback changed source samples");
  expect(near(one_shot[8], 0.0F) && near(one_shot[11], 0.0F), "real-time callback did not null its tail");

  std::array<float, 14> looped{};
  aimuse::audio::PlaybackWindow loop_window{0U, 1U, 3U, true, true};
  expect(aimuse::audio::render_playback_frames(buffer, loop_window, looped.data(), looped.size() / 2U) == 7U, "loop callback ended early");
  expect(loop_window.playing && loop_window.cursor == 3U, "loop callback cursor mismatch");
  expect(near(looped[0], 0.1F) && near(looped[2], 0.3F) && near(looped[4], 0.5F), "loop callback intro mismatch");
  expect(near(looped[6], 0.3F) && near(looped[8], 0.5F) && near(looped[12], 0.5F), "loop callback boundary was not sample exact");
}

void playback_callback_timing_test() {
  constexpr auto exact_budget = 5'333'334U;
  const auto exact = aimuse::audio::playback_callback_timing(48'000U, 256U, exact_budget);
  expect(exact.budget_nanoseconds == exact_budget, "callback timing budget changed");
  expect(near(static_cast<float>(exact.cpu_load), 1.0F), "exact callback budget did not report full load");
  expect(!exact.overrun, "exact callback deadline must not overrun");

  const auto late = aimuse::audio::playback_callback_timing(48'000U, 256U, exact_budget + 1U);
  expect(late.overrun, "late callback did not report an overrun");
  expect(late.cpu_load > 1.0, "late callback load did not exceed one");

  const auto no_budget = aimuse::audio::playback_callback_timing(0U, 256U, 1U);
  expect(no_budget.budget_nanoseconds == 0U && near(static_cast<float>(no_budget.cpu_load), 0.0F) && !no_budget.overrun,
    "zero-rate callback timing must remain inactive");

  aimuse::audio::PlaybackCallbackTelemetry telemetry;
  telemetry.record(exact);
  expect(near(static_cast<float>(telemetry.latest_cpu_load()), 1.0F) && telemetry.overruns() == 0U,
    "callback telemetry did not publish one completed callback sample");
  telemetry.record(late);
  expect(near(static_cast<float>(telemetry.latest_cpu_load()), 1.0F) && telemetry.overruns() == 1U,
    "callback telemetry did not retain a sub-millionth late callback overrun");
  const auto very_late = aimuse::audio::playback_callback_timing(48'000U, 256U, exact_budget * 2U);
  telemetry.record(very_late);
  expect(telemetry.latest_cpu_load() > 1.0 && telemetry.overruns() == 2U,
    "callback telemetry did not replace the latest sample or retain cumulative overruns");
}

void playback_mode_contract_test() {
  constexpr std::array<std::string_view, 0U> default_arguments{};
  const auto defaults = aimuse::audio::parse_audio_service_options(default_arguments);
  expect(defaults.ok && defaults.options.playback_mode == aimuse::audio::PlaybackMode::shared,
    "audio service default playback mode was not shared");

  constexpr std::array exclusive_arguments{std::string_view{"--stdio"}, std::string_view{"--playback-mode=exclusive"}};
  const auto exclusive = aimuse::audio::parse_audio_service_options(exclusive_arguments);
  expect(exclusive.ok && exclusive.options.playback_mode == aimuse::audio::PlaybackMode::exclusive,
    "audio service exclusive opt-in was not parsed");
  expect(aimuse::audio::playback_mode_name(exclusive.options.playback_mode) == "exclusive",
    "exclusive playback mode diagnostic name changed");

  constexpr std::array shared_arguments{std::string_view{"--playback-mode=shared"}};
  const auto shared = aimuse::audio::parse_audio_service_options(shared_arguments);
  expect(shared.ok && shared.options.playback_mode == aimuse::audio::PlaybackMode::shared,
    "explicit shared playback mode was not parsed");

  constexpr std::array invalid_arguments{std::string_view{"--playback-mode=automatic"}};
  expect(!aimuse::audio::parse_audio_service_options(invalid_arguments).ok,
    "unsupported playback mode did not fail closed");
  constexpr std::array duplicate_arguments{
    std::string_view{"--playback-mode=shared"},
    std::string_view{"--playback-mode=exclusive"},
  };
  expect(!aimuse::audio::parse_audio_service_options(duplicate_arguments).ok,
    "duplicate playback mode did not fail closed");
}

void playback_device_health_test() {
  aimuse::audio::PlaybackDeviceHealth health;
  expect(!health.ready(), "device health should begin unavailable");
  health.notify(aimuse::audio::PlaybackDeviceNotification::started);
  expect(health.ready(), "device start did not make playback ready");
  health.notify(aimuse::audio::PlaybackDeviceNotification::rerouted);
  expect(health.ready() && health.reroutes() == 1U, "successful device reroute was not retained");
  health.notify(aimuse::audio::PlaybackDeviceNotification::interruption_began);
  expect(!health.ready() && health.interruption_active() && health.interruptions() == 1U,
    "device interruption did not fail playback closed");
  health.notify(aimuse::audio::PlaybackDeviceNotification::interruption_ended);
  expect(health.ready() && !health.interruption_active(), "device interruption recovery did not restore readiness");
  health.notify(aimuse::audio::PlaybackDeviceNotification::stopped, true);
  expect(!health.ready() && health.unexpected_stops() == 0U, "expected device stop was reported as a loss");
  health.notify(aimuse::audio::PlaybackDeviceNotification::started);
  health.notify(aimuse::audio::PlaybackDeviceNotification::stopped);
  expect(!health.ready() && health.unexpected_stops() == 1U, "unexpected device stop did not fail playback closed");
}

void midi_port_registry_test() {
  aimuse::midi::PortRegistry ports;
  expect(ports.snapshot().generation == 0U && ports.snapshot().ports.empty(), "MIDI registry did not begin unavailable");
  expect(!ports.replace_discovered({ {"", aimuse::midi::PortDirection::input} }), "empty MIDI port IDs must not be visible");
  expect(ports.snapshot().generation == 0U && ports.snapshot().ports.empty(), "invalid discovery changed MIDI visibility");
  expect(!ports.replace_discovered({
    {"winrt:input-a", aimuse::midi::PortDirection::input},
    {"winrt:input-a", aimuse::midi::PortDirection::input},
  }), "duplicate MIDI direction/ID pairs must not be visible");

  expect(ports.replace_discovered({
    {"winrt:duplex-a", aimuse::midi::PortDirection::output},
    {"winrt:duplex-a", aimuse::midi::PortDirection::input},
  }), "distinct MIDI directions for one endpoint must be visible");
  const auto first = ports.snapshot();
  expect(first.generation == 1U && first.ports.size() == 2U, "MIDI discovery did not publish the first coherent snapshot");
  const auto lease = ports.reserve("winrt:duplex-a", aimuse::midi::PortDirection::input);
  expect(lease.has_value() && ports.current(*lease), "current MIDI port did not reserve a generation-bound lease");
  expect(ports.replace_discovered({
    {"winrt:duplex-a", aimuse::midi::PortDirection::input},
    {"winrt:duplex-a", aimuse::midi::PortDirection::output},
  }), "reordered unchanged discovery should succeed");
  expect(ports.snapshot().generation == first.generation && ports.current(*lease), "reordered discovery changed a live MIDI lease");
  expect(ports.replace_discovered({}), "MIDI disconnect snapshot failed");
  expect(!ports.current(*lease) && !ports.reserve("winrt:duplex-a", aimuse::midi::PortDirection::input).has_value(),
    "disconnected MIDI port retained a usable lease");
  expect(ports.replace_discovered({ {"winrt:duplex-a", aimuse::midi::PortDirection::input} }), "MIDI reconnect snapshot failed");
  expect(!ports.current(*lease), "reconnected MIDI port resurrected a stale lease");
}

void midi_discovery_publisher_test() {
  aimuse::midi::PortRegistry registry;
  aimuse::midi::DiscoveryPublisher publisher(registry);
  publisher.begin();
  expect(publisher.snapshot().backend_connected && publisher.snapshot().snapshot.ports.empty(),
    "MIDI watcher began with visible partial discovery");
  publisher.added(aimuse::midi::PortDirection::input, "interface:input-a");
  publisher.added(aimuse::midi::PortDirection::input, "interface:input-a");
  publisher.added(aimuse::midi::PortDirection::output, "interface:output-a");
  expect(publisher.snapshot().snapshot.ports.empty(), "initial MIDI discovery exposed one completed direction");
  expect(registry.snapshot().generation == 0U && registry.snapshot().ports.empty(),
    "initial MIDI discovery changed the shared registry before both directions completed");
  publisher.enumeration_completed(aimuse::midi::PortDirection::input);
  expect(publisher.snapshot().snapshot.ports.empty(), "initial MIDI discovery exposed before both directions completed");
  expect(registry.snapshot().generation == 0U && registry.snapshot().ports.empty(),
    "one completed MIDI direction changed the shared registry");
  publisher.enumeration_completed(aimuse::midi::PortDirection::output);
  const auto visible = publisher.snapshot();
  expect(visible.backend_connected && visible.snapshot.generation == 1U && visible.snapshot.ports.size() == 2U,
    "completed MIDI discovery did not expose both direction-qualified ports");
  const auto input = registry.reserve("interface:input-a", aimuse::midi::PortDirection::input);
  expect(input.has_value() && registry.current(*input), "visible MIDI input did not reserve a current lease");
  publisher.updated(aimuse::midi::PortDirection::input, "interface:input-a");
  expect(registry.current(*input), "MIDI property update changed endpoint identity");
  publisher.removed(aimuse::midi::PortDirection::input, "interface:input-a");
  expect(!registry.current(*input), "MIDI removal retained stale endpoint lease");
  publisher.stop();
  expect(!publisher.snapshot().backend_connected && publisher.snapshot().snapshot.ports.empty(),
    "stopped MIDI watcher retained visibility");
}

#if !defined(_WIN32)
void windows_midi_discovery_stub_test() {
  aimuse::midi::WindowsRuntimeApartment apartment;
  aimuse::midi::PortRegistry registry;
  aimuse::midi::WindowsMidiDiscoveryAdapter adapter(registry, apartment);
  expect(!apartment.ready() && !adapter.start(), "non-Windows MIDI adapter reported a connected runtime");
  expect(!adapter.snapshot().backend_connected && adapter.snapshot().snapshot.ports.empty(),
    "non-Windows MIDI adapter exposed discovery state");
  adapter.stop();
  adapter.stop();
}
#endif

}  // namespace

int main() {
  gain_null_and_pan_test();
  low_pass_stability_test();
  compression_test();
  delay_impulse_test();
  deterministic_synth_test();
  realtime_playback_callback_test();
  playback_callback_timing_test();
  playback_mode_contract_test();
  playback_device_health_test();
  midi_port_registry_test();
  midi_discovery_publisher_test();
#if !defined(_WIN32)
  windows_midi_discovery_stub_test();
#endif
  std::cout << "AIMuse native DSP tests passed\n";
  return 0;
}
