# macOS development and acceptance

AIMuse remains Windows-first for release certification, but macOS is now an executable development target rather than a source-transfer placeholder. The current lane builds the native runtime helpers, exercises shared CoreAudio on a real device, and creates a locally runnable `AIMuse.app`. None of that is a signed/notarized release certificate.

The literal status and remaining exit criteria live in [the macOS gate matrix](MACOS_GATE_MATRIX.md). Windows/WASAPI evidence remains separate and is never inferred from Mac results.

## Canonical bootstrap and verification

On a clean macOS clone with Xcode Command Line Tools, CMake, Git, Node 24 and npm 11 available:

```sh
nvm install
nvm use
npm ci
npm run verify:macos
```

`verify:macos` performs the following, in order:

1. checks the Darwin/arm64-or-x64/Node-24 host contract and reports Xcode, CMake and Git identities;
2. audits allowlisted initial-snapshot paths for portable names and exact-case relative imports;
3. runs TypeScript, ESLint and the macOS-safe Vitest contract;
4. configures `native/build-darwin-<arch>` with the pinned miniaudio revision and `AIMUSE_ENABLE_COREAUDIO=ON`;
5. builds and stages `aimuse-audio`, `aimuse-plugin-scanner` and `aimuse-plugin-bridge`; and
6. runs the native CTest subject.

The ordinary `npm test` entry point is platform-aware. On Darwin it excludes exactly eight sealed Windows Node-API/private-ACL/path/coordinator subjects; a regression test requires Windows to retain the unchanged full suite and Darwin to exclude only that named partition. `verify:macos` remains the narrower Darwin source/native contract, while `npm run verify` additionally exercises the ordinary suite and renderer controls.

Real device access is intentionally a separate, user-session smoke because a filesystem/process sandbox can prevent CoreAudio initialization:

```sh
npm run macos:coreaudio-smoke
```

That bounded smoke creates a quiet float32 WAV, requires a ready `coreaudio`/`shared` hello, runs a five-second callback/render soak, exercises stop→play and fresh-process restart, shuts down gracefully and requires natural code-zero exits. Native injected tests cover reroute/interruption/unexpected-stop state changes, but the smoke makes no physical hot-plug claim unless a device notification is actually observed. CoreAudio exclusive mode is not implemented and fails explicitly without retrying in shared mode.

## Development package

Generate the checked-in icon after changing its SVG source, then build and verify the local app:

```sh
npm run macos:icon
npm run package
```

The package is `out/AIMuse-darwin-<arch>/AIMuse.app`. Package verification requires AIMuse bundle identity/icon/category/microphone disclosure, hardened Electron fuses, ASAR integrity inputs, executable permissions, matching Mach-O architecture for the app and all three native helpers, and a valid signature. Without release credentials Forge applies a hardened-runtime ad-hoc development signature and development-only library-validation entitlement; with `AIMUSE_MACOS_SIGN_IDENTITY` and Apple notarization environment values it selects the stricter release entitlements and notarization path.

Native helper builds accept explicit architecture subjects, and Forge rebuilds plus validates the matching helpers for its package target:

```sh
node scripts/native-build.mjs build --arch=arm64
node scripts/native-build.mjs build --arch=x64
node scripts/native-build.mjs build --arch=universal
npm run package -- --arch=x64
```

The x64 and universal development packages have passed composition verification on Apple Silicon, including exact app/helper slices and valid ad-hoc signatures. That is not x64-hardware or per-slice runtime evidence.

Ad-hoc signing is only for local QA. A distributable artifact still requires Developer ID signing, successful Gatekeeper assessment, notarization, stapling, archive verification and independent exact-build acceptance.

### Formal package identity and evidence isolation

For independent Level 1/2 QA, do not hash a pre-existing `.app` and call it the subject before running the required automation. Set `AIMUSE_FORMAL_RUN_ROOT` to a fresh protected child below `test-results/luna-high/`, set `AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR` to a disjoint run-scoped strict child below `test-results/playwright/`, and optionally set `AIMUSE_PACKAGE_SUBJECT_MANIFEST` to `<formal-run-root>/package-subject.json`. Keep preflight, `automation.log`, the immutable manifest and `report.md` in the formal root; never place them below Playwright output. Use shell `pipefail` with `tee` so the log cannot hide the automation exit.

`test:level1:auto` and `test:level2:auto` record source/branch/index/dirty identity as inputs, package exactly once, require those inputs to stay unchanged, then exclusively publish the post-package subject. The manifest binds the app executable, `app.asar`, all three native helpers, exact architecture slices, bundle/signature identity and hardened fuses. The verifier consumes that manifest; Level 2 packaged E2E receives the same internally bound manifest digest; every component is re-hashed after verifier/E2E and again at coordinator handoff. `npm run test:e2e` is a standalone developer command that packages and must not be substituted inside a formal run. See [TESTING.md](TESTING.md) for the exact POSIX and Windows command forms.

