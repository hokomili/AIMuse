# macOS acceptance gate matrix

This matrix describes the current product after the 2026-08-20 removal checkpoint. AIMuse is a native agent-driven DAW, not a built-in generative-content platform. Historical exact-subject results remain historical and do not transfer to changed bytes.

## Gate status

| Gate | Current status | Required next evidence |
| --- | --- | --- |
| Node 24 source/headless gate | Working for the bounded candidate when `npm run verify` passes | Re-run for every final candidate; it must remain launch-free and include TypeScript, ESLint, Vitest, and headless renderer Playwright. |
| Darwin portability/native build | Working source lane | Run `npm run verify:macos` on the intended architecture. This includes native CTest and is not hardware or release evidence. |
| Shared CoreAudio | Prior bounded real-device evidence exists for historical exact subjects | Repeat the bounded smoke for changed native/audio bytes. Do not infer exclusive mode, hot-plug, recording, or other hardware results. |
| MIDI discovery (AUD-03) | Pending independent native candidate; preserved unchanged by this checkpoint | Complete its bounded Windows build/review decision without folding it into provider/storage work. |
| Plug-in scanner/bridge | Process/protocol shells only | Real SDK-backed discovery, isolated hosting, crash recovery, automation, and clean unload. |
| Deterministic media/interchange | Source and historical package coverage exist | Repeat codec, DAWproject, portable-pack, export, and packaged workflows for the exact candidate where applicable. |
| MCP engine authority | Source design uses one static target-only no-secret stdio setup, derives a real link-free deterministic Electron sibling with canonical/filesystem identity revalidation, and creates fresh internal 32-byte bearer per engine. Source tests bind POSIX/injected-Windows alias rejection, pre-validation prohibited macOS activation, explicit unsafe-entry exit, restart/SSE recovery, close-race cleanup, categorical empty-authority rejection and every-route authentication while stop is blocked. A relocated ad-hoc arm64 package passed exact-bridge process/alias checks plus a real static-client headless lifecycle across idle, simultaneous clients, force/graceful restarts, stale-use rejection, private state and cleanup. A later fresh exact-envelope arm64 package passed `LSUIElement`/prohibited non-show activation, one bound editor attach, detach to background, reattach, ordinary interactive startup, redacted terminal quit and zero job-owned survivors. | Rebuild and repeat installed lifecycle evidence for every source-authentication or presentation change; add named installed-client versions, changed-byte Windows ACL/runtime acceptance and UI/MCP cross-surface evidence. An explicit connection file remains QA-only run state, not product onboarding or persistent AIMuse secret storage. |
| Built-in generation/providers | Removed; not a gate | Must remain absent from runtime, preload/IPC, MCP, UI, authority policy, tests, and release claims. Passive old-project provenance is compatibility only. |
| Persistent protected-secret storage | Removed; not a gate | Installed app must start and operate without Keychain, DPAPI, libsecret, Electron `safeStorage`, provisioning, migration, or a native protected-storage addon. |
| Development package structure | Fresh local arm64 ad-hoc package passed architecture, ASAR/native resources, bundle identity including required `LSUIElement`, signature structure and exact hardened-fuse verification | Repeat on final immutable formal subjects and every shipping architecture; this is not Developer ID, notarization or distribution evidence. |
| Developer ID / Gatekeeper / notarization / stapling | Open release gate | Use reviewed real inputs on the immutable candidate, verify the finished package, archive/update/rollback, then run fresh formal Level 3. |

## Package policy retained after storage removal

The application and inherited entitlements retain only Electron JIT requirements, app audio-input permission, and the development-only library-validation exception for ad-hoc local packaging. There is no application identifier/Keychain-group/provisioning-profile contract to satisfy. Ordinary code signing and notarization remain package-integrity concerns.

The hardened fuse contract disables RunAsNode, NODE_OPTIONS, inspector CLI arguments, external app loading, and ASAR-integrity bypass. `EnableCookieEncryption` is disabled because AIMuse has no persistent browser-secret contract. Verifiers must require that exact value rather than treating cookie encryption as a release feature.

## Current claim boundary

The 2026-08-10 arm64 Level 2 result remains a historical certificate for its exact subject only. The current local checkpoint adds clean dependency/package construction, exact installed bridge execution, device-free native protocol probes, an installed stdio-client headless lifecycle, and a later fresh package's native headless/attach/detach/reattach/quit plus ordinary interactive presentation checks. It used only ad-hoc signing, never touched Keychain, and makes no playback/recording quality, physical MIDI, Developer ID, Gatekeeper, notarization, stapling, distribution or Level 3 claim.

A future macOS acceptance must preserve the provider/storage removal and repeat the now-observed installed headless/static-client and visual presentation paths on the immutable candidate, then add named client versions, exact-envelope playback/recording/device work and the retained native DAW workflows. Level 3 remains open.
