#include "midi_discovery_publisher.hpp"

#include <vector>

namespace aimuse::midi {

DiscoveryPublisher::DiscoveryPublisher(PortRegistry& registry) : registry_(registry) {}

void DiscoveryPublisher::begin() {
  std::scoped_lock lock(mutex_);
  backend_connected_ = true;
  input_complete_ = false;
  output_complete_ = false;
  input_ids_.clear();
  output_ids_.clear();
  const bool reset = registry_.replace_discovered({});
  (void)reset;
}

void DiscoveryPublisher::stop() {
  std::scoped_lock lock(mutex_);
  backend_connected_ = false;
  input_complete_ = false;
  output_complete_ = false;
  input_ids_.clear();
  output_ids_.clear();
  const bool reset = registry_.replace_discovered({});
  (void)reset;
}

void DiscoveryPublisher::added(const PortDirection direction, const std::string_view id) {
  if (id.empty()) return;
  std::scoped_lock lock(mutex_);
  if (!backend_connected_) return;
  auto& ids = direction == PortDirection::input ? input_ids_ : output_ids_;
  if (!ids.insert(std::string(id)).second) return;
  if (input_complete_ && output_complete_) publish_locked();
}

void DiscoveryPublisher::removed(const PortDirection direction, const std::string_view id) {
  std::scoped_lock lock(mutex_);
  if (!backend_connected_) return;
  auto& ids = direction == PortDirection::input ? input_ids_ : output_ids_;
  if (ids.erase(std::string(id)) == 0U) return;
  if (input_complete_ && output_complete_) publish_locked();
}

void DiscoveryPublisher::enumeration_completed(const PortDirection direction) {
  std::scoped_lock lock(mutex_);
  if (!backend_connected_) return;
  if (direction == PortDirection::input) input_complete_ = true;
  else output_complete_ = true;
  if (input_complete_ && output_complete_) publish_locked();
}

void DiscoveryPublisher::updated(const PortDirection direction, const std::string_view id) {
  std::scoped_lock lock(mutex_);
  if (!backend_connected_ || id.empty()) return;
  const auto& ids = direction == PortDirection::input ? input_ids_ : output_ids_;
  if (!ids.contains(std::string(id))) return;
  // DeviceInformationUpdate preserves its ID. No display/property update may
  // redefine the opaque endpoint identity or force a new lease generation.
}

AdapterDiscoveryStatus DiscoveryPublisher::snapshot() const {
  std::scoped_lock lock(mutex_);
  auto visible = registry_.snapshot();
  if (!backend_connected_ || !input_complete_ || !output_complete_) visible.ports.clear();
  return { backend_connected_, std::move(visible) };
}

void DiscoveryPublisher::publish_locked() {
  std::vector<PortDescriptor> ports;
  ports.reserve(input_ids_.size() + output_ids_.size());
  for (const auto& id : input_ids_) ports.push_back({ id, PortDirection::input });
  for (const auto& id : output_ids_) ports.push_back({ id, PortDirection::output });
  const bool published = registry_.replace_discovered(std::move(ports));
  (void)published;
}

}  // namespace aimuse::midi
