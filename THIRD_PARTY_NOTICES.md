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
