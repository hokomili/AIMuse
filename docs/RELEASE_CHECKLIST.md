# AIMuse release checklist

This checklist complements `FEATURE_TRACKER.md`; it cannot override an open tracker exit criterion.

## Prerelease

- [ ] Choose a SemVer prerelease and add a dated changelog entry.
- [ ] Run `node scripts/npm-node24.mjs run test:level2:auto` on Windows 11 x64.
- [ ] Complete an independent Level 2 Luna/high MCP + Computer Use report against the same exact package.
- [ ] Reconcile README, tracker, parity audit, limitations and dependency audit.
- [ ] Build installer/portable artifacts; generate SHA-256 and license/SBOM reports.
- [ ] Verify no credentials, MCP state, provider keys, profiles, QA artifacts or user audio are staged.

## Stable v1 gate

- [ ] Every selected-v1 P0 is Verified and every P1 has met its exit criterion.
- [ ] WASAPI/recording/MIDI/PDC/DSP/stretch and VST3/CLAP synthetic/native gates pass.
- [ ] Corrupt-input, provider-mock, codec/interchange, performance, accessibility and complete packaged matrices pass.
- [ ] Independent Level 3 Luna/high automation + isolated MCP + native Computer Use passes on the exact checksummed build.
- [ ] Installer install/uninstall and portable behavior pass on a clean Windows 11 x64 VM.
- [ ] Reproducibility, production advisories, VST3/ASIO decisions, licenses and SBOM are complete.
- [ ] Repository baseline/owner/remote, CI, signing status and publication credentials are confirmed.
- [ ] For any macOS artifact, separately prove CoreAudio/device behavior, Keychain handling, hardened-runtime entitlements, signing, notarization, stapling and exact `.app`/archive verification; the structural macOS lane is not release evidence.
- [ ] Replace prerelease metadata with `1.0.0`, finalize changelog, tag and publish only after every previous box passes.
