# AIMuse

Agent startup: read [AGENTS.md](AGENTS.md) before repository discovery. The live [AIMuse shared context](../Secretary/shared/projects/aimuse.md) maintains current intentions, accepted decisions and work status; detailed specifications and dated evidence remain in this repository.

AIMuse is a native, agent-driven, Windows-first music and sound-design workstation. One canonical engine serves both an attachable Electron editor and authenticated external MCP clients, so a creator can work directly while an agent observes and edits the same project. AIMuse is not a built-in generative-content platform: it ships no external generation-provider adapter, provider credential store, generation job, or generation UI. External agents may create material with capabilities they control, then use AIMuse's ordinary import and editing tools.

The repository is currently **`0.1.0-alpha.0`**. It contains a working foundation and packaged cross-surface alpha; it is deliberately not labeled `1.0.0` because the complete live audio graph, recording, third-party plug-in hosting, codec, performance, and exhaustive release gates in the v1 plan are not complete. See [the feature tracker](docs/FEATURE_TRACKER.md).

## What works now

- Canonical Zod-validated project model, granular transactions, revisions, inverse operations, referential-integrity checks, idempotency, recovery journal, trace replay, checkpoints, variants, locks, and actor-scoped undo/redo.
- A one-time, no-secret stdio setup for external MCP clients backed by authenticated loopback MCP with 12 tool-first contracts (including model-callable help), owner-scoped job resources, state subscriptions, a reservation-safe 32-session cap, approval jobs, and headless/editor attachment lifecycle. Configured clients automatically follow fresh engine authority across restarts.
- Song and SFX editor surfaces with arrangement, media browser, inspector/activity/jobs/agents, lower editing dock, mixer controls, and SFX deliverable controls.
- Controlled audio/MIDI import, MIDI export, deterministic WAV/master/stem/audition rendering, SFX variation batches, DAWproject interchange reports, working folders, and ZIP64 portable packs.
- A C++20 service protocol, two-phase graph prepare/commit, deterministic DSP kernels, isolated scanner/bridge process shells, crash degradation behavior, and staged native executables.
- Pinned-miniaudio WASAPI shared playback with worker-rendered, background-prewarmed revision previews; play/pause/stop/exact seek/loop are native, ordinary edits preserve playback position, and ruler dragging scrubs continuously without blocking the Electron UI.
- Hardened packaged Electron build with an exact-build UI/MCP end-to-end test.

## Build on Windows 11 x64

Requirements:

- Node.js 24.x. `.nvmrc` is authoritative and scripts fail early on other majors.
- npm 11.x.
- Visual Studio 2022 Build Tools with Desktop development with C++ and CMake.
- Network access on the first native build, or a pre-populated CMake FetchContent cache, for the pinned miniaudio revision.

```powershell
node scripts/npm-node24.mjs ci
node scripts/npm-node24.mjs run test:level1:auto
```

The packaged app is written to the explicitly selected Forge output (`out\AIMuse-win32-x64` for ordinary development and the protected formal root for formal QA). Before Formal Level 1/2 automation, the caller publishes one schema-2 manifest binding only the tracked source allowlist plus exact Node/npm/direct native/platform tool bytes, a clean logical dependency graph, and byte inventories for the complete installed JavaScript dependency tree, npm runtime, CMake runtime, workspace package target and required platform tool support. Vite/Vitest environment-file discovery is disabled, Vite public-directory and PostCSS-config discovery are disabled, caches use the declared isolated cache root, and Forge's `.vite` staging directory must be absent before declaration and automation. The same manifest binds a clean pinned miniaudio tree copied into the protected root, isolated configuration/environment, fresh native build/dist paths and control programs. A separately pinned execution witness owns every command receipt and raw log; the package producer publishes no command or acceptance verdict. The caller-pinned automated verifier can derive only `AUTOMATED_GATES_PASS`. Level 2 adds the exact packaged Playwright regression, but only the final certifier may derive Level 2 `PASS`, and only after a distinct Luna/high task binds the complete isolated MCP, native Computer Use, bidirectional cross-surface, case-exclusive review evidence, cleanup and post-stop package evidence required by [TESTING.md](docs/TESTING.md). Level 3 additionally builds release artifacts, performance evidence, checksums and license reports.

## Prepare on macOS

