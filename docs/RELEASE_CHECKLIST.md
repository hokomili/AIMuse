# AIMuse release checklist

This checklist complements `FEATURE_TRACKER.md`; it cannot override an open tracker exit criterion.

## Prerelease

- [ ] Choose a SemVer prerelease and add a dated changelog entry.
- [ ] Create a fresh owner-private formal root plus disjoint Playwright output, then run the documented package-once Level 2 workflow on the target platform.
- [ ] Retain the exclusively created post-package subject manifest and prove executable/ASAR/native-helper hashes, architecture, signature, bundle, and fuses remain unchanged after verification, packaged E2E, coordinator handoff, and cleanup.
- [ ] Retain the schema-2 content-only automation observations, confirm source capture stayed within `scripts/initial-snapshot-manifest.json`, and have a caller-pinned `release-evidence-verifier.mjs` derive the result; neither producer manifest may contain an acceptance verdict.
- [ ] Complete an independent Level 2 Luna/high MCP + Computer Use report against that exact manifest-bound package.
- [ ] Run fresh registry/version checks and `npm run audit:release` for the exact dependency graph; retain signature/attestation results where supported.
- [ ] Reconcile README, tracker, parity audit, limitations, and dependency/security evidence.
- [ ] Prove the package/runtime contains no generation tool/UI/job, provider adapter/API/credential store, protected-storage addon/startup path, or automatic agent-client config writer.
- [ ] Prove installed client snippets contain only the stable AIMuse stdio launcher plus target profile and no Chromium profile switch, need one setup only, work after ordinary GUI and supported headless launch, and reconnect after stop/restart without client-config mutation, settings/token/password action, or a protected-secret backend. Verify the packaged entry derives a real link-free isolated profile and the bridge remains UI-invisible and cannot lock or mutate the engine's Electron profile.
- [ ] Force same-session notification GET clean EOF and error and prove one recovery GET on the next message; close during deferred initialize and prove the late-created remote session is DELETEd with no capacity leak.
- [ ] Prove each engine restart rotates the internal MCP bearer/instance, every TCP path is authenticated, empty/invalid authority never compares equal, blocked stop rejects blank/wrong/stale traffic on health and every MCP method, private atomic PID/instance/profile run-state has the documented POSIX/Windows boundary, and graceful cleanup removes its exact live authority.
- [x] On macOS, prove an exact installed `--headless` engine remains windowless and absent from ordinary Dock/task-switcher presentation through non-show activation, then prove one intentional show, editor detach/reattach, and terminal engine quit preserve the intended background-engine lifecycle and end with zero app/helper/native survivors.
- [ ] Build installer/portable artifacts; generate SHA-256 and license/SBOM reports.
- [ ] Verify no bearer handoff, MCP state, QA artifact, user audio, project, certificate, signing/notarization credential, or other private input is staged.

## Stable v1 gate

- [ ] Every selected-v1 P0 is Verified and every P1 has met its exit criterion; removed generation/provider/protected-storage rows are not release features and may not be restored as gates or claims.
- [ ] WASAPI/CoreAudio, recording, physical MIDI, PDC/DSP/stretch, and VST3/CLAP synthetic/native gates pass where applicable. The pending AUD-03 candidate receives its own bounded Windows build/review decision.
- [ ] Corrupt-input, codec/interchange, performance, accessibility, persistence/recovery, MCP authority, and complete packaged matrices pass.
- [ ] Independent Level 3 automation + isolated MCP + native Computer Use passes on one immutable checksummed subject whose evidence/log root is disjoint from every Playwright cleanup target.
- [ ] Installer install/uninstall and portable behavior pass on clean target systems.
- [ ] Reproducibility, production and complete build/package advisories, VST3/ASIO decisions, licenses, and SBOM are complete.
- [ ] Repository baseline/owner/remote, CI, signing status, and publication credentials are confirmed.
- [ ] For any macOS release artifact, separately prove CoreAudio endpoint/hot-plug/recording/soak behavior, release entitlements, Developer ID identity, Gatekeeper assessment, notarization, stapling, architecture policy, exact app/archive/update verification, and fresh independent bidirectional Computer Use. No Keychain/protected-storage matrix is required because the installed app has no persistent secret backend.
- [ ] Replace prerelease metadata with `1.0.0`, finalize the changelog, tag, and publish only after every previous box passes.
