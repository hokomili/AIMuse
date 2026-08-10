# QA and release gates

The release ladder mirrors the intended AIDraw discipline. [TESTING.md](TESTING.md) is the executable source of truth for independent Level 1–3 QA; this document summarizes product-specific release blockers. A green lower level does not waive a higher level.

## Smoke

Run for every packaged candidate:

```powershell
node scripts/npm-node24.mjs run test:level1:auto
```

For formal use, first create the fresh protected `test-results/luna-high/<run>` root and a disjoint `test-results/playwright/<run>` child, then set `AIMUSE_FORMAL_RUN_ROOT`, `AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR` and optionally `AIMUSE_PACKAGE_SUBJECT_MANIFEST=<formal-root>/package-subject.json`. Preserve the command's real exit with the platform-specific `pipefail`/`tee` procedure in [TESTING.md](TESTING.md). Level 1 packages exactly once and declares the manifest-bound subject only after packaging.

The packaged test launches the exact hardened `AIMuse.exe`, verifies its PID and private MCP URL, performs a UI edit observed through MCP, performs an authenticated MCP edit observed live in the UI, captures the editor, releases its MCP session, and shuts the persistent engine down through `--quit-engine`.

Current alpha automated status: passing on the development Windows 11 x64 machine as of 2026-08-04. This is not a formal Level 1 certification until a fresh independent Luna/high task also completes isolated MCP, native Computer Use, identity and bidirectional evidence.

## Regression

Before a preview build:

```powershell
node scripts/npm-node24.mjs run test:level2:auto
```

Use the same formal environment and protected logging procedure. Level 2 packages exactly once, exclusively publishes and verifies the post-package manifest, runs packaged E2E against that exact digest, then verifies all bound components again. Do not substitute standalone `npm run test:e2e`, which packages for developer use.

- Run all core schema/migration/reducer/inverse/time tests and main-process persistence, authority, journal, media, export, generation, collaboration and MCP suites.
- Run native golden/null DSP tests and the service/scanner/bridge protocol fixtures.
- Repeat packaged Song and SFX UI/MCP workflows, recovery after forced interruption, checkpoint restore, actor undo, authorization exhaustion, generation failure, missing media and degraded plug-in scenarios.
- Inspect renderer CSP, sandbox, IPC origin checks, fuses, dependencies, archive defenses and credential storage.
- Resolve or formally re-review every production dependency advisory; the current two moderate MCP/Hono transitive entries block v1 even though AIMuse does not invoke the affected static-file middleware.
- Verify keyboard-only navigation, focus visibility, accessible names, zoom and high-contrast behavior.

Current alpha status: automated core coverage is passing; the full manual/scenario matrix is incomplete.

Fresh independent macOS Level 2 run [`20260810T061608Z-macos-level2`](../test-results/luna-high/20260810T061608Z-macos-level2/report.md) is a strict `PASS` for exact subject `AE5F9D80…B7E`: one package invocation, full automation, native Computer Use, both MCP/UI directions, durable discard/recovery control, globally serialized approvals, CoreAudio, restart/reattach and cleanup passed with no finding. Report SHA-256 `3F902EDD…5E4C` and manifest SHA-256 `092D52EB…63B1` bind that result. This earns Level 2 for those exact ad-hoc arm64 development bytes only; it does not waive Level 3, release signing/notarization or any external hardware/credential-state gate.

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

`npm run verify:macos` now builds the CoreAudio/native-helper development targets in addition to the portable source/native-test lane. `npm run macos:coreaudio-smoke` is the separate real-user-session shared-device gate, and `npm run package` produces a structurally verified, fuse-hardened, validly ad-hoc-signed local `AIMuse.app`. The two-cycle packaged headless acceptance also proves authenticated MCP restart/quit and encrypted local-token reuse for one isolated profile.

The exact ad-hoc arm64 development subject now has a macOS Level 2 certificate, but not a macOS release certificate. Release remains blocked on physical endpoint/hot-plug/interruption and locked/denied/cancelled Keychain evidence, product-wide recording/MIDI, SDK plug-in hosting and compressed decode/export, a shipping architecture/runtime policy, Developer ID signing, strict release-entitlement inspection, Gatekeeper assessment, notarization, stapling, archive/update/rollback verification and Level 3 against the release candidate. Track each exit criterion in [the macOS gate matrix](MACOS_GATE_MATRIX.md). Windows and development-subject certification do not transfer to future release bytes.
