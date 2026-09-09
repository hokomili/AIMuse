# First release candidate scope

Updated: 2026-09-09. Target: `0.1.0-rc.1`.

The first release candidate focuses on composing, arranging, previewing, saving and exporting music and SFX through the editor and external MCP agents. It includes the bundled GeneralUser SoundFont library, imported SF2 instruments and the documented shared preview/export renderer.

The user deferred the following three capabilities to later development on 2026-09-09. Their absence does not block this milestone. They remain on the longer-term roadmap with their actual implementation status.

| Later capability | Relevant tracker scope | RC1 behavior |
| --- | --- | --- |
| Recording | AUD-04, AUD-05; recording-dependent parts of SONG-08, FND-06, AUD-08 and AUD-13 | Arrange imported audio and authored MIDI; recording is unavailable. |
| Physical MIDI input/output | AUD-03 | MIDI file import/export and software instruments remain supported; hardware ports do not capture or play notes. |
| Third-party plug-in hosting | PLG-01–PLG-07 (hosting-dependent work); plug-in-dependent parts of AUD-08 | Use supported built-in and SoundFont instruments/effects. Stored plug-in descriptors and process shells do not establish VST3/CLAP audio processing. |

This decision does not mark a feature Verified, waive another feature's exit criterion, or certify a package. Broader live graph/DSP/stretch, codec/interchange fidelity, recovery, security, performance, accessibility and distribution gaps remain separately tracked. Existing limitations must remain explicit in public help and in the editor; a request for unsupported processing must fail clearly rather than report a successful render.

## Acceptance and publication

Use [TESTING.md](TESTING.md), [RELEASE_GATES.md](RELEASE_GATES.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the remaining requirements. Fresh independent Level 3 evidence remains required for a release candidate. The three later capabilities are explicit scope exclusions in its case matrix; negative tests for unsupported operations, permission boundaries and legacy-file compatibility still apply. Unexplained skips or failures in shipped behavior cannot be converted into exclusions.

Windows remains the primary platform. A macOS build alone is not Windows acceptance. Each published platform and architecture needs its own exact artifact, clean installation/portable checks, applicable native UI/MCP and audio checks, checksums, license/SBOM review and distribution verification. macOS distribution still requires Developer ID signing, Gatekeeper assessment, notarization and stapling under the existing release gates.

Version metadata is a preparation target, not a release verdict. Do not tag or publish RC1 until the remaining acceptance requirements are met. Historical certificates and development builds apply only to their own source and package bytes.
