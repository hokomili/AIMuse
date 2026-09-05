# QA and release gates

The release ladder mirrors the intended AIDraw discipline. [TESTING.md](TESTING.md) is the executable source of truth for independent Level 1–3 QA; this document summarizes product-specific blockers. A green lower level does not waive a higher level.

## Smoke

Run for every packaged candidate:

```powershell
node scripts/npm-node24.mjs run test:level1:auto
```

Formal use requires a fresh owner-private `test-results/luna-high/<run>` root and disjoint `test-results/playwright/<run>` output. Source capture is limited to `scripts/initial-snapshot-manifest.json`. Before Level 1 automation, the caller publishes the exact schema-2 source/tool/environment/path inputs. Level 1 packages once; a separately pinned witness owns its raw execution receipts, while the producer emits content-only observations with no stage-success or acceptance verdict. The automated verifier may derive only `AUTOMATED_GATES_PASS`. Full Level 1 `PASS` additionally requires a distinct Luna/high tester's exact-subject UI↔MCP work, graceful shutdown/redaction and a successful final certification.

## Regression

Before a preview build:

```powershell
node scripts/npm-node24.mjs run test:level2:auto
```

The exact candidate must cover:

- Core schema/migration/reducer/inverse/time, persistence, authority, journal, media, export, collaboration, and all twelve MCP tools.
- One static no-secret stdio client setup across GUI/headless start and at least one stop/restart; target-only setup plus source preparation of a real link-free deterministic bridge Electron sibling with canonical/filesystem identity checks and POSIX/Windows alias rejection, prohibited macOS bridge activation, fresh internal bearer/instance rotation, stale bearer/session rejection, same-session SSE EOF/error recovery, close-vs-initialize session cleanup, committed-plus-pending 32-session reservation under parallel initialization/failure/abort/stop/DELETE races, stop-phase rejection of empty/invalid/stale authority across every TCP route while cleanup is blocked, private atomic PID/instance/profile-bound run-state with clean removal, authentication on every TCP path, and absence of any application credential store or automatic client-config write.
- Native golden/null DSP plus service/scanner/bridge protocol fixtures without overstating SDK hosting.
- Packaged Song/SFX UI↔MCP workflows, recovery/discard, checkpoints/variants, locks, actor undo, approvals, missing media, and degraded plug-ins.
- Renderer CSP/sandbox/IPC origin checks, exact hardened fuse values, dependencies, archive defenses, keyboard/focus/accessibility, and package identity.
- Explicit negative product assertions: no generation tool/job/UI, provider adapter/capability/credential surface, candidate-media route, or source-separation adapter. Legacy provenance must stay passive and old projects readable; divergent checkpoint restore plus snapshot undo/redo may not change the opened provenance map or generation-source assets.

The automated command is not a Level 2 result. The same protected run becomes Level 2 `PASS` only when a distinct Luna/high tester publishes the schema-2 certification/report for every contract case and the caller-pinned final certifier independently re-derives the automated result, validates every tester evidence digest, proves cleanup and re-verifies the unchanged package after stop.

The 2026-08-10 arm64 Level 2 result remains a strict historical result for its exact ad-hoc subject only. It does not certify this changed candidate or waive Level 3, signing/notarization, physical hardware, codec, or plug-in-hosting gates.

## Release exhaustive

Automated portion:

```powershell
node scripts/npm-node24.mjs run test:level3:auto
```

`1.0.0` remains blocked until the exact immutable candidate has evidence for:

- Real WASAPI/CoreAudio playback and recording, physical MIDI I/O, monitoring, timing, delay compensation, recovery, and deterministic/offline parity.
- Complete built-in instrument/effect and time-stretch golden/null corpus.
- Synthetic and real VST3/CLAP hosting for malformed metadata, timeout, crash, state, latency, missing plug-in, sidechain, automation, and unload.
- All MCP actions across 32 sessions, subscriptions, bounds, cancellation, locks, actor history, authority exhaustion, token rotation, long headless operation, installed-client one-time setup, start-before-engine waiting, repeated automatic bridge reconnection, same-session notification-stream failure recovery, close-race cleanup, and package-level proof that the canonically isolated/deactivated bridge never contends with or surfaces beside the engine profile.
- Interrupted persistence, traversal, malformed media, archive bomb, real ZIP64 >4 GiB, pack/unpack, trace, and recovery corpus.
- Clean-machine installer/uninstaller, exact executable identity, signed-artifact policy, license review, SBOM, and pinned performance/soak targets.

There is deliberately no provider-conformance, provider-credential, spending-budget, or protected-storage release gate. Reintroducing one would be a new product decision, not completion of this plan.

## macOS boundary

`npm run verify:macos` covers the Darwin source/native lane; `npm run macos:coreaudio-smoke` is the separate real-user shared-device gate. Package checks retain architecture, bundle, ASAR, native resources, signature structure, hardened runtime, and hardened fuses. `EnableCookieEncryption` must be false because there is no persistent browser-secret contract. App entitlements contain no Keychain group or protected-storage authority.

For distribution, Developer ID signing, Gatekeeper, notarization, stapling, archive/update/rollback, hardware/runtime architecture policy, and fresh Level 3 remain mandatory. Those are ordinary package-integrity and platform-acceptance gates; they do not restore a secret-store or provider requirement.

## Current checkpoint boundary

This checkpoint now includes a fresh lockfile-governed disposable install, ad-hoc arm64 package, immutable package verification, relocation to a versioned path with spaces, exact installed bridge execution, device-free native protocol probes and a real stdio-client headless lifecycle. The static configuration stayed byte-identical across a 65-second idle, force death and two ordinary restarts; fresh authority replaced the old bearer/session, simultaneous clients cleaned up independently, live-PID ambiguity and canonical symlink aliasing failed closed, and no run-owned process survived. A discovered malformed-entry hang was corrected so bridge activation is prohibited before validation and unsafe entries exit explicitly. The earlier device-free headless cycles used an exact-ASAR copy whose audio helper was non-executable and whose ad-hoc envelope was refreshed, so they remain non-CoreAudio evidence. A later fresh exact-envelope arm64 package corrected the ordinary-activation defect with `LSUIElement` bootstrap and a serialized activation fallback: native LaunchServices inspection stayed `BackgroundOnly`/non-frontmost through a non-show reopen; bound show attached one editor; close restored background presentation while the packaged CoreAudio helper stayed healthy; reattach succeeded; terminal quit redacted the connection and left no job-owned app/helper/native process. Ordinary interactive launch remained one foreground editor. Named installed client versions, Windows runtime for these changed bytes, playback/recording quality, signing identity, Gatekeeper, notarization, updater/distribution and Level 3 remain required.
