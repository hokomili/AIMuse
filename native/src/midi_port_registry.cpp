#include "midi_port_registry.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace aimuse::midi {
namespace {

bool descriptor_less(const PortDescriptor& left, const PortDescriptor& right) {
  if (left.direction != right.direction) return left.direction == PortDirection::input;
  return left.id < right.id;
}

bool valid(const std::vector<PortDescriptor>& ports) {
  if (std::any_of(ports.begin(), ports.end(), [](const PortDescriptor& port) { return port.id.empty(); })) return false;
  return std::adjacent_find(ports.begin(), ports.end(), [](const PortDescriptor& left, const PortDescriptor& right) {
    return left.id == right.id && left.direction == right.direction;
  }) == ports.end();
}

}  // namespace

bool PortRegistry::replace_discovered(std::vector<PortDescriptor> ports) {
  std::sort(ports.begin(), ports.end(), descriptor_less);
  if (!valid(ports)) return false;
  if (ports == ports_) return true;
  if (generation_ == std::numeric_limits<std::uint64_t>::max()) return false;
  ports_ = std::move(ports);
  ++generation_;
  return true;
}

DiscoverySnapshot PortRegistry::snapshot() const { return { generation_, ports_ }; }

std::optional<PortLease> PortRegistry::reserve(const std::string_view id, const PortDirection direction) const {
  const auto found = std::find_if(ports_.begin(), ports_.end(), [id, direction](const PortDescriptor& port) {
    return port.id == id && port.direction == direction;
  });
  if (found == ports_.end()) return std::nullopt;
  return PortLease{ generation_, found->id, found->direction };
}

bool PortRegistry::current(const PortLease& lease) const {
  if (lease.generation != generation_) return false;
  return std::any_of(ports_.begin(), ports_.end(), [&lease](const PortDescriptor& port) {
    return port.id == lease.id && port.direction == lease.direction;
  });
}

}  // namespace aimuse::midi
