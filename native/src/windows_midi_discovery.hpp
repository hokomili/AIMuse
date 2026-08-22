#pragma once

#include "midi_discovery_publisher.hpp"

#include <memory>

namespace aimuse::midi {

// Owns the service thread's Windows Runtime apartment. The normal service
// constructs and destroys this non-movable guard on its main thread, outside
// the discovery adapter lifetime, so every successful initialization has a
// same-thread uninitialization even when watcher setup fails.
class WindowsRuntimeApartment {
 public:
  WindowsRuntimeApartment() noexcept;
  ~WindowsRuntimeApartment() noexcept;
  WindowsRuntimeApartment(const WindowsRuntimeApartment&) = delete;
  WindowsRuntimeApartment& operator=(const WindowsRuntimeApartment&) = delete;

  [[nodiscard]] bool ready() const noexcept;

 private:
  bool initialized_{false};
};

// Windows-only discovery adapter. It intentionally owns only selector/watch
// lifetime; it never opens a port or processes MIDI bytes. On non-Windows the
// normal build supplies the same unavailable status without loading a platform
// API. The apartment guard must outlive this adapter.
class WindowsMidiDiscoveryAdapter {
 public:
  WindowsMidiDiscoveryAdapter(PortRegistry& registry, const WindowsRuntimeApartment& apartment);
  ~WindowsMidiDiscoveryAdapter();
  WindowsMidiDiscoveryAdapter(const WindowsMidiDiscoveryAdapter&) = delete;
  WindowsMidiDiscoveryAdapter& operator=(const WindowsMidiDiscoveryAdapter&) = delete;

  [[nodiscard]] bool start();
  void stop() noexcept;
  [[nodiscard]] AdapterDiscoveryStatus snapshot() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace aimuse::midi
