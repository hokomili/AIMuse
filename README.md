# AIMuse

AIMuse is an agent-native, Windows-first music and sound-design studio. One canonical engine serves both an attachable Electron editor and authenticated external MCP clients, so a creator can work directly while an agent observes and edits the same project.

The repository is currently **`0.1.0-alpha.0`**. It contains a working foundation and packaged cross-surface alpha; it is deliberately not labeled `1.0.0` because the complete live audio graph, recording, third-party plug-in hosting, codec, performance, and exhaustive release gates in the v1 plan are not complete. See [the feature tracker](docs/FEATURE_TRACKER.md).

## What works now

- Canonical Zod-validated project model, granular transactions, revisions, inverse operations, referential-integrity checks, idempotency, recovery journal, trace replay, checkpoints, variants, locks, and actor-scoped undo/redo.
- Authenticated loopback MCP with 12 tool-first contracts (including model-callable help), owner-scoped job resources, state subscriptions, a 32-session cap, approval jobs, and headless/editor attachment lifecycle.
- Song and SFX editor surfaces with arrangement, browser, inspector/activity/jobs/agents, lower editing dock, mixer controls, generation candidates, and SFX deliverable controls.
- Controlled audio/MIDI import, MIDI export, deterministic WAV/master/stem/audition rendering, SFX variation batches, DAWproject interchange reports, working folders, and ZIP64 portable packs.
- Provider-neutral ElevenLabs, Stability, and opt-in experimental Lyria adapters with immutable candidates, provenance, charge ambiguity handling, and no silent retry or provider substitution.
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

The packaged app is written to `out\AIMuse-win32-x64`. Level 2 adds the exact packaged Playwright regression; Level 3 builds release artifacts, performance evidence, checksums and license reports. Each command is only the automated portion: formal AIDraw-style certification also requires a fresh independent Luna/high task, isolated MCP, native Computer Use and both cross-surface directions as defined in [TESTING.md](docs/TESTING.md).

## Prepare on macOS

The repository has an executable macOS development lane. On a macOS host, use `nvm install`, `nvm use`, `npm ci`, then `npm test` and `npm run verify:macos`; run `npm run macos:coreaudio-smoke` from a real user session for bounded shared-device soak/restart evidence, and `npm run package` for a verified local `out/AIMuse-darwin-<arch>/AIMuse.app`. The ordinary test entry point preserves the full Windows suite while routing exactly the sealed Windows-only partition away from Darwin. Local arm64 runtime/package, x64 and universal package composition, provider-Keychain setter persistence with synthetic values, AAC/M4A metadata admission and Mac plug-in bundle discovery have development evidence. The app remains ad-hoc signed and not notarized; physical hot-plug/Keychain-denial evidence, SDK-backed plug-in hosting, compressed decode/export, x64-hardware/universal per-slice runtime and formal fresh-task Computer Use remain unearned. See [macOS development](docs/MACOS_DEVELOPMENT.md) and the [macOS gate matrix](docs/MACOS_GATE_MATRIX.md).

## Lifecycle

```powershell
.\out\AIMuse-win32-x64\AIMuse.exe
.\out\AIMuse-win32-x64\AIMuse.exe --headless --write-mcp-connection=C:\private\aimuse-mcp.json
.\out\AIMuse-win32-x64\AIMuse.exe --quit-engine
```

Autonomous bootstrap can additionally use repeatable `--trust-folder=C:\absolute\folder` flags and `--authority-policy=C:\absolute\policy.json`. The connection file contains a bearer token: create its parent with an owner-only operating-system ACL before launch, re-read the handoff after every restart, and redact or remove it when the controller is done. Node's `0o600` mode alone is not a Windows ACL boundary. Closing the editor leaves the engine alive by design. `--quit-engine` shuts down both surfaces cleanly.

On macOS, invoke the packaged executable inside the app bundle when passing lifecycle flags:

```sh
./out/AIMuse-darwin-arm64/AIMuse.app/Contents/MacOS/AIMuse
./out/AIMuse-darwin-arm64/AIMuse.app/Contents/MacOS/AIMuse --headless --write-mcp-connection=/absolute/owner-private/aimuse-mcp.json
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
