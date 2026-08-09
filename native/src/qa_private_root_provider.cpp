#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <node_api.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::uint64_t kMaximumSnapshotBytes = 16ULL * 1024ULL * 1024ULL;
constexpr std::array<const char*, 8> kCapabilities{
    "rootHandleHeld",
    "rootDeleteShareDenied",
    "securityDescriptorByHandle",
    "finalPathByHandle",
    "fileIdentityByHandle",
    "reparseMetadataByHandle",
    "handleValidatedReadSnapshots",
    "pinnedAbsolutePathAtomicReplace",
};

class NativeError final : public std::runtime_error {
 public:
  explicit NativeError(const std::string& message) : std::runtime_error(message) {}
};

class UniqueHandle final {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    const HANDLE result = value_;
    value_ = INVALID_HANDLE_VALUE;
    return result;
  }
  bool reset(HANDLE replacement = INVALID_HANDLE_VALUE) {
    bool okay = true;
    if (*this) okay = CloseHandle(value_) != FALSE;
    value_ = replacement;
    return okay;
  }

 private:
  HANDLE value_{INVALID_HANDLE_VALUE};
};

struct FilesystemObject {
  std::wstring final_path;
  DWORD volume_serial{};
  std::uint64_t file_index{};
  DWORD attributes{};
  DWORD reparse_tag{};
};

struct FileIdentity {
  DWORD volume_serial{};
  std::uint64_t file_index{};
  DWORD attributes{};
  DWORD reparse_tag{};
};

struct SecurityContext {
  std::vector<std::byte> user_sid;
  std::vector<std::byte> system_sid;
  std::vector<std::byte> administrators_sid;
};

struct PinnedDirectory {
  std::wstring path;
  UniqueHandle handle;
  FilesystemObject identity;
  bool require_protected{};
};

struct AllowedPath {
  std::wstring path;
  std::size_t parent_index{};
};

struct ExpectedIdentity {
  std::wstring canonical_path;
  std::string device;
  std::string inode;
};

struct LeaseState {
  std::wstring root_path;
  ExpectedIdentity expected_identity;
  SecurityContext security;
  std::vector<PinnedDirectory> directories;
  std::vector<AllowedPath> allowed_paths;
  bool closed{false};
  std::string sticky_error;
};

void CheckNapi(napi_env env, const napi_status status, const char* operation) {
  if (status == napi_ok) return;
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  const std::string detail = info != nullptr && info->error_message != nullptr ? info->error_message : "unknown Node-API error";
  throw NativeError(std::string(operation) + " failed: " + detail + '.');
}

[[noreturn]] void ThrowWin32(const char* operation) {
  throw NativeError(std::string(operation) + " failed with Windows error " + std::to_string(GetLastError()) + '.');
}

std::wstring GetString(napi_env env, napi_value value, const char* label) {
  napi_valuetype type{};
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_string) throw NativeError(std::string(label) + " must be a string.");
  std::size_t length = 0;
  CheckNapi(env, napi_get_value_string_utf16(env, value, nullptr, 0, &length), "napi_get_value_string_utf16");
  std::vector<char16_t> buffer(length + 1U);
  CheckNapi(env, napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length), "napi_get_value_string_utf16");
  return std::wstring(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(length));
}

std::string NarrowDigits(const std::wstring& value, const char* label) {
  if (value.empty() || !std::all_of(value.begin(), value.end(), [](const wchar_t character) { return character >= L'0' && character <= L'9'; })) {
    throw NativeError(std::string(label) + " must contain decimal digits.");
  }
  std::string result(value.size(), '\0');
  std::transform(value.begin(), value.end(), result.begin(), [](const wchar_t character) { return static_cast<char>(character); });
  return result;
}

napi_value GetNamed(napi_env env, napi_value object, const char* name) {
  napi_value result{};
  CheckNapi(env, napi_get_named_property(env, object, name, &result), "napi_get_named_property");
  return result;
}

void RequireObject(napi_env env, napi_value value, const char* label) {
  napi_valuetype type{};
  bool array = false;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  CheckNapi(env, napi_is_array(env, value, &array), "napi_is_array");
  if (type != napi_object || array) throw NativeError(std::string(label) + " must be an object.");
}

void RequireVersionOne(napi_env env, napi_value object, const char* label) {
  std::int32_t version = 0;
  CheckNapi(env, napi_get_value_int32(env, GetNamed(env, object, "version"), &version), "napi_get_value_int32");
  if (version != 1) throw NativeError(std::string(label) + " must use version 1.");
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result{};
  CheckNapi(env, napi_create_string_utf8(env, value.data(), value.size(), &result), "napi_create_string_utf8");
  return result;
}

napi_value String(napi_env env, const std::wstring& value) {
  napi_value result{};
  CheckNapi(env, napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result), "napi_create_string_utf16");
  return result;
}

napi_value Boolean(napi_env env, const bool value) {
  napi_value result{};
  CheckNapi(env, napi_get_boolean(env, value, &result), "napi_get_boolean");
  return result;
}

napi_value Integer(napi_env env, const std::uint32_t value) {
  napi_value result{};
  CheckNapi(env, napi_create_uint32(env, value, &result), "napi_create_uint32");
  return result;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  CheckNapi(env, napi_set_named_property(env, object, name, value), "napi_set_named_property");
}

napi_value Object(napi_env env) {
  napi_value result{};
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  return result;
}

napi_value Array(napi_env env, const std::size_t length) {
  napi_value result{};
  CheckNapi(env, napi_create_array_with_length(env, length, &result), "napi_create_array_with_length");
  return result;
}

void Set(napi_env env, napi_value array, const std::uint32_t index, napi_value value) {
  CheckNapi(env, napi_set_element(env, array, index, value), "napi_set_element");
}

std::wstring NormalizePath(const std::wstring& input) {
  if (input.empty()) throw NativeError("Private-root provider paths must not be empty.");
  const DWORD needed = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (needed == 0) ThrowWin32("GetFullPathNameW");
  std::vector<wchar_t> buffer(static_cast<std::size_t>(needed) + 1U);
  const DWORD written = GetFullPathNameW(input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (written == 0 || written >= buffer.size()) ThrowWin32("GetFullPathNameW");
  std::wstring result(buffer.data(), written);
  std::replace(result.begin(), result.end(), L'/', L'\\');
  while (result.size() > 3U && result.back() == L'\\') result.pop_back();
  return result;
}

std::wstring NormalizeHandlePath(std::wstring path) {
  constexpr wchar_t unc_prefix[] = L"\\\\?\\UNC\\";
  constexpr wchar_t long_prefix[] = L"\\\\?\\";
  if (path.rfind(unc_prefix, 0) == 0) path = L"\\\\" + path.substr(std::size(unc_prefix) - 1U);
  else if (path.rfind(long_prefix, 0) == 0) path.erase(0, std::size(long_prefix) - 1U);
  return NormalizePath(path);
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool WithinRoot(const std::wstring& root, const std::wstring& path) {
  if (SamePath(root, path)) return true;
  if (path.size() <= root.size() || path[root.size()] != L'\\') return false;
  return CompareStringOrdinal(root.c_str(), static_cast<int>(root.size()), path.c_str(), static_cast<int>(root.size()), TRUE) == CSTR_EQUAL;
}

std::wstring ParentPath(const std::wstring& path) {
  const std::size_t separator = path.find_last_of(L'\\');
  if (separator == std::wstring::npos || separator < 2U) throw NativeError("Allowlisted path has no usable parent directory.");
  return path.substr(0, separator);
}

std::wstring BaseName(const std::wstring& path) {
  const std::size_t separator = path.find_last_of(L'\\');
  const std::wstring result = separator == std::wstring::npos ? path : path.substr(separator + 1U);
  if (result.empty() || result == L"." || result == L".." || result.find(L'\\') != std::wstring::npos ||
      result.find(L':') != std::wstring::npos) {
    throw NativeError("Allowlisted path has an invalid final component or stream name.");
  }
  return result;
}

bool IsFullyQualifiedWin32Path(const std::wstring& path) {
  if (path.size() >= 3U && std::iswalpha(path[0]) != 0 && path[1] == L':' && path[2] == L'\\') return true;
  if (path.rfind(L"\\\\", 0) != 0) return false;
  const std::size_t server_end = path.find(L'\\', 2U);
  if (server_end == std::wstring::npos || server_end == 2U) return false;
  const std::size_t share_end = path.find(L'\\', server_end + 1U);
  return share_end != std::wstring::npos && share_end > server_end + 1U && share_end + 1U < path.size();
}

std::wstring PinnedAbsoluteTargetPath(const AllowedPath& allowed, const PinnedDirectory& parent, const LeaseState& state) {
  if (!IsFullyQualifiedWin32Path(allowed.path)) throw NativeError("Atomic replacement requires one fully qualified Win32 target path.");
  if (!WithinRoot(state.root_path, allowed.path) || !SamePath(ParentPath(allowed.path), parent.path) ||
      !SamePath(parent.identity.final_path, parent.path)) {
    throw NativeError("Atomic replacement target is not bound to its pinned allowlisted parent.");
  }
  const std::wstring reconstructed = parent.path + L'\\' + BaseName(allowed.path);
  if (!SamePath(reconstructed, allowed.path)) throw NativeError("Atomic replacement target differs from its pinned canonical path.");
  return reconstructed;
}

std::wstring FinalPath(HANDLE handle) {
  const DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, flags);
  if (needed == 0) ThrowWin32("GetFinalPathNameByHandleW");
  std::vector<wchar_t> buffer(static_cast<std::size_t>(needed) + 1U);
  const DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), flags);
  if (written == 0 || written >= buffer.size()) ThrowWin32("GetFinalPathNameByHandleW");
  return NormalizeHandlePath(std::wstring(buffer.data(), written));
}

