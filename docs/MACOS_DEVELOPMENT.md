# macOS development structure

AIMuse remains a Windows-first product. This document defines a truthful source-transfer and structural verification lane for a future macOS development host; it is not evidence of a Mac build, CoreAudio backend, signed application or release.

## Canonical bootstrap and verification

On a clean macOS clone with Xcode Command Line Tools, CMake, Git, Node 24 and npm 11 available:

```sh
nvm install
nvm use
npm ci
npm run verify:macos
```

`verify:macos` performs the following, in order:

1. checks the exact Darwin/arm64-or-x64/Node-24 host contract and reports Xcode, CMake and Git identities;
2. audits only the allowlisted initial-snapshot paths for portable names and exact-case relative imports;
3. runs TypeScript and ESLint over explicit source/configuration roots;
4. runs core, main, renderer, source-contract and portability tests while excluding live native-service/device/package cases; and
5. configures `native/build-darwin-<arch>` with audio dependencies, WASAPI, CoreAudio and runtime binaries disabled, builds the DSP/playback/parser test subject and runs CTest.

The workflow intentionally does not stage `native/dist/native` on macOS. `npm run package` and `npm run make` fail before Forge until the missing native/package security work is implemented and separately authorized.

The checked-in `.github/workflows/macos-structure.yml` runs this same path on `macos-14`, but no hosted run exists yet. Its first result must be treated as new evidence, not inferred from Windows checks.

## Structurally ready

- Node is locked to major 24 through `.nvmrc`, `package.json` and runtime preflight.
- Git text/binary rules, ignored local evidence and deterministic case/path checks are defined without root enumeration.
- Non-Windows native builds use an architecture-qualified build directory and cannot stage or package offline placeholder services.
- CMake separates pure DSP/playback/parser tests from runtime audio and plug-in helper binaries.
- Native executable names and profile-path hashing respect Windows versus POSIX case/name behavior.
- The host protocol can represent `coreaudio` and validates requested/effective mode against the selected platform driver; Windows keeps WASAPI behavior unchanged.
- Electron `safeStorage` remains the credential boundary, with platform-accurate Windows/Keychain diagnostics and the existing fail-closed storage contract.
- Forge knows the eventual macOS `.app` executable location for fuse hardening and declares a Darwin ZIP maker, while the package preflight prevents use before the rest of the Mac security contract exists.

## Explicitly unverified or missing

- A real CoreAudio implementation, shared/exclusive semantics, endpoint selection/hot-plug and device acceptance.
- Building or launching `aimuse-audio`, scanner or bridge runtime binaries on macOS.
- VST3/CLAP macOS bundle discovery/loading and isolated plug-in execution.
- Electron launch, lifecycle, menu/dialog/focus behavior and renderer/UI acceptance on macOS.
- Real Keychain encryption/decryption, prompts, locked-keychain behavior and credential leakage checks.
- Hardened-runtime entitlements, microphone/MIDI permissions, signing identities, notarization, stapling, DMG/ZIP verification and update/rollback policy.
- Universal binaries or an explicit arm64/x64 distribution policy.
- Hosted macOS CI evidence, package hashes or any macOS release certificate.

The first native macOS task should implement and test CoreAudio behind `AIMUSE_ENABLE_COREAUDIO`; it must not remove the current fail-closed runtime/package gates until exact native and package evidence exists.
