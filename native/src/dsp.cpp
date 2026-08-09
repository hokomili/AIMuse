#include "dsp.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace aimuse::dsp {

float decibels_to_gain(const float decibels) noexcept { return std::pow(10.0F, decibels / 20.0F); }
float gain_to_decibels(const float gain) noexcept { return gain <= 0.0F ? -std::numeric_limits<float>::infinity() : 20.0F * std::log10(gain); }
float clamp_sample(const float sample) noexcept { return std::clamp(std::isfinite(sample) ? sample : 0.0F, -1.0F, 1.0F); }

float peak(const float* samples, const std::size_t frames) noexcept {
  float value = 0.0F;
  for (std::size_t index = 0; index < frames; ++index) value = std::max(value, std::abs(samples[index]));
  return value;
}

void StereoGain::set_gain_db(const float decibels) noexcept { gain_ = decibels_to_gain(std::clamp(decibels, -120.0F, 24.0F)); }
void StereoGain::set_pan(const float pan) noexcept {
  const float angle = (std::clamp(pan, -1.0F, 1.0F) + 1.0F) * kPi * 0.25F;
  left_ = std::cos(angle);
  right_ = std::sin(angle);
}
void StereoGain::process(float* left, float* right, const std::size_t frames) const noexcept {
  for (std::size_t index = 0; index < frames; ++index) {
    left[index] *= gain_ * left_;
    right[index] *= gain_ * right_;
  }
}

void BiquadLowPass::configure(const float sample_rate, const float frequency, const float q) noexcept {
  const float safe_rate = std::max(1.0F, sample_rate);
  const float safe_frequency = std::clamp(frequency, 1.0F, safe_rate * 0.495F);
  const float omega = 2.0F * kPi * safe_frequency / safe_rate;
  const float cosine = std::cos(omega);
  const float alpha = std::sin(omega) / (2.0F * std::max(0.01F, q));
  const float normalizer = 1.0F / (1.0F + alpha);
  b0_ = ((1.0F - cosine) * 0.5F) * normalizer;
  b1_ = (1.0F - cosine) * normalizer;
  b2_ = b0_;
  a1_ = (-2.0F * cosine) * normalizer;
  a2_ = (1.0F - alpha) * normalizer;
}
void BiquadLowPass::reset() noexcept { z1_ = z2_ = 0.0F; }
float BiquadLowPass::process(const float input) noexcept {
  const float output = input * b0_ + z1_;
  z1_ = input * b1_ + z2_ - a1_ * output;
  z2_ = input * b2_ - a2_ * output;
  return std::isfinite(output) ? output : 0.0F;
}

void Compressor::configure(const float sample_rate, const float threshold_db, const float ratio, const float attack_seconds, const float release_seconds) noexcept {
  const float safe_rate = std::max(1.0F, sample_rate);
  threshold_db_ = std::clamp(threshold_db, -96.0F, 0.0F);
  ratio_ = std::clamp(ratio, 1.0F, 100.0F);
  attack_ = std::exp(-1.0F / (safe_rate * std::max(0.00001F, attack_seconds)));
  release_ = std::exp(-1.0F / (safe_rate * std::max(0.00001F, release_seconds)));
}
void Compressor::reset() noexcept { envelope_ = 0.0F; }
float Compressor::process(const float input) noexcept {
  const float detector = std::abs(std::isfinite(input) ? input : 0.0F);
  const float coefficient = detector > envelope_ ? attack_ : release_;
  envelope_ = coefficient * envelope_ + (1.0F - coefficient) * detector;
  const float envelope_db = gain_to_decibels(std::max(envelope_, 1.0e-12F));
  const float compressed_db = envelope_db > threshold_db_ ? threshold_db_ + (envelope_db - threshold_db_) / ratio_ : envelope_db;
  return input * decibels_to_gain(compressed_db - envelope_db);
}

FractionalDelay::FractionalDelay(const std::size_t maximum_samples) : buffer_(std::max<std::size_t>(2U, maximum_samples + 2U), 0.0F) {}
void FractionalDelay::configure(const float delay_samples, const float feedback, const float mix) noexcept {
  delay_samples_ = std::clamp(delay_samples, 1.0F, static_cast<float>(buffer_.size() - 2U));
  feedback_ = std::clamp(feedback, -0.99F, 0.99F);
  mix_ = std::clamp(mix, 0.0F, 1.0F);
}
void FractionalDelay::reset() noexcept { std::fill(buffer_.begin(), buffer_.end(), 0.0F); write_index_ = 0U; }
float FractionalDelay::process(const float input) noexcept {
  float position = static_cast<float>(write_index_) - delay_samples_;
  while (position < 0.0F) position += static_cast<float>(buffer_.size());
  const auto first = static_cast<std::size_t>(position) % buffer_.size();
  const auto second = (first + 1U) % buffer_.size();
  const float fraction = position - std::floor(position);
  const float delayed = buffer_[first] + (buffer_[second] - buffer_[first]) * fraction;
  buffer_[write_index_] = clamp_sample(input + delayed * feedback_);
  write_index_ = (write_index_ + 1U) % buffer_.size();
  return input * (1.0F - mix_) + delayed * mix_;
}

void render_sine_note(const SynthNote& note, const std::int64_t window_start, const float sample_rate, float* left, float* right, const std::size_t frames) noexcept {
  const auto first = std::max<std::int64_t>(0, note.start_sample - window_start);
  const auto last = std::min<std::int64_t>(static_cast<std::int64_t>(frames), note.end_sample - window_start);
  if (last <= first || sample_rate <= 0.0F) return;
  const float frequency = 440.0F * std::pow(2.0F, static_cast<float>(note.midi_pitch - 69) / 12.0F);
  const auto attack = std::max<std::int64_t>(1, static_cast<std::int64_t>(sample_rate * 0.008F));
  const auto release = std::max<std::int64_t>(1, static_cast<std::int64_t>(sample_rate * 0.06F));
  for (auto frame = first; frame < last; ++frame) {
    const auto absolute = window_start + frame;
    const auto age = absolute - note.start_sample;
    const auto remaining = note.end_sample - absolute;
    const float envelope = std::min({1.0F, static_cast<float>(age) / static_cast<float>(attack), static_cast<float>(remaining) / static_cast<float>(release)});
    const float value = std::sin(2.0F * kPi * frequency * static_cast<float>(age) / sample_rate) * std::clamp(note.velocity, 0.0F, 1.0F) * envelope * 0.12F;
    left[static_cast<std::size_t>(frame)] += value;
    right[static_cast<std::size_t>(frame)] += value;
  }
}

}  // namespace aimuse::dsp