FileIdentity InspectFileIdentity(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION basic{};
  if (GetFileInformationByHandle(handle, &basic) == FALSE) ThrowWin32("GetFileInformationByHandle");
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) == FALSE) ThrowWin32("GetFileInformationByHandleEx(FileAttributeTagInfo)");
  const std::uint64_t index = (static_cast<std::uint64_t>(basic.nFileIndexHigh) << 32U) | basic.nFileIndexLow;
  return {basic.dwVolumeSerialNumber, index, tag.FileAttributes, tag.ReparseTag};
}

FilesystemObject InspectObject(HANDLE handle) {
  const FileIdentity identity = InspectFileIdentity(handle);
  return {FinalPath(handle), identity.volume_serial, identity.file_index, identity.attributes, identity.reparse_tag};
}

bool SameFileObject(const FileIdentity& left, const FileIdentity& right) {
  return left.volume_serial == right.volume_serial && left.file_index == right.file_index;
}

FileIdentity ObjectIdentity(const FilesystemObject& object) {
  return {object.volume_serial, object.file_index, object.attributes, object.reparse_tag};
}

std::vector<std::byte> WellKnownSid(const WELL_KNOWN_SID_TYPE type) {
  std::vector<std::byte> result(SECURITY_MAX_SID_SIZE);
  DWORD size = static_cast<DWORD>(result.size());
  if (CreateWellKnownSid(type, nullptr, result.data(), &size) == FALSE) ThrowWin32("CreateWellKnownSid");
  result.resize(size);
  return result;
}

SecurityContext CurrentSecurityContext() {
  UniqueHandle token;
  HANDLE raw_token = INVALID_HANDLE_VALUE;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) == FALSE) ThrowWin32("OpenProcessToken");
  token.reset(raw_token);
  DWORD needed = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &needed);
  if (needed == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) ThrowWin32("GetTokenInformation(size)");
  std::vector<std::byte> token_info(needed);
  if (GetTokenInformation(token.get(), TokenUser, token_info.data(), needed, &needed) == FALSE) ThrowWin32("GetTokenInformation");
  const auto* user = reinterpret_cast<const TOKEN_USER*>(token_info.data());
  const DWORD sid_size = GetLengthSid(user->User.Sid);
  if (sid_size == 0) ThrowWin32("GetLengthSid");
  SecurityContext result;
  result.user_sid.resize(sid_size);
  if (CopySid(sid_size, result.user_sid.data(), user->User.Sid) == FALSE) ThrowWin32("CopySid");
  result.system_sid = WellKnownSid(WinLocalSystemSid);
  result.administrators_sid = WellKnownSid(WinBuiltinAdministratorsSid);
  return result;
}

bool EqualSidVector(PSID sid, const std::vector<std::byte>& expected) {
  return IsValidSid(sid) != FALSE && EqualSid(sid, const_cast<std::byte*>(expected.data())) != FALSE;
}

void ValidateSecurity(HANDLE handle, const SecurityContext& context, const bool require_protected) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) {
    SetLastError(status);
    ThrowWin32("GetSecurityInfo");
  }
  const std::unique_ptr<void, decltype(&LocalFree)> descriptor_guard(descriptor, &LocalFree);
  if (owner == nullptr || !EqualSidVector(owner, context.user_sid)) throw NativeError("Handle security owner is not the launching user.");
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  if (GetSecurityDescriptorControl(descriptor, &control, &revision) == FALSE) ThrowWin32("GetSecurityDescriptorControl");
  if (require_protected && (control & SE_DACL_PROTECTED) == 0) throw NativeError("Handle security DACL is not protected from inheritance.");
  if (dacl == nullptr || dacl->AceCount == 0) throw NativeError("Handle security DACL has no effective rules.");

  DWORD owner_mask = 0;
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, index, &raw_ace) == FALSE) ThrowWin32("GetAce");
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) throw NativeError("Handle security DACL contains a non-Allow or unsupported rule.");
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    const bool owner_rule = EqualSidVector(sid, context.user_sid);
    const bool allowed = owner_rule || EqualSidVector(sid, context.system_sid) || EqualSidVector(sid, context.administrators_sid);
    if (!allowed) throw NativeError("Handle security DACL grants an unexpected principal.");
    if (owner_rule && (header->AceFlags & INHERIT_ONLY_ACE) == 0) {
      DWORD mask = ace->Mask;
      MapGenericMask(&mask, &mapping);
      owner_mask |= mask;
    }
  }
  if ((owner_mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) throw NativeError("Handle security does not grant the launching user FullControl.");
}

void ValidateDirectoryObject(const PinnedDirectory& directory, const SecurityContext& security) {
  const FilesystemObject current = InspectObject(directory.handle.get());
  if (!SamePath(current.final_path, directory.path) || current.volume_serial != directory.identity.volume_serial || current.file_index != directory.identity.file_index) {
    throw NativeError("Pinned directory handle identity or final path changed.");
  }
  if ((current.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (current.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || current.reparse_tag != 0) {
    throw NativeError("Pinned directory handle is not one non-reparse directory.");
  }
  ValidateSecurity(directory.handle.get(), security, directory.require_protected);
}

UniqueHandle OpenPinnedDirectory(const std::wstring& path) {
  const HANDLE handle = CreateFileW(
      path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) ThrowWin32("CreateFileW(pinned directory)");
  return UniqueHandle(handle);
}

std::uint64_t ParseUnsigned(const std::string& value, const char* label) {
  if (value.empty() || !std::all_of(value.begin(), value.end(), [](const char character) { return character >= '0' && character <= '9'; })) {
    throw NativeError(std::string(label) + " must contain decimal digits.");
  }
  std::size_t consumed = 0;
  unsigned long long parsed = 0;
  try {
    parsed = std::stoull(value, &consumed, 10);
  } catch (...) {
    throw NativeError(std::string(label) + " is outside the supported unsigned range.");
  }
  if (consumed != value.size()) throw NativeError(std::string(label) + " must contain decimal digits.");
  return static_cast<std::uint64_t>(parsed);
}

bool PersistedInodeMatches(const std::string& persisted, const std::uint64_t exact) {
  const std::uint64_t parsed = ParseUnsigned(persisted, "Persisted inode");
  if (parsed == exact) return true;
  // Existing coordinator identities originate from Node's number-valued Stats.ino.
  // Bind the exact 64-bit handle identity internally after this compatibility check.
  return static_cast<double>(parsed) == static_cast<double>(exact);
}

std::size_t FindDirectory(const LeaseState& state, const std::wstring& path) {
  for (std::size_t index = 0; index < state.directories.size(); ++index) {
    if (SamePath(state.directories[index].path, path)) return index;
  }
  throw NativeError("Allowlisted parent directory is not pinned by the lease.");
}

const AllowedPath& FindAllowedPath(const LeaseState& state, const std::wstring& input) {
  const std::wstring path = NormalizePath(input);
  for (const auto& allowed : state.allowed_paths) if (SamePath(allowed.path, path)) return allowed;
  throw NativeError("Private-root provider operation is not allowlisted for this path.");
}

void ValidateAll(LeaseState& state) {
  if (state.closed) throw NativeError("Private-root handle lease is already closed.");
  if (!state.sticky_error.empty()) throw NativeError(state.sticky_error);
  try {
    for (const auto& directory : state.directories) ValidateDirectoryObject(directory, state.security);
  } catch (const std::exception& error) {
    state.sticky_error = error.what();
    throw;
  }
}

ExpectedIdentity ParseExpectedIdentity(napi_env env, napi_value value) {
  RequireObject(env, value, "Expected private-root identity");
  RequireVersionOne(env, value, "Expected private-root identity");
  ExpectedIdentity result;
  result.canonical_path = NormalizePath(GetString(env, GetNamed(env, value, "canonicalPath"), "Expected canonical path"));
  result.device = NarrowDigits(GetString(env, GetNamed(env, value, "device"), "Expected device"), "Expected device");
  result.inode = NarrowDigits(GetString(env, GetNamed(env, value, "inode"), "Expected inode"), "Expected inode");
  return result;
}

napi_value IdentityObject(napi_env env, const std::wstring& path, const std::string& device, const std::string& inode) {
  napi_value result = Object(env);
  Set(env, result, "version", Integer(env, 1));
  Set(env, result, "canonicalPath", String(env, path));
  Set(env, result, "device", String(env, device));
  Set(env, result, "inode", String(env, inode));
  return result;
}

napi_value ExpectedIdentityObject(napi_env env, const LeaseState& state) {
  return IdentityObject(env, state.expected_identity.canonical_path, state.expected_identity.device, state.expected_identity.inode);
}

napi_value Descriptor(napi_env env, const LeaseState& state) {
  napi_value descriptor = Object(env);
  Set(env, descriptor, "version", Integer(env, 1));
  Set(env, descriptor, "root", String(env, state.root_path));
  Set(env, descriptor, "identity", ExpectedIdentityObject(env, state));

  napi_value security = Object(env);
  Set(env, security, "owner", String(env, "launching-user"));
  Set(env, security, "protected", Boolean(env, true));
  Set(env, security, "allowOnly", Boolean(env, true));
  Set(env, security, "ownerFullControl", Boolean(env, true));
  napi_value principals{};
  CheckNapi(env, napi_create_array_with_length(env, 3, &principals), "napi_create_array_with_length");
  CheckNapi(env, napi_set_element(env, principals, 0, String(env, "launching-user")), "napi_set_element");
  CheckNapi(env, napi_set_element(env, principals, 1, String(env, "SYSTEM")), "napi_set_element");
  CheckNapi(env, napi_set_element(env, principals, 2, String(env, "Administrators")), "napi_set_element");
  Set(env, security, "allowedPrincipals", principals);
  Set(env, descriptor, "security", security);

  napi_value object = Object(env);
  Set(env, object, "directory", Boolean(env, true));
  Set(env, object, "reparsePoint", Boolean(env, false));
  Set(env, object, "deleteShareDenied", Boolean(env, true));
  Set(env, descriptor, "object", object);

  napi_value capabilities = Object(env);
  for (const char* capability : kCapabilities) Set(env, capabilities, capability, Boolean(env, true));
  Set(env, descriptor, "capabilities", capabilities);
  return descriptor;
}

LeaseState* UnwrapLease(napi_env env, napi_callback_info info, std::vector<napi_value>* arguments = nullptr) {
  std::size_t argument_count = arguments == nullptr ? 0U : arguments->size();
  napi_value self{};
  CheckNapi(env, napi_get_cb_info(env, info, &argument_count, arguments == nullptr ? nullptr : arguments->data(), &self, nullptr), "napi_get_cb_info");
  if (arguments != nullptr) arguments->resize(argument_count);
  LeaseState* state = nullptr;
  CheckNapi(env, napi_unwrap(env, self, reinterpret_cast<void**>(&state)), "napi_unwrap");
  if (state == nullptr) throw NativeError("Private-root handle lease has no native state.");
  return state;
}

void FinalizeLease(napi_env, void* data, void*) {
  auto* state = static_cast<LeaseState*>(data);
  if (state == nullptr) return;
  if (!state->closed) {
    state->closed = true;
    for (auto iterator = state->directories.rbegin(); iterator != state->directories.rend(); ++iterator) iterator->handle.reset();
  }
  delete state;
}

template <typename Callback>
napi_value CallbackBoundary(napi_env env, Callback&& callback) {
  try {
    return callback();
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  } catch (...) {
    napi_throw_error(env, nullptr, "Unknown native private-root provider failure.");
    return nullptr;
  }
}

napi_value AssertCurrent(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    LeaseState* state = UnwrapLease(env, info);
    ValidateAll(*state);
    return Descriptor(env, *state);
  });
}

