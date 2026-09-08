# SoundFont instruments

Updated 2026-09-08. Required before the first release candidate by the user's decision in the AIMuse manager task. The benchmark's locked package is a separate subject.

## Playing instruments

New instrument tracks use SoundFont with Grand Piano. In Instruments, add SoundFont to a selected track; this bypasses an existing instrument and inserts the new instrument before effects, in one undoable edit. In the Inspector choose a library, search presets and select a sound. GeneralUser GS 2.0.3 ships with the application: 287 presets, including 13 drum kits, with piano, electric piano, guitars, basses, orchestral instruments, synths and percussion. No system synthesizer, FFmpeg, sibling creation, runtime download or provider account is needed.

Use Media → Import to add an SF2 bank (maximum 256 MiB). Import validates the RIFF bank and records its preset catalog; select the imported library from the Inspector afterwards. Import alone does not change a track's instrument. Imported banks are managed assets: Save embeds them by content hash; Save As and portable packs carry them. Preset edits participate in attributed transactions, revisions, undo/redo and recovery. A referenced bank cannot be deleted until its devices have been changed/deleted. Rendering verifies bank bytes against the stored hash. Missing/changed/invalid banks and unavailable presets fail explicitly.

## Public agent contract

`aimuse_help` topic `instruments` returns the complete bundled catalog and guidance. `device.add` accepts `format: "builtin"`, `builtinKind: "soundfont"`, `parameters: {}` and a required `soundfont` object, in addition to ordinary device/entity fields. Use `device.update` with `changes.soundfont` to switch programs. Example settings:

```json
{"source":"generaluser-gs-2.0.3","bank":0,"program":48}
```

This selects strings. For imported media use `{"source":"asset","assetId":"<observed SF2 asset ID>","bank":0,"program":0}`. `media_manage` import accepts `.sf2`; `project_observe` returns `asset.soundfontPresets`. `plugin_manage` set-preset also resolves an unambiguous preset name within the selected library; it rejects unavailable/ambiguous names. Bank and program are zero-based. Bank 128 selects drums on any note channel. There must be one active instrument, before effects. An optional `gain` parameter covers −48 to +12 dB. The human UI and agent operations use this same persisted model.

## Audio contract

Playback previews, audition, consolidation and WAV master/stem rendering use the same pinned SpessaSynth Core 4.3.22 sample engine. It renders polyphonic voices with SoundFont sample zones, velocity response, tuning, looping, envelopes, filters and modulation. MIDI note timing follows project tempo; normalized velocities map to MIDI 1–127 (zero is silent). CC1 modulation, CC7 volume, CC10 pan, CC11 expression, CC64 sustain and fixed ±2-semitone pitch bend are supported per channel. Note-off uses the bank's release; per-note release velocity is stored but the engine's note-off API does not use it. Internal reverb/chorus/delay are disabled; an AIMuse Delay insert remains available. Fractional probability and other MIDI controllers fail explicitly.

Each clip supports up to 4096 simultaneous sample voices; denser content fails explicitly. Each clip owns its voices and controller state; loops restart that state. Clip gain/fades and track/bus/master routing apply normally. Release tails are clipped at the clip/loop boundary: leave room after the last note inside the clip for decay. Rendering a range includes preroll and agrees with the corresponding full render. Existing Muse Synth and instrument-free guide projects retain their previous sound. MIDI imports add the GM program (and percussion bank) captured by the importer; mid-track program changes and arbitrary GS/XG state are not represented by the current project model. MIDI/DAWproject interchange does not preserve custom SoundFont audio; WAV stems preserve rendered timbre.

This does not implement the separate generic WAV Sampler or editable Drum Rack, native live MIDI performance, other unfinished effects or VST3/CLAP hosting. Local implementation checks are not formal release certification.

## Packaging and provenance

`build/soundfonts/manifest.json` pins the upstream revision, original bank bytes and complete author license. Forge copies these resources on macOS and Windows and checks hashes before and after copying. `src/common/soundfont-presets.json` is extracted from the exact bank; a regression check compares the complete catalog. `THIRD_PARTY_NOTICES.md` records the bank's custom license and original sample-provenance disclosure. A future bank update needs a new ID/hash, catalog and renderer cache version; do not replace an existing bank identity with different bytes.
