# Third-party notices and release status

Original AIMuse source in this repository is offered under the [MIT license](LICENSE). npm dependencies retain their own licenses and must be represented in the release SBOM/notices generated from the exact lockfile.

Pinned native source inputs are recorded in `native/dependency-lock.json`. The Windows native/package script fetches the exact miniaudio revision for WASAPI; plug-in SDKs and Signalsmith remain disabled until their adapters are implemented:

- CLAP — MIT.
- miniaudio — MIT No Attribution / public-domain option.
- Signalsmith Stretch — MIT.
- Steinberg VST 3 SDK — VST 3 SDK license / GPLv3 dual option. Distribution under the intended non-GPL terms requires explicit legal and release review; it is not described as MIT code.

The Steinberg ASIO SDK/bridge is not included. Any optional ASIO bridge must use the stable external boundary, be reviewed, licensed, built and distributed separately.

Hosted provider output is governed by the user's provider account, plan, API terms, model terms and declared input/output rights. AIMuse stores provenance and a user rights declaration; that metadata is not legal clearance.

`native/dependency-lock.json` remains `pinned-for-audit`. A public release must not mark it audited, ship SDK-derived binaries, or claim a complete SBOM until exact source, binary, license and notice review is complete.

## SoundFont instruments

- [SpessaSynth Core](https://github.com/spessasus/spessasynth_core), version 4.3.22, Apache-2.0. Its locked dependency [stb-vorbis](https://github.com/spessasus/stb-vorbis), version 0.0.6, is Apache-2.0 and wraps the upstream stb_vorbis decoder. Exact packages and integrity pins are in `package-lock.json`; their complete license files ship in the application SoundFont resources.
- [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS), version 2.0.3, by S. Christian Collins. The unmodified bank and complete license are in `build/soundfonts`, with upstream commit and SHA-256 pins in `manifest.json`. The author's custom license allows private/commercial music creation, use in software projects and modified packaging. It also explicitly discloses incomplete historical provenance for some contributed samples; retain that disclosure in distributed copies. This bank is not covered by AIMuse's MIT license. The bank and its license ship as separate application resources and are verified by packaging hooks.