UniqueHandle OpenSnapshot(const std::wstring& path) {
  // Atomic rotation closes its distinct write stage before rename, then needs
  // DELETE access on the target lifecycle. Share delete so a fresh read can
  // bind one complete old-or-new object; keep write sharing denied so in-place
  // mutation cannot overlap validation and ReadExact.
  const HANDLE handle = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (handle == INVALID_HANDLE_VALUE) ThrowWin32("CreateFileW(snapshot)");
  return UniqueHandle(handle);
}

FilesystemObject ValidateSnapshotHandle(HANDLE handle, const AllowedPath& allowed, const LeaseState& state) {
  const FilesystemObject object = InspectObject(handle);
  if (!SamePath(object.final_path, allowed.path) || !WithinRoot(state.root_path, object.final_path)) throw NativeError("Snapshot handle final path escapes or differs from its allowlisted path.");
  if ((object.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || (object.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || object.reparse_tag != 0) {
    throw NativeError("Snapshot handle is not one regular non-reparse file.");
  }
  ValidateSecurity(handle, state.security, false);
  return object;
}

std::vector<std::byte> ReadExact(HANDLE handle) {
  LARGE_INTEGER size{};
  if (GetFileSizeEx(handle, &size) == FALSE) ThrowWin32("GetFileSizeEx");
  if (size.QuadPart < 0 || static_cast<std::uint64_t>(size.QuadPart) > kMaximumSnapshotBytes) throw NativeError("Snapshot exceeds the bounded coordination-evidence size.");
  std::vector<std::byte> bytes(static_cast<std::size_t>(size.QuadPart));
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, std::numeric_limits<DWORD>::max()));
    DWORD received = 0;
    if (ReadFile(handle, bytes.data() + offset, request, &received, nullptr) == FALSE) ThrowWin32("ReadFile(snapshot)");
    if (received == 0) throw NativeError("Snapshot ended before its validated size.");
    offset += received;
  }
  return bytes;
}

napi_value ReadSnapshot(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    std::vector<napi_value> arguments(1);
    LeaseState* state = UnwrapLease(env, info, &arguments);
    if (arguments.size() != 1) throw NativeError("readSnapshot requires exactly one path.");
    try {
      ValidateAll(*state);
      const AllowedPath& allowed = FindAllowedPath(*state, GetString(env, arguments[0], "Snapshot path"));
      UniqueHandle handle = OpenSnapshot(allowed.path);
      const FilesystemObject object = ValidateSnapshotHandle(handle.get(), allowed, *state);
      std::vector<std::byte> bytes = ReadExact(handle.get());
      ValidateAll(*state);

      napi_value result = Object(env);
      Set(env, result, "version", Integer(env, 1));
      Set(env, result, "path", String(env, allowed.path));
      Set(env, result, "rootIdentity", ExpectedIdentityObject(env, *state));
      Set(env, result, "fileIdentity", IdentityObject(env, allowed.path, std::to_string(object.volume_serial), std::to_string(object.file_index)));
      Set(env, result, "contained", Boolean(env, true));
      Set(env, result, "reparsePoint", Boolean(env, false));
      Set(env, result, "securityValidated", Boolean(env, true));
      napi_value buffer{};
      void* copied = nullptr;
      CheckNapi(env, napi_create_buffer_copy(env, bytes.size(), bytes.data(), &copied, &buffer), "napi_create_buffer_copy");
      Set(env, result, "bytes", buffer);
      return result;
    } catch (const std::exception& error) {
      if (state->sticky_error.empty()) state->sticky_error = error.what();
      throw;
    }
  });
}

std::vector<std::byte> BytesFromValue(napi_env env, napi_value value) {
  bool buffer = false;
  CheckNapi(env, napi_is_buffer(env, value, &buffer), "napi_is_buffer");
  if (buffer) {
    void* data = nullptr;
    std::size_t length = 0;
    CheckNapi(env, napi_get_buffer_info(env, value, &data, &length), "napi_get_buffer_info");
    if (length > kMaximumSnapshotBytes) throw NativeError("Atomic replacement exceeds the bounded coordination-evidence size.");
    if (length == 0) return {};
    const auto* begin = static_cast<const std::byte*>(data);
    return std::vector<std::byte>(begin, begin + length);
  }
  bool typed_array = false;
  CheckNapi(env, napi_is_typedarray(env, value, &typed_array), "napi_is_typedarray");
  if (typed_array) {
    napi_typedarray_type type{};
    std::size_t length = 0;
    void* data = nullptr;
    napi_value array_buffer{};
    std::size_t offset = 0;
    CheckNapi(env, napi_get_typedarray_info(env, value, &type, &length, &data, &array_buffer, &offset), "napi_get_typedarray_info");
    if (type != napi_uint8_array && type != napi_uint8_clamped_array) throw NativeError("Atomic replacement accepts only string or byte-array input.");
    if (length > kMaximumSnapshotBytes) throw NativeError("Atomic replacement exceeds the bounded coordination-evidence size.");
    if (length == 0) return {};
    const auto* begin = static_cast<const std::byte*>(data);
    return std::vector<std::byte>(begin, begin + length);
  }
  napi_valuetype value_type{};
  CheckNapi(env, napi_typeof(env, value, &value_type), "napi_typeof");
  if (value_type != napi_string) throw NativeError("Atomic replacement accepts only string or byte-array input.");
  std::size_t length = 0;
  CheckNapi(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "napi_get_value_string_utf8");
  if (length > kMaximumSnapshotBytes) throw NativeError("Atomic replacement exceeds the bounded coordination-evidence size.");
  std::vector<char> text(length + 1U);
  CheckNapi(env, napi_get_value_string_utf8(env, value, text.data(), text.size(), &length), "napi_get_value_string_utf8");
  const auto* begin = reinterpret_cast<const std::byte*>(text.data());
  return std::vector<std::byte>(begin, begin + length);
}

std::wstring RandomStageName() {
  std::array<unsigned char, 16> random{};
  const NTSTATUS status = BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status < 0) throw NativeError("BCryptGenRandom failed while creating a private stage name.");
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result = L".aimuse-stage-";
  result.reserve(result.size() + random.size() * 2U + 4U);
  for (const unsigned char value : random) {
    result.push_back(digits[value >> 4U]);
    result.push_back(digits[value & 0x0FU]);
  }
  result += L".tmp";
  return result;
}

void WriteAll(HANDLE handle, const std::vector<std::byte>& bytes) {
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, std::numeric_limits<DWORD>::max()));
    DWORD written = 0;
    if (WriteFile(handle, bytes.data() + offset, request, &written, nullptr) == FALSE) ThrowWin32("WriteFile(stage)");
    if (written == 0) throw NativeError("Atomic stage stopped before all bytes were written.");
    offset += written;
  }
  if (FlushFileBuffers(handle) == FALSE) ThrowWin32("FlushFileBuffers(stage)");
}

