#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace aimuse::dsp {

constexpr float kPi = 3.14159265358979323846F;

float decibels_to_gain(float decibels) noexcept;
float gain_to_decibels(float gain) noexcept;
float clamp_sample(float sample) noexcept;
float peak(const float* samples, std::size_t frames) noexcept;

class StereoGain final {
 public:
  void set_gain_db(float decibels) noexcept;
  void set_pan(float pan) noexcept;
  void process(float* left, float* right, std::size_t frames) const noexcept;

 private:
  float gain_{1.0F};
  float left_{0.70710678F};
  float right_{0.70710678F};
};

class BiquadLowPass final {
 public:
  void configure(float sample_rate, float frequency, float q) noexcept;
  void reset() noexcept;
  float process(float input) noexcept;

 private:
  float b0_{1.0F};
  float b1_{0.0F};
  float b2_{0.0F};
  float a1_{0.0F};
  float a2_{0.0F};
  float z1_{0.0F};
  float z2_{0.0F};
};

class Compressor final {
 public:
  void configure(float sample_rate, float threshold_db, float ratio, float attack_seconds, float release_seconds) noexcept;
  void reset() noexcept;
  float process(float input) noexcept;

 private:
  float threshold_db_{-18.0F};
  float ratio_{4.0F};
  float attack_{0.99F};
  float release_{0.999F};
  float envelope_{0.0F};
};

class FractionalDelay final {
 public:
  explicit FractionalDelay(std::size_t maximum_samples = 192000U);
  void configure(float delay_samples, float feedback, float mix) noexcept;
  void reset() noexcept;
  float process(float input) noexcept;

 private:
  std::vector<float> buffer_;
  std::size_t write_index_{0U};
  float delay_samples_{1.0F};
  float feedback_{0.25F};
  float mix_{0.25F};
};

struct SynthNote {
  std::int64_t start_sample{};
  std::int64_t end_sample{};
  int midi_pitch{60};
  float velocity{0.8F};
};

void render_sine_note(const SynthNote& note, std::int64_t window_start, float sample_rate, float* left, float* right, std::size_t frames) noexcept;

}  // namespace aimuse::dsp