The fresh independent Luna/high attempt at [`20260809T150538Z-macos-level2`](../test-results/luna-high/20260809T150538Z-macos-level2/report.md), HEAD `470cbe51b5633144687c06cff3bccbb85910e30a`, is `BLOCKED`, not a macOS certificate. Its automation passed, but the former packaged-Playwright default deleted the original evidence root/log and the old contract called pre-package `3066FE2D…5D3B` the subject before the intentional package phase produced `F9E4F3B4…27C7`. UI and MCP were not reached. The retained report is forensic reconstruction; the later workflow remediation and rerun below do not retroactively certify either hash.

The final local remediation run [`20260809T155318Z-formal-workflow-final`](../test-results/remediation/20260809T155318Z-formal-workflow-final/preflight.json) passed the repaired exact Level 2 automated command with a surviving owner-private evidence root and disjoint Playwright output. Its immutable arm64 subject is manifest `013E5957…2242`, identity `12807E13…5C37`, executable `41E557B9…F329`, ASAR `0FC81F76…B07B`, audio `06D744D8…0DD9`, scanner `5854936F…3A78` and bridge `A700E43B…8CFF`; handoff rehash, package verifier, E2E 2/2, exact-hash headless MCP restart, performance 1/1 and the real bounded CoreAudio probe all passed with zero final process/mount/secret-pattern matches. This is local development evidence, not Computer Use certification or release signing/notarization evidence. It warranted the independent rerun below.

The next independent attempt, [`20260809T160329Z-macos-level2`](../test-results/luna-high/20260809T160329Z-macos-level2/report.md), also correctly remains `BLOCKED`, this time solely at the tester-owned pre-MCP sandbox status gate. Automation passed 75 files plus 1 skipped / 305 tests plus 3 skipped, renderer 3/3, CTest 1/1, package verifier and E2E 2/2; its protected evidence root survived and immutable manifest `40D80CB5…7CA1` / identity `60CB06E0…5CA1` stayed stable through cleanup. The exact arm64 app was launched outside the sandbox, but the old status implementation treated process-inspection `EPERM` as `processAlive: false` and skipped health. The tester did not replace that result with an unsandboxed status call, did not initialize MCP and did not mutate product state. Read-only diagnosis found matching loopback health PID/instance/profile/URL, but that does not retroactively pass the literal status contract. Checkout bytes matched the frozen inputs through the first post-stop snapshot; coordinator-authorized implementation then changed tracked worktree contents while branch, HEAD, index, status paths, stash and untracked hashes stayed stable. The package conclusions remain bound only to the pre-remediation manifest, not the later source, and no final checkout-preservation claim follows. The later strict runs below independently passed the remediated permission-denied status contract; this historical root remains blocked.

The subsequent fresh independent run [`20260809T165936Z-macos-level2`](../test-results/luna-high/20260809T165936Z-macos-level2/report.md) proved the repaired formal and sandbox-status workflow but is a strict `FAIL` for its exact frozen subject. It passed automation, exact identity, two-actor MCP/native directions, restart and cleanup, then found that replay was still hidden-preload-only, the transient human lock could not overlap an atomic Computer Use drag, distinct Save As/move-trim-split/marker-section-lyrics checkpoints were incomplete, and DAWproject wrote a duplicate identical member name. The report remains immutable at SHA-256 `73D7D3B5E831EFE4941F15FB4206B96300D00C681386CDF29CA9BD3B937C6FE3`. Current source adds the authenticated public replay receipt, visible 15-second grace lock and separately addressable native workflows, and deduplicates archive members; local package/runtime evidence cannot upgrade the failed report. The later run below independently passed those checkpoints but failed on different findings, so neither root is a certificate.

The newest fresh independent run [`20260810T041234Z-macos-level2`](../test-results/luna-high/20260810T041234Z-macos-level2/report.md) independently passed those four remediation families, the exact package/status gates, both MCP/native directions, same-profile attach, editor reattach and cleanup, but is another strict `FAIL`. Two dirty disposable projects that returned `closed:true` under `force:true` reappeared after the same-profile restart, and three approval jobs were briefly pending before two untouched jobs were cancelled and the exports were redone serially. Cancellation and final cleanup cannot repair those historical violations. Its immutable report SHA-256 is `9AADEEC0C34849B3AFA1AEB94A9B2CCFD67E01E43E1D8F997996EAE19658B7E7`; manifest `825E590C…1A663`, subject `1E69FE63…B2758` and executable `81603982…B8A` remain bound only to that failed subject. Current source makes successful close await durable recovery removal while preserving unrelated dirty crash recovery, and globally reserves approval request preparation/publication so a second request creates no job or I/O and returns the fixed non-sensitive `approval_pending`. Local nonformal evidence for those source changes is recorded below; it does not alter the formal FAIL.

## Current boundaries

