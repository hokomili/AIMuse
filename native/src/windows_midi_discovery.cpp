#include "windows_midi_discovery.hpp"

#include <atomic>
#include <mutex>
#include <shared_mutex>
#include <utility>

#if defined(_WIN32)
#include <winrt/Windows.Devices.Enumeration.h>
#include <winrt/Windows.Devices.Midi.h>
#include <winrt/base.h>
#endif

namespace aimuse::midi {

namespace {

// Event handlers retain this state independently of the adapter object. A
// DeviceWatcher may already be delivering an event when Stop begins; that
// event can finish against a stopped publisher without touching freed memory.
class CallbackState {
 public:
  explicit CallbackState(PortRegistry& registry) : publisher(registry) {}

  template <typename Operation>
  void dispatch(Operation&& operation) noexcept {
    try {
      std::shared_lock callback_lock(callback_mutex);
      if (!active.load(std::memory_order_acquire)) return;
      try {
        operation(publisher);
      } catch (...) {
        try {
          publisher.stop();
        } catch (...) {
        }
      }
    } catch (...) {
    }
  }

  void deactivate() noexcept { active.store(false, std::memory_order_release); }

  void clear_after_callbacks() noexcept {
    try {
      std::unique_lock callback_lock(callback_mutex);
      publisher.stop();
    } catch (...) {
    }
  }

  DiscoveryPublisher publisher;
  std::atomic_bool active{false};

 private:
  std::shared_mutex callback_mutex;
};

#if defined(_WIN32)
template <typename Revoke>
void revoke_handler(winrt::event_token& token, Revoke&& revoke) noexcept {
  if (!token) return;
  try {
    revoke(token);
  } catch (...) {
  }
  token = {};
}

void stop_watcher(winrt::Windows::Devices::Enumeration::DeviceWatcher& watcher) noexcept {
  if (!watcher) return;
  try {
    const auto status = watcher.Status();
    using winrt::Windows::Devices::Enumeration::DeviceWatcherStatus;
    if (status == DeviceWatcherStatus::Started || status == DeviceWatcherStatus::EnumerationCompleted) watcher.Stop();
  } catch (...) {
  }
  watcher = nullptr;
}

bool watcher_connected(const winrt::Windows::Devices::Enumeration::DeviceWatcher& watcher) noexcept {
  if (!watcher) return false;
  try {
    const auto status = watcher.Status();
    using winrt::Windows::Devices::Enumeration::DeviceWatcherStatus;
    return status == DeviceWatcherStatus::Started || status == DeviceWatcherStatus::EnumerationCompleted;
  } catch (...) {
    return false;
  }
}
#endif

}  // namespace

class WindowsMidiDiscoveryAdapter::Impl {
 public:
  Impl(PortRegistry& registry_value, const WindowsRuntimeApartment& apartment_value)
      : registry(registry_value), apartment(apartment_value), state(std::make_shared<CallbackState>(registry_value)) {}

  PortRegistry& registry;
  const WindowsRuntimeApartment& apartment;
  std::shared_ptr<CallbackState> state;
  mutable std::mutex lifecycle_mutex;

#if defined(_WIN32)
  winrt::Windows::Devices::Enumeration::DeviceWatcher input_watcher{nullptr};
  winrt::Windows::Devices::Enumeration::DeviceWatcher output_watcher{nullptr};
  winrt::event_token input_added{};
  winrt::event_token input_updated{};
  winrt::event_token input_removed{};
  winrt::event_token input_completed{};
  winrt::event_token input_stopped{};
  winrt::event_token output_added{};
  winrt::event_token output_updated{};
  winrt::event_token output_removed{};
  winrt::event_token output_completed{};
  winrt::event_token output_stopped{};
#endif
};

WindowsRuntimeApartment::WindowsRuntimeApartment() noexcept {
#if defined(_WIN32)
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    initialized_ = true;
  } catch (...) {
  }
#endif
}

WindowsRuntimeApartment::~WindowsRuntimeApartment() noexcept {
#if defined(_WIN32)
  if (initialized_) winrt::uninit_apartment();
#endif
}

bool WindowsRuntimeApartment::ready() const noexcept { return initialized_; }

WindowsMidiDiscoveryAdapter::WindowsMidiDiscoveryAdapter(PortRegistry& registry,
                                                         const WindowsRuntimeApartment& apartment)
    : impl_(std::make_unique<Impl>(registry, apartment)) {}
WindowsMidiDiscoveryAdapter::~WindowsMidiDiscoveryAdapter() { stop(); }

