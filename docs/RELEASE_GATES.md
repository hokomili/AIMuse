# QA and release gates

The release ladder mirrors the intended AIDraw discipline. [TESTING.md](TESTING.md) is the executable source of truth for independent Level 1–3 QA; this document summarizes product-specific release blockers. A green lower level does not waive a higher level.

## Smoke

Run for every packaged candidate:

```powershell
node scripts/npm-node24.mjs run test:level1:auto
```

The packaged test launches the exact hardened `AIMuse.exe`, verifies its PID and private MCP URL, performs a UI edit observed through MCP, performs an authenticated MCP edit observed live in the UI, captures the editor, releases its MCP session, and shuts the persistent engine down through `--quit-engine`.

Current alpha automated status: passing on the development Windows 11 x64 machine as of 2026-08-04. This is not a formal Level 1 certification until a fresh independent Luna/high task also completes isolated MCP, native Computer Use, identity and bidirectional evidence.

## Regression

Before a preview build:

```powershell
node scripts/npm-node24.mjs run test:level2:auto
```

- Run all core schema/migration/reducer/inverse/time tests and main-process persistence, authority, journal, media, export, generation, collaboration and MCP suites.
- Run native golden/null DSP tests and the service/scanner/bridge protocol fixtures.
- Repeat packaged Song and SFX UI/MCP workflows, recovery after forced interruption, checkpoint restore, actor undo, authorization exhaustion, generation failure, missing media and degraded plug-in scenarios.
- Inspect renderer CSP, sandbox, IPC origin checks, fuses, dependencies, archive defenses and credential storage.
- Resolve or formally re-review every production dependency advisory; the current two moderate MCP/Hono transitive entries block v1 even though AIMuse does not invoke the affected static-file middleware.
- Verify keyboard-only navigation, focus visibility, accessible names, zoom and high-contrast behavior.

Current alpha status: automated core coverage is passing; the full manual/scenario matrix is incomplete.

## Release Exhaustive

Automated portion:

```powershell
node scripts/npm-node24.mjs run test:level3:auto
```

`1.0.0` is blocked until all of the following have exact-build evidence:

- Real WASAPI shared/exclusive playback and recording, physical MIDI I/O, monitoring, timing, delay compensation, recovery and deterministic/offline parity.
- Complete built-in instrument/effect and time-stretch golden/null corpus.
- Synthetic VST3/CLAP matrix for malformed metadata, timeout, crash, state, latency, missing plug-in, sidechain and automation.
- All MCP actions across 32 sessions, subscriptions, bounds, cancellation, locks, actor history, authority exhaustion and long headless operation.
- Credentialed provider conformance plus mock moderation, rates, timeouts, cancellation, capability drift, cost ambiguity and no retry/substitution.
- Interrupted persistence, traversal, malformed media, archive bomb, real ZIP64 >4 GiB, pack/unpack and trace recovery corpus.
- Clean Windows 11 machine installer/uninstaller, exact executable identity, signed-artifact policy, license review and SBOM.
- Pinned reference-machine performance: the specified 48 kHz/256-sample callback load for ten minutes without xruns, interactive 200-track/10,000-clip editing, and an eight-hour/20,000-transaction autonomous soak with no lost commits.

No release script changes the package to `1.0.0`; version promotion is a separate reviewed change after this document and the feature tracker have no open v1 gate.

## macOS boundary

`npm run verify:macos` is a source/native-test structural gate only. It intentionally disables runtime audio and plug-in helper binaries and cannot package. A macOS release gate does not exist until CoreAudio, Keychain, native lifecycle/UI, signing, entitlements, notarization and exact package verification have independent evidence. Windows certification does not transfer to macOS bytes.