The recovery/approval remediation is locally green without claiming formal certification. Focused main-process coverage passes 5 files / 42 tests; its same-profile `ProjectService` reconstruction proves that a force-discarded dirty ID stays absent while a separate unclosed dirty control recovers unchanged. TypeScript, scoped ESLint and diff checks pass. The ordinary workflow passes 76 files plus 1 skipped / 329 tests plus 3 skipped and renderer 6/6; `verify:macos` passes portability 248 files / 290 imports, 65 files / 198 tests plus 1 skipped and CTest 1/1. Performance passes 1/1. Real CoreAudio passes 939 callbacks / 240,384 frames, 8,704 frames after transport stop→play and 8,960 after fresh-process restart, with natural exits and explicit exclusive-mode rejection; no physical device event is claimed.

The ignored arm64 package copy is `out/remediation-20260810-recovery-approval`. Its immutable nonformal manifest [`package-subject.json`](../out/formal-subjects/20260810-recovery-approval-nonformal/package-subject.json) is SHA-256 `342CE7BE5D6CE424D72E8C996ECD459D245A80886F29C88BD89E8465526FFCE9`, with subject identity `AEB0EA86FE730B910D1A30C03524CEAAEDE682BEFC554FC0D1173A3BAE52D198`, executable `60E9538868C7D68D7D6E9AEB4A6EBA4BEF8BEAACB9D90FC5A4AAB7FBC40680DC`, ASAR `887A7FF1B2B7D334AFCB3C4D5298F1C13C55929A95BF090A5A22B12EF90C8E89`, audio `A310EDBBE4B0949266230D4FE5CA4DEBDBEDA7E7BF550775B2FAB450383C5959`, scanner `A18C1A606D160B6050255DCC713A9C05F1E57A8A94E694794204850588A29B64` and bridge `EFFB95FC2A1486D20CDBF7E9FD3AB52B299F149925111E4B4D001DEB9EC54349`. Package verification, manifest-bound packaged E2E 2/2 and post-E2E verification pass; the E2E case proves approval-overlap rejection, no second job, cancellation and retry. The exact-manifest two-cycle [headless report](../test-results/remediation/20260810-recovery-approval-headless/report.md), SHA-256 `F8D1DD3EB947887C03BB6076D8C1613C48877D30FFB24521DCED7C4D5DE9C971`, and summary SHA-256 `3119196DDAE51DBA8357CB43D83AF42FF13E06CE698B0E5E3010D4DBA89A83B8` retain the profile while changing PID/instance and end gracefully with no survivor, credential, provider file or force termination. The generic headless harness does not perform the discard/control project case, so that evidence remains focused-service-only and fresh independent exact-build Computer Use certification is still required.

- Shared CoreAudio playback, bounded soak and clean restart are locally exercised. Physical endpoint selection/hot-plug/interruption, callback xrun/CPU telemetry and long device soak require separate hardware evidence. Exclusive mode is an explicit non-feature. Recording and physical MIDI are product-wide unimplemented, not Mac-only parity gaps.
- Native audio/scanner/bridge arm64 runtime/package plus x64 and universal compile/package composition pass. x64-hardware and universal per-slice runtime remain unclaimed.
- macOS VST3 and CLAP system/user roots and `Contents/MacOS` bundle executables are recognized and a harmless fixture passes through the real scanner. The host had no VST3/CLAP installed; the six system AU components are excluded because AU is unsupported product-wide. Scanner/bridge still declare `sdkAdaptersReady: false`, so no real SDK load/process claim exists.
- A packaged three-cycle provider test exercises the real renderer setter, `safeStorage` persistence, rotation/removal, owner-only credential roots/files and full-profile plaintext scanning with synthetic values. Injected locked/denied failures are fail-closed, but real Keychain lock/deny/cancel/prompt behavior still requires a disposable external credential environment.
- The QA coordinator now creates profile, connection-parent, manifest-parent and trusted-folder directories with owner-only `0700` mode on POSIX. Its follow-up lease checks still fail closed if permissions drift; Windows ACL behavior is unchanged.
- A local editor package can be built with AIMuse identity/icon and a macOS-only engine-quit confirmation. The newest independent run proves the repaired output/subject and sandbox-`EPERM` status contracts through two process generations; its overall result remains `FAIL` for the later recovery and approval findings. Fresh independent Computer Use in both directions remains mandatory for changed bytes.
- A dirty `force:false` close remains the exact non-mutating unsaved refusal. Every successful close, including a dirty `force:true` discard, now awaits durable recovery removal; failure rejects and leaves the project open. Fresh certification must prove the discarded ID absent after same-profile restart while a separate unclosed dirty control recovers unchanged.
- Approval-capable requests share one global preparation/publication reservation. A concurrent MCP request creates no job or protected I/O and returns only the fixed retryable `approval_pending` response without incumbent details. Formal export coverage is stricter: resolve and wait each job terminal, prove native/global pending zero, then submit the next.
- WAV/MIDI and existing DAWproject tests are platform-neutral. Real AudioToolbox AAC/M4A metadata admission passes locally, but compressed-media decode/render and FLAC/MP3 export remain product-wide gaps, not Mac-specific passes.
- `.github/workflows/macos-structure.yml` declares the source/native lane on `macos-14`, but no hosted result exists yet.