void ValidateStageBytes(HANDLE handle, const std::vector<std::byte>& expected) {
  LARGE_INTEGER beginning{};
  if (SetFilePointerEx(handle, beginning, nullptr, FILE_BEGIN) == FALSE) ThrowWin32("SetFilePointerEx(stage)");
  std::vector<std::byte> actual(expected.size());
  std::size_t offset = 0;
  while (offset < actual.size()) {
    const DWORD request = static_cast<DWORD>(std::min<std::size_t>(actual.size() - offset, std::numeric_limits<DWORD>::max()));
    DWORD received = 0;
    if (ReadFile(handle, actual.data() + offset, request, &received, nullptr) == FALSE) ThrowWin32("ReadFile(stage)");
    if (received == 0) throw NativeError("Atomic stage readback was truncated.");
    offset += received;
  }
  if (actual != expected) throw NativeError("Atomic stage readback did not match the supplied bytes.");
}

void MarkStageForDeletion(HANDLE handle) noexcept {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
}

enum class RenameInformationProfile { legacy, extended };
enum class RenameBufferProfile { exact_tail, padded_structure };
enum class RenameReplacementProfile { classic, subsequent_opens_bind_renamed_file };

DWORD AttemptRenameStage(HANDLE stage, HANDLE root_directory, const std::wstring& destination,
                          const RenameInformationProfile information_profile, const RenameBufferProfile buffer_profile,
                          const RenameReplacementProfile replacement_profile, bool* const buffer_aligned) {
  const std::size_t prefix_size = buffer_profile == RenameBufferProfile::exact_tail ? offsetof(FILE_RENAME_INFO, FileName) : sizeof(FILE_RENAME_INFO);
  if (destination.size() > (std::numeric_limits<DWORD>::max() - prefix_size) / sizeof(wchar_t)) {
    throw NativeError("Atomic replacement destination is too long.");
  }
  const std::size_t file_name_bytes = destination.size() * sizeof(wchar_t);
  const std::size_t allocation_size = prefix_size + file_name_bytes;
  auto storage = std::make_unique<std::byte[]>(allocation_size);
  std::memset(storage.get(), 0, allocation_size);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.get());
  *buffer_aligned = reinterpret_cast<std::uintptr_t>(rename) % alignof(FILE_RENAME_INFO) == 0;
  if (!*buffer_aligned) throw NativeError("Atomic replacement buffer is not aligned for FILE_RENAME_INFO.");
  const FILE_INFO_BY_HANDLE_CLASS information_class = information_profile == RenameInformationProfile::extended ? FileRenameInfoEx : FileRenameInfo;
  if (information_profile == RenameInformationProfile::extended) {
    rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS;
    if (replacement_profile == RenameReplacementProfile::subsequent_opens_bind_renamed_file) {
      rename->Flags |= FILE_RENAME_FLAG_POSIX_SEMANTICS;
    }
  } else {
    if (replacement_profile != RenameReplacementProfile::classic) {
      throw NativeError("Immediate replacement visibility requires FileRenameInfoEx.");
    }
    rename->ReplaceIfExists = TRUE;
  }
  rename->RootDirectory = root_directory;
  rename->FileNameLength = static_cast<DWORD>(file_name_bytes);
  std::memcpy(rename->FileName, destination.data(), file_name_bytes);
  if (SetFileInformationByHandle(stage, information_class, rename, static_cast<DWORD>(allocation_size)) == FALSE) return GetLastError();
  return ERROR_SUCCESS;
}

void RenameStageToPinnedAbsoluteTarget(HANDLE stage, const std::wstring& absolute_target_path) {
  if (!IsFullyQualifiedWin32Path(absolute_target_path)) throw NativeError("Atomic replacement refused a process-relative destination.");
  bool buffer_aligned = false;
  // Win32 resolves a null-root relative name against the process current
  // directory. Use the exact absolute destination reconstructed from the
  // validated non-delete-shared parent instead. The source remains the
  // share-zero staged handle and no secondary rename API or fallback exists.
  const DWORD error = AttemptRenameStage(stage, nullptr, absolute_target_path, RenameInformationProfile::extended,
                                         RenameBufferProfile::padded_structure,
                                         RenameReplacementProfile::subsequent_opens_bind_renamed_file, &buffer_aligned);
  if (error != ERROR_SUCCESS) {
    SetLastError(error);
    ThrowWin32("SetFileInformationByHandle(FileRenameInfoEx pinned absolute replacement)");
  }
}

UniqueHandle OpenCommittedTargetForVerification(const std::wstring& path) {
  // The renamed stage remains open with share mode zero. Request only metadata
  // and security access, while sharing its existing read/write/delete access.
  const HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) ThrowWin32("CreateFileW(committed target verification)");
  return UniqueHandle(handle);
}

