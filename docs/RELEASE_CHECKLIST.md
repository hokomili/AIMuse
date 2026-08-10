# AIMuse release checklist

This checklist complements `FEATURE_TRACKER.md`; it cannot override an open tracker exit criterion.

## Prerelease

- [ ] Choose a SemVer prerelease and add a dated changelog entry.
- [ ] Create a fresh owner-private formal root and disjoint run-scoped Playwright output, then run `node scripts/npm-node24.mjs run test:level2:auto` once on Windows 11 x64 with the documented `AIMUSE_FORMAL_RUN_ROOT`, `AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR`, optional subject-manifest path and exit-preserving `tee` procedure.
- [ ] Retain the exclusively created post-package subject manifest and prove its executable/ASAR/helper hashes, architecture/signature/bundle/fuses remain unchanged after verifier, packaged E2E, coordinator handoff and cleanup; do not rebuild after declaration.
- [ ] Complete an independent Level 2 Luna/high MCP + Computer Use report against that exact manifest-bound package.
- [ ] Reconcile README, tracker, parity audit, limitations and dependency audit.
- [ ] Build installer/portable artifacts; generate SHA-256 and license/SBOM reports.
- [ ] Verify no credentials, MCP state, provider keys, profiles, QA artifacts or user audio are staged.

## Stable v1 gate

- [ ] Every selected-v1 P0 is Verified and every P1 has met its exit criterion.
- [ ] WASAPI/recording/MIDI/PDC/DSP/stretch and VST3/CLAP synthetic/native gates pass.
- [ ] Corrupt-input, provider-mock, codec/interchange, performance, accessibility and complete packaged matrices pass.
- [ ] Independent Level 3 Luna/high automation + isolated MCP + native Computer Use passes on one immutable checksummed subject whose evidence/log root is disjoint from every Playwright cleanup target.
- [ ] Installer install/uninstall and portable behavior pass on a clean Windows 11 x64 VM.
- [ ] Reproducibility, production advisories, VST3/ASIO decisions, licenses and SBOM are complete.
- [ ] Repository baseline/owner/remote, CI, signing status and publication credentials are confirmed.
- [ ] For any macOS artifact, separately prove CoreAudio endpoint/hot-plug/recording/soak behavior, provider-Keychain and locked-state handling, release entitlements, Developer ID identity, Gatekeeper assessment, notarization, stapling, architecture policy, exact `.app`/archive/update verification and fresh independent bidirectional Computer Use; local shared-device/ad-hoc-package/headless development evidence is not release certification.
- [ ] Replace prerelease metadata with `1.0.0`, finalize changelog, tag and publish only after every previous box passes.
