#include "protocol.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>

namespace fs = std::filesystem;

int main(const int argc, const char* const argv[]) {
  if (argc != 3 || std::string_view(argv[1]) != "--scan") {
    std::cerr << "usage: aimuse-plugin-scanner --scan <module>\n";
    return 2;
  }
  const fs::path module = fs::absolute(fs::path(argv[2]));
  const std::string filename = module.filename().string();
  if (filename.find("aimuse-fixture-crash") != std::string::npos) return 86;
  if (filename.find("aimuse-fixture-hang") != std::string::npos) {
    std::this_thread::sleep_for(std::chrono::seconds(60));
    return 87;
  }
  if (filename.find("aimuse-fixture-malformed") != std::string::npos) {
    std::cout << "{malformed";
    return 0;
  }

  fs::path fixture = module;
  fixture += ".aimuse-fixture.json";
  if (fs::is_regular_file(fixture)) {
    std::ifstream input(fixture, std::ios::binary);
    std::cout << std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
    return input.bad() ? 4 : 0;
  }

  // Production SDK metadata adapters are gated behind AIMUSE_ENABLE_PLUGIN_SDKS. A dependency-free
  // build fails explicitly instead of inventing a path-derived identity for a real plug-in.
  std::cerr << "VST3/CLAP metadata adapter is not linked in this build; module was not loaded: " << aimuse::protocol::escape(module.string()) << '\n';
  return 11;
}