void ValidateCommittedTarget(HANDLE stage, const FilesystemObject& initial_stage, const AllowedPath& allowed, const LeaseState& state,
                             const std::vector<std::byte>& expected) {
  // A name queried from the pre-rename handle is not the commit oracle. Keep
  // that handle open as the non-delete-share identity lock, then prove that a
  // fresh handle at the allowlisted target identifies the same file object.
  const FileIdentity committed_stage = InspectFileIdentity(stage);
  if (committed_stage.volume_serial != initial_stage.volume_serial || committed_stage.file_index != initial_stage.file_index) {
    throw NativeError("Committed stage handle identity changed after rename.");
  }
  if ((committed_stage.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || committed_stage.reparse_tag != 0) {
    throw NativeError("Committed stage handle is not one regular non-reparse file.");
  }

  UniqueHandle target = OpenCommittedTargetForVerification(allowed.path);
  const FilesystemObject committed_target = InspectObject(target.get());
  if (!SamePath(committed_target.final_path, allowed.path) || !WithinRoot(state.root_path, committed_target.final_path)) {
    throw NativeError("Committed target handle path is not the exact allowlisted destination.");
  }
  if (committed_target.volume_serial != initial_stage.volume_serial || committed_target.file_index != initial_stage.file_index ||
      committed_target.volume_serial != committed_stage.volume_serial || committed_target.file_index != committed_stage.file_index) {
    throw NativeError("Committed target handle does not identify the staged file object.");
  }
  if ((committed_target.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || committed_target.reparse_tag != 0) {
    throw NativeError("Committed target handle is not one regular non-reparse file.");
  }
  ValidateSecurity(stage, state.security, false);
  ValidateSecurity(target.get(), state.security, false);
  ValidateStageBytes(stage, expected);
}

constexpr DWORD kDiagnosticBaselineParentAccess = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL;
constexpr DWORD kDiagnosticFullParentAccess =
    GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | FILE_DELETE_CHILD | DELETE;

struct RenameDiagnosticSpec {
  const char* id;
  const wchar_t* stem;
  DWORD parent_access;
  const char* parent_access_profile;
  bool parent_open_reparse_point;
  bool target_exists;
  RenameInformationProfile information_profile;
  RenameBufferProfile buffer_profile;
  bool basic_stage_options;
};

constexpr std::array<RenameDiagnosticSpec, 10> kRenameDiagnosticSpecs{{
    {"extended-baseline-existing-padded", L"diag-01", kDiagnosticBaselineParentAccess, "baseline-read", true, true,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-baseline-absent-padded", L"diag-02", kDiagnosticBaselineParentAccess, "baseline-read", true, false,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-baseline-existing-exact", L"diag-03", kDiagnosticBaselineParentAccess, "baseline-read", true, true,
     RenameInformationProfile::extended, RenameBufferProfile::exact_tail, false},
    {"extended-add-file-absent-padded", L"diag-04", kDiagnosticBaselineParentAccess | FILE_ADD_FILE, "add-file", true, false,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-delete-child-existing-padded", L"diag-05", kDiagnosticBaselineParentAccess | FILE_DELETE_CHILD, "delete-child", true, true,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-full-parent-existing-padded", L"diag-06", kDiagnosticFullParentAccess, "full-rename", true, true,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-full-parent-no-reparse-existing-padded", L"diag-07", kDiagnosticFullParentAccess, "full-rename", false, true,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, false},
    {"extended-full-parent-no-reparse-existing-exact", L"diag-08", kDiagnosticFullParentAccess, "full-rename", false, true,
     RenameInformationProfile::extended, RenameBufferProfile::exact_tail, false},
    {"legacy-full-parent-no-reparse-existing-exact", L"diag-09", kDiagnosticFullParentAccess, "full-rename", false, true,
     RenameInformationProfile::legacy, RenameBufferProfile::exact_tail, false},
    {"extended-full-parent-no-reparse-basic-stage", L"diag-10", kDiagnosticFullParentAccess, "full-rename", false, true,
     RenameInformationProfile::extended, RenameBufferProfile::padded_structure, true},
}};

struct RenameDiagnosticOutcome {
  const RenameDiagnosticSpec* spec{};
  std::string outcome{"win32-error"};
  std::string phase{"rename"};
  DWORD error_code{ERROR_SUCCESS};
  bool buffer_aligned{false};
  bool target_invariant_preserved{false};
  bool stage_absent_after_failure{false};
  bool committed_identity_verified{false};
};

std::vector<std::byte> DiagnosticBytes(const std::string& value) {
  const auto* begin = reinterpret_cast<const std::byte*>(value.data());
  return std::vector<std::byte>(begin, begin + value.size());
}

bool PathIsAbsent(const std::wstring& path) {
  if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  const DWORD error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

void CreateDiagnosticFile(const std::wstring& path, const SecurityContext& security, const std::vector<std::byte>& bytes) {
  UniqueHandle handle(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle) ThrowWin32("CreateFileW(rename diagnostic target)");
  ValidateSecurity(handle.get(), security, false);
  WriteAll(handle.get(), bytes);
  ValidateStageBytes(handle.get(), bytes);
}

bool DiagnosticFileEquals(const std::wstring& path, const SecurityContext& security, const std::vector<std::byte>& expected) {
  UniqueHandle handle = OpenSnapshot(path);
  ValidateSecurity(handle.get(), security, false);
  return ReadExact(handle.get()) == expected;
}

RenameDiagnosticOutcome RunRenameDiagnosticCase(const RenameDiagnosticSpec& spec, const std::wstring& root_path,
                                                const FilesystemObject& root_identity, const SecurityContext& security) {
  RenameDiagnosticOutcome result;
  result.spec = &spec;
  const std::wstring stem(spec.stem);
  const std::wstring target_name = stem + L"-target.dat";
  const std::wstring stage_name = stem + L"-stage.tmp";
  const std::wstring target_path = root_path + L'\\' + target_name;
  const std::wstring stage_path = root_path + L'\\' + stage_name;
  const std::vector<std::byte> previous = DiagnosticBytes("qa10-known-good-v1");
  const std::vector<std::byte> replacement = DiagnosticBytes("qa10-replacement-v1");
  if (spec.target_exists) CreateDiagnosticFile(target_path, security, previous);
  else if (!PathIsAbsent(target_path)) throw NativeError("Rename diagnostic absent target already exists.");

  const DWORD parent_options = FILE_FLAG_BACKUP_SEMANTICS | (spec.parent_open_reparse_point ? FILE_FLAG_OPEN_REPARSE_POINT : 0U);
  UniqueHandle parent(CreateFileW(root_path.c_str(), spec.parent_access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, parent_options, nullptr));
  if (!parent) {
    result.phase = "parent-open";
    result.error_code = GetLastError();
    result.target_invariant_preserved = spec.target_exists ? DiagnosticFileEquals(target_path, security, previous) : PathIsAbsent(target_path);
    result.stage_absent_after_failure = PathIsAbsent(stage_path);
    return result;
  }
  const FilesystemObject parent_identity = InspectObject(parent.get());
  if (!SamePath(parent_identity.final_path, root_path) || parent_identity.volume_serial != root_identity.volume_serial ||
      parent_identity.file_index != root_identity.file_index || (parent_identity.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (parent_identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || parent_identity.reparse_tag != 0) {
    throw NativeError("Rename diagnostic parent handle differs from the validated root object.");
  }
  ValidateSecurity(parent.get(), security, true);

  const DWORD stage_options = spec.basic_stage_options
                                  ? FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH
                                  : FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT;
  UniqueHandle stage(CreateFileW(stage_path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, nullptr, CREATE_NEW, stage_options, nullptr));
  if (!stage) ThrowWin32("CreateFileW(rename diagnostic stage)");
  const FilesystemObject initial_stage = InspectObject(stage.get());
  if (!SamePath(initial_stage.final_path, stage_path) || !WithinRoot(root_path, initial_stage.final_path) ||
      (initial_stage.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || initial_stage.reparse_tag != 0) {
    throw NativeError("Rename diagnostic stage is not one contained regular non-reparse file.");
  }
  ValidateSecurity(stage.get(), security, false);
  WriteAll(stage.get(), replacement);
  ValidateStageBytes(stage.get(), replacement);

  result.error_code = AttemptRenameStage(stage.get(), parent.get(), target_name, spec.information_profile, spec.buffer_profile,
                                         RenameReplacementProfile::classic, &result.buffer_aligned);
  if (result.error_code == ERROR_SUCCESS) {
    result.outcome = "renamed";
    const FilesystemObject committed = InspectObject(stage.get());
    if (!SamePath(committed.final_path, target_path) || committed.volume_serial != initial_stage.volume_serial ||
        committed.file_index != initial_stage.file_index || (committed.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        committed.reparse_tag != 0) {
      throw NativeError("Rename diagnostic commit did not preserve the staged object at the exact target.");
    }
    ValidateSecurity(stage.get(), security, false);
    ValidateStageBytes(stage.get(), replacement);
    result.committed_identity_verified = true;
    result.target_invariant_preserved = true;
    result.stage_absent_after_failure = PathIsAbsent(stage_path);
    return result;
  }

  MarkStageForDeletion(stage.get());
  if (!stage.reset()) throw NativeError("Rename diagnostic stage handle could not close exactly once.");
  result.stage_absent_after_failure = PathIsAbsent(stage_path);
  result.target_invariant_preserved = spec.target_exists ? DiagnosticFileEquals(target_path, security, previous) : PathIsAbsent(target_path);
  if (!result.stage_absent_after_failure || !result.target_invariant_preserved) {
    throw NativeError("Rename diagnostic failure changed its target or retained its exact stage.");
  }
  return result;
}

napi_value RunRenameDiagnostics(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    std::size_t argument_count = 1;
    napi_value arguments[1]{};
    CheckNapi(env, napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr), "napi_get_cb_info");
    if (argument_count != 1) throw NativeError("runRenameDiagnostics requires exactly one options object.");
    RequireObject(env, arguments[0], "Rename diagnostic options");
    RequireVersionOne(env, arguments[0], "Rename diagnostic options");
    const std::wstring root_path = NormalizePath(GetString(env, GetNamed(env, arguments[0], "privateRoot"), "Rename diagnostic root"));
    const ExpectedIdentity expected_identity = ParseExpectedIdentity(env, GetNamed(env, arguments[0], "expectedIdentity"));
    if (!SamePath(root_path, expected_identity.canonical_path)) throw NativeError("Rename diagnostic root differs from its expected canonical path.");
    const SecurityContext security = CurrentSecurityContext();
    UniqueHandle root_handle = OpenPinnedDirectory(root_path);
    const FilesystemObject root_identity = InspectObject(root_handle.get());
    if (!SamePath(root_identity.final_path, root_path) || (root_identity.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (root_identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || root_identity.reparse_tag != 0 ||
        root_identity.volume_serial != ParseUnsigned(expected_identity.device, "Persisted device") ||
        !PersistedInodeMatches(expected_identity.inode, root_identity.file_index)) {
      throw NativeError("Rename diagnostic root is not the expected non-reparse directory object.");
    }
    ValidateSecurity(root_handle.get(), security, true);
    std::array<wchar_t, 64> filesystem_name{};
    DWORD maximum_component_length = 0;
    DWORD filesystem_flags = 0;
    if (GetVolumeInformationByHandleW(root_handle.get(), nullptr, 0, nullptr, &maximum_component_length, &filesystem_flags,
                                      filesystem_name.data(), static_cast<DWORD>(filesystem_name.size())) == FALSE) {
      ThrowWin32("GetVolumeInformationByHandleW(rename diagnostic root)");
    }
    if (!root_handle.reset()) throw NativeError("Rename diagnostic validation handle could not close exactly once.");

    napi_value cases = Array(env, kRenameDiagnosticSpecs.size());
    for (std::size_t index = 0; index < kRenameDiagnosticSpecs.size(); ++index) {
      const RenameDiagnosticOutcome outcome = RunRenameDiagnosticCase(kRenameDiagnosticSpecs[index], root_path, root_identity, security);
      napi_value entry = Object(env);
      Set(env, entry, "id", String(env, outcome.spec->id));
      Set(env, entry, "outcome", String(env, outcome.outcome));
      Set(env, entry, "phase", String(env, outcome.phase));
      Set(env, entry, "errorCode", Integer(env, outcome.error_code));
      Set(env, entry, "targetExisted", Boolean(env, outcome.spec->target_exists));
      Set(env, entry, "parentAccessProfile", String(env, outcome.spec->parent_access_profile));
      Set(env, entry, "parentOpenReparsePoint", Boolean(env, outcome.spec->parent_open_reparse_point));
      Set(env, entry, "informationClass", String(env, outcome.spec->information_profile == RenameInformationProfile::extended ? "extended" : "legacy"));
      Set(env, entry, "bufferProfile", String(env, outcome.spec->buffer_profile == RenameBufferProfile::exact_tail ? "exact-tail" : "padded-structure"));
      Set(env, entry, "stageProfile", String(env, outcome.spec->basic_stage_options ? "basic" : "current"));
      Set(env, entry, "bufferAligned", Boolean(env, outcome.buffer_aligned));
      Set(env, entry, "targetInvariantPreserved", Boolean(env, outcome.target_invariant_preserved));
      Set(env, entry, "stageAbsentAfterFailure", Boolean(env, outcome.stage_absent_after_failure));
      Set(env, entry, "committedIdentityVerified", Boolean(env, outcome.committed_identity_verified));
      Set(env, cases, static_cast<std::uint32_t>(index), entry);
    }

    UniqueHandle final_root_handle = OpenPinnedDirectory(root_path);
    const FilesystemObject final_root_identity = InspectObject(final_root_handle.get());
    if (!SamePath(final_root_identity.final_path, root_path) || final_root_identity.volume_serial != root_identity.volume_serial ||
        final_root_identity.file_index != root_identity.file_index) {
      throw NativeError("Rename diagnostic root identity changed across the matrix.");
    }
    ValidateSecurity(final_root_handle.get(), security, true);

    napi_value structure = Object(env);
    Set(env, structure, "fileRenameInfoSize", Integer(env, static_cast<std::uint32_t>(sizeof(FILE_RENAME_INFO))));
    Set(env, structure, "fileNameOffset", Integer(env, static_cast<std::uint32_t>(offsetof(FILE_RENAME_INFO, FileName))));
    Set(env, structure, "alignment", Integer(env, static_cast<std::uint32_t>(alignof(FILE_RENAME_INFO))));
    Set(env, structure, "wideCharacterBytes", Integer(env, static_cast<std::uint32_t>(sizeof(wchar_t))));
    napi_value filesystem = Object(env);
    Set(env, filesystem, "name", String(env, std::wstring(filesystem_name.data())));
    Set(env, filesystem, "maximumComponentLength", Integer(env, maximum_component_length));
    Set(env, filesystem, "flags", Integer(env, filesystem_flags));
    napi_value result = Object(env);
    Set(env, result, "version", Integer(env, 1));
    Set(env, result, "matrixVersion", Integer(env, 1));
    Set(env, result, "structure", structure);
    Set(env, result, "filesystem", filesystem);
    Set(env, result, "cases", cases);
    return result;
  });
}

struct ReplacementIdentityDiagnosticSpec {
  const char* id;
  const wchar_t* stem;
  bool target_exists;
  RenameReplacementProfile replacement_profile;
  bool stage_share_zero;
  bool retain_target_handle;
};

constexpr std::array<ReplacementIdentityDiagnosticSpec, 5> kReplacementIdentityDiagnosticSpecs{{
    {"existing-classic-share-zero", L"identity-01", true, RenameReplacementProfile::classic, true, false},
    {"existing-posix-share-zero", L"identity-02", true, RenameReplacementProfile::subsequent_opens_bind_renamed_file, true, false},
    {"absent-posix-share-zero", L"identity-03", false, RenameReplacementProfile::subsequent_opens_bind_renamed_file, true, false},
    {"existing-posix-shared-stage", L"identity-04", true, RenameReplacementProfile::subsequent_opens_bind_renamed_file, false, false},
    {"existing-posix-share-zero-retained-target", L"identity-05", true,
     RenameReplacementProfile::subsequent_opens_bind_renamed_file, true, true},
}};

struct ReplacementTargetObservation {
  DWORD open_error_code{ERROR_SUCCESS};
  bool attempted{false};
  bool opened{false};
  bool path_exact{false};
  bool contained{false};
  bool regular_non_reparse{false};
  bool security_valid{false};
  std::optional<FileIdentity> identity;
};

struct ReplacementIdentityDiagnosticOutcome {
  const ReplacementIdentityDiagnosticSpec* spec{};
  DWORD displaced_open_error_code{ERROR_SUCCESS};
  DWORD stage_open_error_code{ERROR_SUCCESS};
  DWORD rename_error_code{ERROR_SUCCESS};
  bool displaced_open_attempted{false};
  bool displaced_identity_observed{false};
  bool retained_target_handle_opened{false};
  bool retained_target_identity_stable{false};
  bool retained_target_bytes_original_after_rename{false};
  bool retained_target_close_succeeded{true};
  bool stage_open_attempted{false};
  bool stage_opened{false};
  bool buffer_aligned{false};
  bool rename_attempted{false};
  bool rename_succeeded{false};
  bool stage_identity_stable_before_close{false};
  bool stage_regular_before_close{false};
  bool stage_close_attempted{false};
  bool stage_close_succeeded{false};
  ReplacementTargetObservation while_stage;
  ReplacementTargetObservation after_stage_close;
  bool target_matches_stage_while_open{false};
  bool target_matches_displaced_while_open{false};
  bool target_matches_stage_after_close{false};
  bool target_matches_displaced_after_close{false};
  bool target_binding_changed_after_close{false};
  bool replacement_bytes_visible_after_close{false};
  bool case_filesystem_invariant_preserved{false};
};

UniqueHandle TryOpenReplacementDiagnosticFile(const std::wstring& path, const DWORD access, const DWORD share, DWORD* const error_code) {
  const HANDLE handle = CreateFileW(path.c_str(), access, share, nullptr, OPEN_EXISTING,
                                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    *error_code = GetLastError();
    return {};
  }
  *error_code = ERROR_SUCCESS;
  return UniqueHandle(handle);
}

bool DiagnosticSecurityIsValid(HANDLE handle, const SecurityContext& security) noexcept {
  try {
    ValidateSecurity(handle, security, false);
    return true;
  } catch (...) {
    return false;
  }
}

bool DiagnosticFileEqualsNoThrow(const std::wstring& path, const SecurityContext& security,
                                 const std::vector<std::byte>& expected) noexcept {
  try {
    return DiagnosticFileEquals(path, security, expected);
  } catch (...) {
    return false;
  }
}

ReplacementTargetObservation ObserveReplacementDiagnosticTarget(const std::wstring& path, const std::wstring& root_path,
                                                                 const SecurityContext& security) {
  ReplacementTargetObservation result;
  result.attempted = true;
  UniqueHandle handle = TryOpenReplacementDiagnosticFile(path, FILE_READ_ATTRIBUTES | READ_CONTROL,
                                                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                                         &result.open_error_code);
  if (!handle) return result;
  result.opened = true;
  const FilesystemObject object = InspectObject(handle.get());
  result.path_exact = SamePath(object.final_path, path);
  result.contained = WithinRoot(root_path, object.final_path);
  result.regular_non_reparse =
      (object.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 && object.reparse_tag == 0;
  result.security_valid = DiagnosticSecurityIsValid(handle.get(), security);
  result.identity = ObjectIdentity(object);
  return result;
}

ReplacementIdentityDiagnosticOutcome RunReplacementIdentityDiagnosticCase(const ReplacementIdentityDiagnosticSpec& spec,
                                                                           const std::wstring& root_path,
                                                                           const SecurityContext& security) {
  ReplacementIdentityDiagnosticOutcome result;
  result.spec = &spec;
  const std::wstring stem(spec.stem);
  const std::wstring target_name = stem + L"-target.dat";
  const std::wstring stage_name = stem + L"-stage.tmp";
  const std::wstring target_path = root_path + L'\\' + target_name;
  const std::wstring stage_path = root_path + L'\\' + stage_name;
  const std::vector<std::byte> previous = DiagnosticBytes("qa10-displaced-object-v1");
  const std::vector<std::byte> replacement = DiagnosticBytes("qa10-staged-object-v1");
  std::optional<FileIdentity> displaced_identity;
  UniqueHandle retained_target;

  if (spec.target_exists) {
    CreateDiagnosticFile(target_path, security, previous);
    result.displaced_open_attempted = true;
    UniqueHandle existing = TryOpenReplacementDiagnosticFile(target_path, GENERIC_READ | READ_CONTROL,
                                                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                                             &result.displaced_open_error_code);
    if (!existing) return result;
    const FilesystemObject existing_object = InspectObject(existing.get());
    if (!SamePath(existing_object.final_path, target_path) || !WithinRoot(root_path, existing_object.final_path) ||
        (existing_object.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        existing_object.reparse_tag != 0) {
      throw NativeError("Replacement diagnostic existing target is not one exact regular non-reparse object.");
    }
    ValidateSecurity(existing.get(), security, false);
    displaced_identity = ObjectIdentity(existing_object);
    result.displaced_identity_observed = true;
    if (spec.retain_target_handle) {
      retained_target = std::move(existing);
      result.retained_target_handle_opened = true;
    }
  } else if (!PathIsAbsent(target_path)) {
    throw NativeError("Replacement diagnostic absent target already exists.");
  }

  const DWORD stage_share = spec.stage_share_zero ? 0U : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  result.stage_open_attempted = true;
  UniqueHandle stage(CreateFileW(stage_path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, stage_share, nullptr,
                                 CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!stage) {
    result.stage_open_error_code = GetLastError();
    return result;
  }
  result.stage_opened = true;
  const FilesystemObject initial_stage_object = InspectObject(stage.get());
  const FileIdentity initial_stage = ObjectIdentity(initial_stage_object);
  if (!SamePath(initial_stage_object.final_path, stage_path) || !WithinRoot(root_path, initial_stage_object.final_path) ||
      (initial_stage.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || initial_stage.reparse_tag != 0) {
    throw NativeError("Replacement diagnostic stage is not one exact contained regular non-reparse object.");
  }
  ValidateSecurity(stage.get(), security, false);
  WriteAll(stage.get(), replacement);
  ValidateStageBytes(stage.get(), replacement);

  result.rename_attempted = true;
  result.rename_error_code = AttemptRenameStage(stage.get(), nullptr, target_path, RenameInformationProfile::extended,
                                                RenameBufferProfile::padded_structure, spec.replacement_profile,
                                                &result.buffer_aligned);
  result.rename_succeeded = result.rename_error_code == ERROR_SUCCESS;
  if (result.rename_succeeded) {
    const FileIdentity committed_stage = InspectFileIdentity(stage.get());
    result.stage_identity_stable_before_close = SameFileObject(committed_stage, initial_stage);
    result.stage_regular_before_close =
        (committed_stage.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 && committed_stage.reparse_tag == 0;
    result.while_stage = ObserveReplacementDiagnosticTarget(target_path, root_path, security);
    if (result.while_stage.identity.has_value()) {
      result.target_matches_stage_while_open = SameFileObject(*result.while_stage.identity, initial_stage);
      result.target_matches_displaced_while_open =
          displaced_identity.has_value() && SameFileObject(*result.while_stage.identity, *displaced_identity);
    }
    if (retained_target) {
      result.retained_target_identity_stable =
          displaced_identity.has_value() && SameFileObject(InspectFileIdentity(retained_target.get()), *displaced_identity);
      try {
        result.retained_target_bytes_original_after_rename = ReadExact(retained_target.get()) == previous;
      } catch (...) {
        result.retained_target_bytes_original_after_rename = false;
      }
    }
  } else {
    MarkStageForDeletion(stage.get());
  }

  result.stage_close_attempted = true;
  result.stage_close_succeeded = stage.reset();
  result.after_stage_close = ObserveReplacementDiagnosticTarget(target_path, root_path, security);
  if (result.after_stage_close.identity.has_value()) {
    result.target_matches_stage_after_close = SameFileObject(*result.after_stage_close.identity, initial_stage);
    result.target_matches_displaced_after_close =
        displaced_identity.has_value() && SameFileObject(*result.after_stage_close.identity, *displaced_identity);
  }
  result.target_binding_changed_after_close =
      result.while_stage.identity.has_value() && result.after_stage_close.identity.has_value() &&
      !SameFileObject(*result.while_stage.identity, *result.after_stage_close.identity);
  result.replacement_bytes_visible_after_close =
      result.rename_succeeded && DiagnosticFileEqualsNoThrow(target_path, security, replacement);

  const bool stage_name_absent = PathIsAbsent(stage_path);
  if (result.rename_succeeded) {
    result.case_filesystem_invariant_preserved = stage_name_absent && result.target_matches_stage_after_close &&
                                                 result.replacement_bytes_visible_after_close;
  } else {
    const bool target_preserved = spec.target_exists
                                      ? DiagnosticFileEqualsNoThrow(target_path, security, previous)
                                      : PathIsAbsent(target_path);
    result.case_filesystem_invariant_preserved = stage_name_absent && target_preserved;
  }
  if (retained_target) result.retained_target_close_succeeded = retained_target.reset();
  return result;
}

napi_value RunReplacementIdentityDiagnostics(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    std::size_t argument_count = 1;
    napi_value arguments[1]{};
    CheckNapi(env, napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr), "napi_get_cb_info");
    if (argument_count != 1) throw NativeError("runReplacementIdentityDiagnostics requires exactly one options object.");
    RequireObject(env, arguments[0], "Replacement identity diagnostic options");
    RequireVersionOne(env, arguments[0], "Replacement identity diagnostic options");
    const std::wstring root_path = NormalizePath(
        GetString(env, GetNamed(env, arguments[0], "privateRoot"), "Replacement identity diagnostic root"));
    const ExpectedIdentity expected_identity = ParseExpectedIdentity(env, GetNamed(env, arguments[0], "expectedIdentity"));
    if (!SamePath(root_path, expected_identity.canonical_path)) {
      throw NativeError("Replacement identity diagnostic root differs from its expected canonical path.");
    }
    const SecurityContext security = CurrentSecurityContext();
    UniqueHandle root_handle = OpenPinnedDirectory(root_path);
    const FilesystemObject root_identity = InspectObject(root_handle.get());
    if (!SamePath(root_identity.final_path, root_path) || (root_identity.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (root_identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || root_identity.reparse_tag != 0 ||
        root_identity.volume_serial != ParseUnsigned(expected_identity.device, "Persisted device") ||
        !PersistedInodeMatches(expected_identity.inode, root_identity.file_index)) {
      throw NativeError("Replacement identity diagnostic root is not the expected non-reparse directory object.");
    }
    ValidateSecurity(root_handle.get(), security, true);

    napi_value cases = Array(env, kReplacementIdentityDiagnosticSpecs.size());
    for (std::size_t index = 0; index < kReplacementIdentityDiagnosticSpecs.size(); ++index) {
      const ReplacementIdentityDiagnosticOutcome outcome =
          RunReplacementIdentityDiagnosticCase(kReplacementIdentityDiagnosticSpecs[index], root_path, security);
      napi_value entry = Object(env);
      Set(env, entry, "id", String(env, outcome.spec->id));
      Set(env, entry, "displacedOpenErrorCode", Integer(env, outcome.displaced_open_error_code));
      Set(env, entry, "stageOpenErrorCode", Integer(env, outcome.stage_open_error_code));
      Set(env, entry, "renameErrorCode", Integer(env, outcome.rename_error_code));
      Set(env, entry, "targetOpenWhileStageErrorCode", Integer(env, outcome.while_stage.open_error_code));
      Set(env, entry, "targetOpenAfterStageCloseErrorCode", Integer(env, outcome.after_stage_close.open_error_code));
      Set(env, entry, "targetExisted", Boolean(env, outcome.spec->target_exists));
      Set(env, entry, "posixVisibilityRequested",
          Boolean(env, outcome.spec->replacement_profile == RenameReplacementProfile::subsequent_opens_bind_renamed_file));
      Set(env, entry, "stageShareZero", Boolean(env, outcome.spec->stage_share_zero));
      Set(env, entry, "retainedTargetHandleRequested", Boolean(env, outcome.spec->retain_target_handle));
      Set(env, entry, "displacedOpenAttempted", Boolean(env, outcome.displaced_open_attempted));
      Set(env, entry, "displacedIdentityObserved", Boolean(env, outcome.displaced_identity_observed));
      Set(env, entry, "retainedTargetHandleOpened", Boolean(env, outcome.retained_target_handle_opened));
      Set(env, entry, "retainedTargetIdentityStable", Boolean(env, outcome.retained_target_identity_stable));
      Set(env, entry, "retainedTargetBytesOriginalAfterRename", Boolean(env, outcome.retained_target_bytes_original_after_rename));
      Set(env, entry, "retainedTargetCloseSucceeded", Boolean(env, outcome.retained_target_close_succeeded));
      Set(env, entry, "stageOpenAttempted", Boolean(env, outcome.stage_open_attempted));
      Set(env, entry, "stageOpened", Boolean(env, outcome.stage_opened));
      Set(env, entry, "bufferAligned", Boolean(env, outcome.buffer_aligned));
      Set(env, entry, "renameAttempted", Boolean(env, outcome.rename_attempted));
      Set(env, entry, "renameSucceeded", Boolean(env, outcome.rename_succeeded));
      Set(env, entry, "stageIdentityStableBeforeClose", Boolean(env, outcome.stage_identity_stable_before_close));
      Set(env, entry, "stageRegularBeforeClose", Boolean(env, outcome.stage_regular_before_close));
      Set(env, entry, "stageCloseAttempted", Boolean(env, outcome.stage_close_attempted));
      Set(env, entry, "stageCloseSucceeded", Boolean(env, outcome.stage_close_succeeded));
      Set(env, entry, "targetOpenWhileStageAttempted", Boolean(env, outcome.while_stage.attempted));
      Set(env, entry, "targetOpenedWhileStage", Boolean(env, outcome.while_stage.opened));
      Set(env, entry, "targetPathExactWhileStage", Boolean(env, outcome.while_stage.path_exact));
      Set(env, entry, "targetContainedWhileStage", Boolean(env, outcome.while_stage.contained));
      Set(env, entry, "targetRegularWhileStage", Boolean(env, outcome.while_stage.regular_non_reparse));
      Set(env, entry, "targetSecurityValidWhileStage", Boolean(env, outcome.while_stage.security_valid));
      Set(env, entry, "targetMatchesStageWhileStage", Boolean(env, outcome.target_matches_stage_while_open));
      Set(env, entry, "targetMatchesDisplacedWhileStage", Boolean(env, outcome.target_matches_displaced_while_open));
      Set(env, entry, "targetOpenAfterStageCloseAttempted", Boolean(env, outcome.after_stage_close.attempted));
      Set(env, entry, "targetOpenedAfterStageClose", Boolean(env, outcome.after_stage_close.opened));
      Set(env, entry, "targetPathExactAfterStageClose", Boolean(env, outcome.after_stage_close.path_exact));
      Set(env, entry, "targetContainedAfterStageClose", Boolean(env, outcome.after_stage_close.contained));
      Set(env, entry, "targetRegularAfterStageClose", Boolean(env, outcome.after_stage_close.regular_non_reparse));
      Set(env, entry, "targetSecurityValidAfterStageClose", Boolean(env, outcome.after_stage_close.security_valid));
      Set(env, entry, "targetMatchesStageAfterStageClose", Boolean(env, outcome.target_matches_stage_after_close));
      Set(env, entry, "targetMatchesDisplacedAfterStageClose", Boolean(env, outcome.target_matches_displaced_after_close));
      Set(env, entry, "targetBindingChangedAfterStageClose", Boolean(env, outcome.target_binding_changed_after_close));
      Set(env, entry, "replacementBytesVisibleAfterStageClose", Boolean(env, outcome.replacement_bytes_visible_after_close));
      Set(env, entry, "caseFilesystemInvariantPreserved", Boolean(env, outcome.case_filesystem_invariant_preserved));
      Set(env, cases, static_cast<std::uint32_t>(index), entry);
    }

    const FilesystemObject final_root_identity = InspectObject(root_handle.get());
    if (!SamePath(final_root_identity.final_path, root_path) || final_root_identity.volume_serial != root_identity.volume_serial ||
        final_root_identity.file_index != root_identity.file_index) {
      throw NativeError("Replacement identity diagnostic root changed across the matrix.");
    }
    ValidateSecurity(root_handle.get(), security, true);

    napi_value result = Object(env);
    Set(env, result, "version", Integer(env, 1));
    Set(env, result, "matrixVersion", Integer(env, 1));
    Set(env, result, "cases", cases);
    return result;
  });
}

napi_value AtomicReplace(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    std::vector<napi_value> arguments(2);
    LeaseState* state = UnwrapLease(env, info, &arguments);
    if (arguments.size() != 2) throw NativeError("atomicReplace requires exactly one path and one byte value.");
    try {
      ValidateAll(*state);
      const AllowedPath& allowed = FindAllowedPath(*state, GetString(env, arguments[0], "Atomic replacement path"));
      const std::vector<std::byte> bytes = BytesFromValue(env, arguments[1]);
      PinnedDirectory& parent = state->directories.at(allowed.parent_index);
      const std::wstring absolute_target_path = PinnedAbsoluteTargetPath(allowed, parent, *state);

      UniqueHandle stage;
      std::wstring stage_path;
      for (int attempt = 0; attempt < 32; ++attempt) {
        stage_path = parent.path + L'\\' + RandomStageName();
        const HANDLE raw = CreateFileW(stage_path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, nullptr, CREATE_NEW,
                                       FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (raw != INVALID_HANDLE_VALUE) {
          stage.reset(raw);
          break;
        }
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) ThrowWin32("CreateFileW(atomic stage)");
      }
      if (!stage) throw NativeError("Unable to allocate a unique handle-bound atomic stage.");
      bool renamed = false;
      try {
        const FilesystemObject initial_stage = InspectObject(stage.get());
        if (!SamePath(initial_stage.final_path, stage_path) || !WithinRoot(state->root_path, initial_stage.final_path) ||
            (initial_stage.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || initial_stage.reparse_tag != 0) {
          throw NativeError("Atomic stage is not one contained regular non-reparse file.");
        }
        ValidateSecurity(stage.get(), state->security, false);
        WriteAll(stage.get(), bytes);
        ValidateStageBytes(stage.get(), bytes);
        ValidateAll(*state);
        RenameStageToPinnedAbsoluteTarget(stage.get(), absolute_target_path);
        renamed = true;
        ValidateCommittedTarget(stage.get(), initial_stage, allowed, *state, bytes);
        ValidateAll(*state);
      } catch (...) {
        if (!renamed) MarkStageForDeletion(stage.get());
        throw;
      }

      napi_value result = Object(env);
      Set(env, result, "version", Integer(env, 1));
      Set(env, result, "path", String(env, allowed.path));
      Set(env, result, "rootIdentity", ExpectedIdentityObject(env, *state));
      Set(env, result, "committed", Boolean(env, true));
      Set(env, result, "stagedAndRenamedByHandle", Boolean(env, true));
      Set(env, result, "pinnedAbsoluteTarget", Boolean(env, true));
      napi_value length{};
      CheckNapi(env, napi_create_double(env, static_cast<double>(bytes.size()), &length), "napi_create_double");
      Set(env, result, "byteLength", length);
      return result;
    } catch (const std::exception& error) {
      if (state->sticky_error.empty()) state->sticky_error = error.what();
      throw;
    }
  });
}

napi_value CloseLease(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    LeaseState* state = UnwrapLease(env, info);
    if (state->closed) throw NativeError("Private-root handle lease is already closed.");
    state->closed = true;
    bool okay = true;
    for (auto iterator = state->directories.rbegin(); iterator != state->directories.rend(); ++iterator) okay = iterator->handle.reset() && okay;
    if (!okay) throw NativeError("One or more private-root handles could not be closed exactly once.");
    napi_value result{};
    CheckNapi(env, napi_get_undefined(env, &result), "napi_get_undefined");
    return result;
  });
}

napi_value Method(napi_env env, const char* name, napi_callback callback) {
  napi_value result{};
  CheckNapi(env, napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &result), "napi_create_function");
  return result;
}

void AddPinnedParent(LeaseState& state, const std::wstring& path) {
  for (const auto& directory : state.directories) if (SamePath(directory.path, path)) return;
  UniqueHandle handle = OpenPinnedDirectory(path);
  PinnedDirectory directory{path, std::move(handle), {}, false};
  directory.identity = InspectObject(directory.handle.get());
  if (!SamePath(directory.identity.final_path, path) || !WithinRoot(state.root_path, path) ||
      (directory.identity.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (directory.identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || directory.identity.reparse_tag != 0) {
    throw NativeError("Allowlisted parent is not one contained non-reparse directory.");
  }
  ValidateSecurity(directory.handle.get(), state.security, false);
  state.directories.push_back(std::move(directory));
}

void PinParentChain(LeaseState& state, const std::wstring& target) {
  const std::wstring parent = ParentPath(target);
  if (!WithinRoot(state.root_path, parent)) throw NativeError("Allowlisted path escapes the private root.");
  if (SamePath(parent, state.root_path)) return;
  const std::wstring relative = parent.substr(state.root_path.size() + 1U);
  std::wstring current = state.root_path;
  std::size_t offset = 0;
  while (offset < relative.size()) {
    const std::size_t separator = relative.find(L'\\', offset);
    const std::wstring component = relative.substr(offset, separator == std::wstring::npos ? std::wstring::npos : separator - offset);
    if (component.empty() || component == L"." || component == L"..") throw NativeError("Allowlisted path has an invalid parent component.");
    current += L'\\' + component;
    AddPinnedParent(state, current);
    if (separator == std::wstring::npos) break;
    offset = separator + 1U;
  }
}

napi_value AcquireLease(napi_env env, napi_callback_info info) {
  return CallbackBoundary(env, [&]() {
    std::size_t argument_count = 1;
    napi_value arguments[1]{};
    CheckNapi(env, napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr), "napi_get_cb_info");
    if (argument_count != 1) throw NativeError("acquireLease requires exactly one options object.");
    RequireObject(env, arguments[0], "Private-root lease options");
    RequireVersionOne(env, arguments[0], "Private-root lease options");
    auto state = std::make_unique<LeaseState>();
    state->root_path = NormalizePath(GetString(env, GetNamed(env, arguments[0], "privateRoot"), "Private root"));
    state->expected_identity = ParseExpectedIdentity(env, GetNamed(env, arguments[0], "expectedIdentity"));
    if (!SamePath(state->root_path, state->expected_identity.canonical_path)) throw NativeError("Expected private-root canonical path differs from the requested root.");
    state->security = CurrentSecurityContext();

    UniqueHandle root_handle = OpenPinnedDirectory(state->root_path);
    PinnedDirectory root{state->root_path, std::move(root_handle), {}, true};
    root.identity = InspectObject(root.handle.get());
    if (!SamePath(root.identity.final_path, state->root_path) || (root.identity.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (root.identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || root.identity.reparse_tag != 0) {
      throw NativeError("Private-root handle is not the requested non-reparse directory.");
    }
    if (root.identity.volume_serial != ParseUnsigned(state->expected_identity.device, "Persisted device") ||
        !PersistedInodeMatches(state->expected_identity.inode, root.identity.file_index)) {
      throw NativeError("Private-root handle identity differs from persisted coordinator identity.");
    }
    ValidateSecurity(root.handle.get(), state->security, true);
    state->directories.push_back(std::move(root));

    napi_value paths_value = GetNamed(env, arguments[0], "paths");
    bool paths_is_array = false;
    CheckNapi(env, napi_is_array(env, paths_value, &paths_is_array), "napi_is_array");
    if (!paths_is_array) throw NativeError("Private-root lease paths must be an array.");
    std::uint32_t path_count = 0;
    CheckNapi(env, napi_get_array_length(env, paths_value, &path_count), "napi_get_array_length");
    if (path_count == 0) throw NativeError("Private-root lease requires at least one allowlisted path.");
    for (std::uint32_t index = 0; index < path_count; ++index) {
      napi_value path_value{};
      CheckNapi(env, napi_get_element(env, paths_value, index, &path_value), "napi_get_element");
      const std::wstring path = NormalizePath(GetString(env, path_value, "Allowlisted path"));
      if (!WithinRoot(state->root_path, path) || SamePath(state->root_path, path)) throw NativeError("Allowlisted path must be a descendant of the private root.");
      BaseName(path);
      for (const auto& existing : state->allowed_paths) if (SamePath(existing.path, path)) throw NativeError("Private-root lease paths must be distinct.");
      PinParentChain(*state, path);
      state->allowed_paths.push_back({path, FindDirectory(*state, ParentPath(path))});
    }
    ValidateAll(*state);

    napi_value lease = Object(env);
    Set(env, lease, "descriptor", Descriptor(env, *state));
    Set(env, lease, "assertCurrent", Method(env, "assertCurrent", AssertCurrent));
    Set(env, lease, "readSnapshot", Method(env, "readSnapshot", ReadSnapshot));
    Set(env, lease, "atomicReplace", Method(env, "atomicReplace", AtomicReplace));
    Set(env, lease, "close", Method(env, "close", CloseLease));
    CheckNapi(env, napi_wrap(env, lease, state.get(), FinalizeLease, nullptr, nullptr), "napi_wrap");
    state.release();
    return lease;
  });
}

napi_value Initialize(napi_env env, napi_value exports) {
  return CallbackBoundary(env, [&]() {
    Set(env, exports, "acquireLease", Method(env, "acquireLease", AcquireLease));
    Set(env, exports, "runRenameDiagnostics", Method(env, "runRenameDiagnostics", RunRenameDiagnostics));
    Set(env, exports, "runReplacementIdentityDiagnostics",
        Method(env, "runReplacementIdentityDiagnostics", RunReplacementIdentityDiagnostics));
    Set(env, exports, "providerVersion", Integer(env, 2));
    return exports;
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
