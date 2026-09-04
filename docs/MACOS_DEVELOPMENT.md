# macOS development and acceptance

AIMuse supports a native macOS development lane for the DAW, deterministic media operations, CoreAudio, project interchange, Electron editor, and authenticated local MCP. AIMuse does not use macOS Keychain or any other persistent protected-secret backend.

## Canonical bootstrap and verification

Use Node 24 from `.nvmrc` and a supported CMake/AppleClang toolchain:

```sh
nvm install
nvm use
npm ci
npm test
npm run verify:macos
npm run verify
```

`verify:macos` is a host-specific lane: it runs the macOS preflight, portability check, TypeScript/ESLint, the Darwin Vitest partition, and native CTest. It is not a notarization or release certificate. `verify` is the complete launch-free Node gate and includes the headless renderer browser suite.

Run device, codec, Electron, or packaged-app gates only from a separately authorized real logged-in user session. A filesystem-sandbox failure is not device, codec, window, signing, or package evidence.

## Native audio and architecture

The macOS native service builds extensionless `aimuse-audio`, `aimuse-plugin-scanner`, and `aimuse-plugin-bridge` binaries. The audio service uses the pinned miniaudio CoreAudio shared-device backend; exclusive mode is explicitly not claimed. Scanner/bridge binaries remain protocol/process shells until SDK-backed plug-in hosting is completed.

```sh
npm run native:configure
npm run native:build
npm run native:test
npm run macos:coreaudio-smoke
```

The CoreAudio smoke is bounded real-device evidence only. Physical device hot-plug, recording, physical MIDI, x64 hardware, universal per-slice runtime, full DSP/PDC, and SDK plug-in hosting remain separate gates. The pending AUD-03 native MIDI discovery candidate remains unchanged and must keep its exact bounded review identity until its own decision.

## Development package

`npm run package` builds the native assets for the requested architecture, copies them into the app, removes unused macOS privacy strings, flips the hardened Electron fuse set, and signs the bundle. Without `AIMUSE_MACOS_SIGN_IDENTITY` the package is ad-hoc development evidence and enables the development-only library-validation exception Electron needs. With an explicit identity it uses the stricter entitlement files. The current entitlements contain Electron JIT requirements and app audio-input permission only; they contain no Keychain access group or protected-storage entitlement.

The package verifier requires the expected architecture, bundle identity, static `LSUIElement` background bootstrap, ASAR integrity, native resources, signature structure, and fuse values. `EnableCookieEncryption` is intentionally disabled because AIMuse has no persistent browser-secret contract. The other hardened fuses remain fail-closed, including no RunAsNode, NODE_OPTIONS, inspector arguments, external app loading, or ASAR-integrity bypass.

Developer ID signing, Apple notarization, stapling, Gatekeeper acceptance, archive/update/rollback, and a fresh formal Level 3 run remain release work. Environment-provided Apple credentials are used only by the ordinary packaging/notarization tooling when that separately authorized release workflow is run; AIMuse itself does not store them.

## MCP lifecycle

Each engine start creates and rotates a fresh 32-byte bearer. Closing the listener clears it. GUI and headless modes publish the same atomic user-private PID/instance/profile-bound run-state for the AIMuse stdio bridge. The editor displays only a static one-time launcher with the stable target profile; it cannot reveal the bearer/direct URL, supply Chromium `--user-data-dir`, or edit an agent-client configuration file. The entry disables hardware acceleration and calls macOS `setActivationPolicy("prohibited")` before validation, derives a deterministic owner-private sibling, rejects canonical/filesystem aliases and link-like components, revalidates both identities around `app.setPath`, and exits explicitly without engine-profile fallback on an unsafe request. The packaged app is statically a UIElement; the primary promotes to a regular app only inside serialized editor admission, hides the Dock and restores prohibited activation after the last editor closes, and treats an ordinary `activate` event as reveal-only or immediate background restoration rather than window authority. The configured bridge privately authenticates, repairs same-session notification-stream loss on the next message, cleans late initialization on close, and reinitializes after restart without per-launch user action or protected-secret storage. Fresh arm64 packages passed exact-bridge process/alias and static-client headless checks; the later exact-envelope package also passed native non-show activation, bound attach/detach/reattach, terminal quit, and ordinary interactive startup.

A formal QA controller may still explicitly request an absolute `--write-mcp-connection` path. That caller-owned run file declares `authorityLifetime: "engine"`, stays inside the owner-private/redacted test boundary, and is not product client setup. No Keychain, DPAPI, libsecret, Electron `safeStorage`, provisioning command, storage migration, or protected-storage addon exists in the installed application.

## Evidence and claims

Historical exact-subject macOS Level 2 results remain evidence only for the bytes they certified. They do not certify this changed checkpoint. The current locally prepared ad-hoc package has its own immutable verifier, exact installed bridge, device-free native protocol and stdio-client headless evidence; it is not a formal Level 2/3 result.

The later presentation lifecycle used one Computer Use-visible packaged editor and observed the exact packaged CoreAudio helper connected in shared mode; it did not exercise playback/recording quality, microphone input, physical MIDI, hot-plug, or device fault recovery. Real signing identity, Gatekeeper, notarization, stapling, updater and distribution paths remain unexercised. The earlier device-free headless engine used the exact packaged ASAR in a separate copy whose audio helper was non-executable and whose ad-hoc envelope was refreshed; the exact relocated package itself supplied the bridge and alias-negative evidence.
