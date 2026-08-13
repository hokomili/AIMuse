#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace aimuse::midi {

// A backend supplies an opaque, stable identifier for one physical endpoint in
// one direction. The registry does not derive IDs from a display name or
// position, so a future backend must preserve the ID while that endpoint stays
// present.
enum class PortDirection { input, output };

struct PortDescriptor {
  std::string id;
  PortDirection direction;

  friend bool operator==(const PortDescriptor&, const PortDescriptor&) = default;
};

struct PortLease {
  std::uint64_t generation;
  std::string id;
  PortDirection direction;

  friend bool operator==(const PortLease&, const PortLease&) = default;
};

struct DiscoverySnapshot {
  std::uint64_t generation;
  std::vector<PortDescriptor> ports;
};

// Visibility is deliberately separate from endpoint opening. A caller may
// reserve a currently visible descriptor, but any future backend must re-check
// that lease immediately before opening it. A removed or reconnected port has
// a newer generation and cannot reuse a stale lease.
class PortRegistry {
 public:
  [[nodiscard]] bool replace_discovered(std::vector<PortDescriptor> ports);
  [[nodiscard]] DiscoverySnapshot snapshot() const;
  [[nodiscard]] std::optional<PortLease> reserve(std::string_view id, PortDirection direction) const;
  [[nodiscard]] bool current(const PortLease& lease) const;

 private:
  std::uint64_t generation_{0U};
  std::vector<PortDescriptor> ports_;
};

}  // namespace aimuse::midi
