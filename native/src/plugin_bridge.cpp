#include "protocol.hpp"

#include <iostream>
#include <string>

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  std::string line;
  bool bypassed = false;
  while (std::getline(std::cin, line)) {
    const auto id = aimuse::protocol::string_field(line, "id").value_or("unknown");
    const auto method = aimuse::protocol::string_field(line, "method").value_or("");
    if (method == "hello") {
      std::cout << aimuse::protocol::success(id, "{\"protocolVersion\":1,\"isolation\":\"process\",\"sharedMemoryAudio\":false,\"sdkAdaptersReady\":false}") << '\n' << std::flush;
    } else if (method == "bypass") {
      bypassed = aimuse::protocol::boolean_field(line, "bypassed", bypassed);
      std::cout << aimuse::protocol::success(id, bypassed ? "{\"bypassed\":true}" : "{\"bypassed\":false}") << '\n' << std::flush;
    } else if (method == "shutdown") {
      std::cout << aimuse::protocol::success(id, "{\"stopped\":true}") << '\n' << std::flush;
      break;
    } else {
      std::cout << aimuse::protocol::failure(id, "bridge-adapter-unavailable", "Plug-in SDK adapter is not linked in this build.", false) << '\n' << std::flush;
    }
  }
  return 0;
}