The repository has an executable macOS development lane. On a macOS host, use `nvm install`, `nvm use`, `npm ci`, then `npm test` and `npm run verify:macos`; run `npm run macos:coreaudio-smoke` from a real user session for bounded shared-device soak/restart evidence, and `npm run package` for a verified local `out/AIMuse-darwin-<arch>/AIMuse.app`. The ordinary test entry point preserves the full Windows suite while routing exactly the sealed Windows-only partition away from Darwin. The exact arm64 development subject earned independent macOS Level 2 on 2026-08-10, including native Computer Use and both MCP/UI directions. This is not a release certificate: the app remains ad-hoc signed and not notarized; physical hot-plug evidence, SDK-backed plug-in hosting, compressed decode/export, x64-hardware/universal per-slice runtime, Developer ID/Gatekeeper/notarization/stapling and Level 3 remain unearned. See [macOS development](docs/MACOS_DEVELOPMENT.md) and the [macOS gate matrix](docs/MACOS_GATE_MATRIX.md).

## Lifecycle

```powershell
.\out\AIMuse-win32-x64\AIMuse.exe
.\out\AIMuse-win32-x64\AIMuse.exe --headless
.\out\AIMuse-win32-x64\AIMuse.exe --quit-engine
```

Autonomous bootstrap can additionally use repeatable `--trust-folder=C:\absolute\folder` flags and `--authority-policy=C:\absolute\policy.json`. Use **Agents → Connect an external agent** once to copy the selected client's static stdio launcher settings. Those settings contain no bearer or per-launch value and pass only the intended engine profile; they never supply Chromium `--user-data-dir`. The AIMuse entry derives a deterministic sibling, creates only its final directory, rejects link/reparse/case aliases through canonical path and filesystem identity checks, and revalidates it around `app.setPath`, so accepted state cannot share the GUI/headless profile; macOS bridge activation is prohibited before validation and an unsafe entry exits immediately. The bridge can wait for the app, privately discovers the current PID/instance-bound engine authority, recovers a failed notification stream on the next client message, and reconnects automatically after GUI or headless restarts. No client-config rewrite, settings visit, password, Keychain, DPAPI, libsecret, Electron `safeStorage`, or other persistent protected-secret backend participates. AIMuse never edits third-party client configuration. A fresh relocated arm64 development package passed a real stdio-client headless lifecycle with static configuration, simultaneous clients, long idle, death and graceful restarts, stale-use rejection, private-state checks, exact-package alias refusal and zero survivors. A later fresh package also passed native macOS presentation: `--headless` stays out of Dock/app-switcher presentation through ordinary reopen, an exact profile-bound show attaches one editor, close detaches back to background operation, reattach succeeds, and terminal quit leaves no job-owned app/helper/native process. Ordinary interactive launch still opens one foreground editor. Real playback/recording quality, changed-byte non-macOS packages and distribution acceptance remain open.

On macOS, invoke the packaged executable inside the app bundle when passing lifecycle flags:

```sh
./out/AIMuse-darwin-arm64/AIMuse.app/Contents/MacOS/AIMuse
./out/AIMuse-darwin-arm64/AIMuse.app/Contents/MacOS/AIMuse --headless
./out/AIMuse-darwin-arm64/AIMuse.app/Contents/MacOS/AIMuse --quit-engine
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [MCP interface](docs/MCP.md)
- [Authority and approvals](docs/AUTHORITY.md)
- [Feature and parity tracker](docs/FEATURE_TRACKER.md)
- [Human/agent parity audit](docs/PARITY_AUDIT.md)
- [AIDraw-style three-level testing workflow](docs/TESTING.md)
- [QA and release gates](docs/RELEASE_GATES.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Initial Git snapshot boundary](docs/INITIAL_COMMIT.md)
- [macOS development structure](docs/MACOS_DEVELOPMENT.md)
- [macOS acceptance gate matrix](docs/MACOS_GATE_MATRIX.md)
- [Security policy](SECURITY.md)
- [Third-party and licensing status](THIRD_PARTY_NOTICES.md)

### Audio rendering contract

See [supported audio rendering](docs/AUDIO_RENDERING.md) for the current synth/effect subset, WAV resampling, routing, stem/master behavior and loop checks. Public `aimuse_help` composition and operation-schemas topics provide complete authoring payloads; rendering help makes unsupported DSP explicit before export.
