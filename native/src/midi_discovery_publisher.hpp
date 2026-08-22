#pragma once

#include "midi_port_registry.hpp"

#include <mutex>
#include <string_view>
#include <unordered_set>

namespace aimuse::midi {

struct AdapterDiscoveryStatus {
  bool backend_connected{false};
  DiscoverySnapshot snapshot{};
};

// Owns one live discovery cycle. Platform callbacks may arrive on arbitrary
// watcher threads, so this is the only path that changes the shared registry.
// The initial scan does not change that registry until both direction watchers
// complete; later callbacks publish a single direction-qualified snapshot.
class DiscoveryPublisher {
 public:
  explicit DiscoveryPublisher(PortRegistry& registry);

  void begin();
  void stop();
  void added(PortDirection direction, std::string_view id);
  void removed(PortDirection direction, std::string_view id);
  void enumeration_completed(PortDirection direction);
  void updated(PortDirection direction, std::string_view id);
  [[nodiscard]] AdapterDiscoveryStatus snapshot() const;

 private:
  void publish_locked();

  PortRegistry& registry_;
  mutable std::mutex mutex_;
  bool backend_connected_{false};
  bool input_complete_{false};
  bool output_complete_{false};
  std::unordered_set<std::string> input_ids_;
  std::unordered_set<std::string> output_ids_;
};

}  // namespace aimuse::midi
