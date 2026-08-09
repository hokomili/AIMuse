#pragma once

#include <charconv>
#include <cstdint>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

namespace aimuse::protocol {

inline std::string escape(std::string_view value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20U) {
          constexpr char digits[] = "0123456789abcdef";
          output << "\\u00" << digits[(character >> 4U) & 0x0FU] << digits[character & 0x0FU];
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  return output.str();
}

inline std::optional<std::string> string_field(std::string_view json, std::string_view key) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto key_position = json.find(needle);
  if (key_position == std::string_view::npos) return std::nullopt;
  const auto colon = json.find(':', key_position + needle.size());
  if (colon == std::string_view::npos) return std::nullopt;
  const auto quote = json.find('"', colon + 1U);
  if (quote == std::string_view::npos) return std::nullopt;
  std::string result;
  bool escaped = false;
  for (std::size_t index = quote + 1U; index < json.size(); ++index) {
    const char character = json[index];
    if (escaped) {
      switch (character) {
        case 'n': result.push_back('\n'); break;
        case 'r': result.push_back('\r'); break;
        case 't': result.push_back('\t'); break;
        default: result.push_back(character); break;
      }
      escaped = false;
    } else if (character == '\\') {
      escaped = true;
    } else if (character == '"') {
      return result;
    } else {
      result.push_back(character);
    }
  }
  return std::nullopt;
}

inline std::optional<std::int64_t> integer_field(std::string_view json, std::string_view key) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto key_position = json.find(needle);
  if (key_position == std::string_view::npos) return std::nullopt;
  const auto colon = json.find(':', key_position + needle.size());
  if (colon == std::string_view::npos) return std::nullopt;
  auto start = json.find_first_of("-0123456789", colon + 1U);
  if (start == std::string_view::npos) return std::nullopt;
  auto end = start;
  while (end < json.size() && ((json[end] >= '0' && json[end] <= '9') || json[end] == '-')) ++end;
  std::int64_t value = 0;
  const auto conversion = std::from_chars(json.data() + start, json.data() + end, value);
  if (conversion.ec != std::errc{}) return std::nullopt;
  return value;
}

inline bool boolean_field(std::string_view json, std::string_view key, bool fallback = false) {
  const std::string needle = "\"" + std::string(key) + "\"";
  const auto key_position = json.find(needle);
  if (key_position == std::string_view::npos) return fallback;
  const auto colon = json.find(':', key_position + needle.size());
  if (colon == std::string_view::npos) return fallback;
  const auto value = json.find_first_not_of(" \t\r\n", colon + 1U);
  if (value == std::string_view::npos) return fallback;
  return json.substr(value, 4U) == "true";
}

inline std::string success(std::string_view id, std::string_view result_json) {
  return "{\"version\":1,\"id\":\"" + escape(id) + "\",\"ok\":true,\"result\":" + std::string(result_json) + "}";
}

inline std::string failure(std::string_view id, std::string_view code, std::string_view message, bool retryable) {
  return "{\"version\":1,\"id\":\"" + escape(id) + "\",\"ok\":false,\"error\":{\"code\":\"" + escape(code) + "\",\"message\":\"" + escape(message) + "\",\"retryable\":" + (retryable ? "true" : "false") + "}}";
}

}  // namespace aimuse::protocol