bool WindowsMidiDiscoveryAdapter::start() {
  std::unique_lock lifecycle_lock(impl_->lifecycle_mutex);
  if (impl_->state->active.load(std::memory_order_acquire)) return true;

#if defined(_WIN32)
  if (!impl_->apartment.ready()) {
    impl_->state->clear_after_callbacks();
    return false;
  }
  try {
    auto state = std::make_shared<CallbackState>(impl_->registry);
    state->publisher.begin();
    state->active.store(true, std::memory_order_release);
    impl_->state = state;

    const auto attach = [state](auto& watcher, const PortDirection direction,
                                winrt::event_token& added, winrt::event_token& updated,
                                winrt::event_token& removed, winrt::event_token& completed,
                                winrt::event_token& stopped) {
      added = watcher.Added([state, direction](const auto&, const auto& information) {
        state->dispatch([&](DiscoveryPublisher& publisher) {
          publisher.added(direction, winrt::to_string(information.Id()));
        });
      });
      updated = watcher.Updated([state, direction](const auto&, const auto& information) {
        state->dispatch([&](DiscoveryPublisher& publisher) {
          publisher.updated(direction, winrt::to_string(information.Id()));
        });
      });
      removed = watcher.Removed([state, direction](const auto&, const auto& information) {
        state->dispatch([&](DiscoveryPublisher& publisher) {
          publisher.removed(direction, winrt::to_string(information.Id()));
        });
      });
      completed = watcher.EnumerationCompleted([state, direction](const auto&, const auto&) {
        state->dispatch([&](DiscoveryPublisher& publisher) { publisher.enumeration_completed(direction); });
      });
      stopped = watcher.Stopped([state](const auto&, const auto&) {
        state->dispatch([](DiscoveryPublisher& publisher) { publisher.stop(); });
      });
    };

    impl_->input_watcher = winrt::Windows::Devices::Enumeration::DeviceInformation::CreateWatcher(
      winrt::Windows::Devices::Midi::MidiInPort::GetDeviceSelector());
    impl_->output_watcher = winrt::Windows::Devices::Enumeration::DeviceInformation::CreateWatcher(
      winrt::Windows::Devices::Midi::MidiOutPort::GetDeviceSelector());
    attach(impl_->input_watcher, PortDirection::input, impl_->input_added, impl_->input_updated,
      impl_->input_removed, impl_->input_completed, impl_->input_stopped);
    attach(impl_->output_watcher, PortDirection::output, impl_->output_added, impl_->output_updated,
      impl_->output_removed, impl_->output_completed, impl_->output_stopped);
    impl_->input_watcher.Start();
    impl_->output_watcher.Start();
    return true;
  } catch (...) {
    lifecycle_lock.unlock();
    stop();
    return false;
  }
#else
  impl_->state->publisher.stop();
  return false;
#endif
}

void WindowsMidiDiscoveryAdapter::stop() noexcept {
  std::scoped_lock lifecycle_lock(impl_->lifecycle_mutex);
  const auto state = impl_->state;
  state->deactivate();

#if defined(_WIN32)
  // DeviceWatcher may deliver already-queued events while stopping. Revoke
  // handlers first and make their active guard false before draining callbacks
  // and clearing registry visibility.
  if (impl_->input_watcher) {
    revoke_handler(impl_->input_added, [&](const auto token) { impl_->input_watcher.Added(token); });
    revoke_handler(impl_->input_updated, [&](const auto token) { impl_->input_watcher.Updated(token); });
    revoke_handler(impl_->input_removed, [&](const auto token) { impl_->input_watcher.Removed(token); });
    revoke_handler(impl_->input_completed, [&](const auto token) { impl_->input_watcher.EnumerationCompleted(token); });
    revoke_handler(impl_->input_stopped, [&](const auto token) { impl_->input_watcher.Stopped(token); });
  }
  if (impl_->output_watcher) {
    revoke_handler(impl_->output_added, [&](const auto token) { impl_->output_watcher.Added(token); });
    revoke_handler(impl_->output_updated, [&](const auto token) { impl_->output_watcher.Updated(token); });
    revoke_handler(impl_->output_removed, [&](const auto token) { impl_->output_watcher.Removed(token); });
    revoke_handler(impl_->output_completed, [&](const auto token) { impl_->output_watcher.EnumerationCompleted(token); });
    revoke_handler(impl_->output_stopped, [&](const auto token) { impl_->output_watcher.Stopped(token); });
  }
  stop_watcher(impl_->input_watcher);
  stop_watcher(impl_->output_watcher);
#endif
  state->clear_after_callbacks();
}

AdapterDiscoveryStatus WindowsMidiDiscoveryAdapter::snapshot() const {
  std::scoped_lock lifecycle_lock(impl_->lifecycle_mutex);
#if defined(_WIN32)
  if (impl_->state->active.load(std::memory_order_acquire) &&
      (!watcher_connected(impl_->input_watcher) || !watcher_connected(impl_->output_watcher))) {
    impl_->state->dispatch([](DiscoveryPublisher& publisher) { publisher.stop(); });
  }
#endif
  return impl_->state->publisher.snapshot();
}

}  // namespace aimuse::midi
