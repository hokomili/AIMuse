# Audio rendering contract

Updated 2026-09-06. This describes current source behavior; acceptance evidence applies only to its recorded package bytes. It does not expand the unfinished DSP roadmap.

Playback previews, audition/consolidation and WAV exports share one renderer. Preview cache names include a renderer version so a corrected package cannot reuse an old renderer's revision file. A failed refresh pauses playback and reports the current revision's error; starting playback requires a render of the current revision.

## Supported processing

- MIDI with no instrument uses a sine guide voice and reports that choice. Muse Synth provides one sine oscillator per note, attack, note-off release and a resonant low-pass filter. It is not a two-oscillator synthesizer. It must be the first active device, with at most one instrument per track.
- Utility provides gain and stereo width. Compressor uses a linked stereo peak envelope, threshold, ratio, attack and release. Delay provides time, feedback and dry/wet mix. Analyzer is observational. Device bypass skips processing.
- MIDI notes, CC7 volume, CC11 expression and pitch bend (fixed ±2 semitones) render per channel. Velocity zero and probability zero are intentional silence. Fractional probability and other CC controllers fail explicitly.
- PCM/float WAV sources at 8–192 kHz, mono/stereo, use finite windowed-sinc interpolation for sample-rate conversion and repitch. Downsampling reduces the filter cutoff to suppress aliasing. Same-rate integer sample access is direct. Source crop, reverse, timeline duration, fades and explicit clip looping are honored. New imports default to repitch. Legacy stretch-tagged clips are accepted only at natural speed without independent transposition or duration expansion; warp and time stretching fail.
- Fades use the authored linear, equal-power or S curve across the clip's timeline. `loopEnabled` requires `loopLengthTicks`; loops repeat clip-relative content within the total clip duration. Tempo conversion determines timeline and note positions.
- Track output routes form an acyclic graph to aux/master. Inserts precede static track gain and stereo-balance pan (unity at centre). Mute silences a track and its inputs. A solo admits sources whose output path contains that soloed track. Folder hierarchy alone does not route audio.

Render ranges include preroll from project origin so delay/envelope state agrees with a slice of the full render. The current renderer supports at most 30 minutes from that origin. Project mono output folds the rendered stereo signal to one channel.

## Export and failure behavior

Master export renders through inserts/buses with the master fader deferred, applies the existing approximate LUFS normalization, then applies master gain/pan/mute. Consequently master fader changes remain effective. This normalization is not a standards-compliance certificate. Raw stems are not normalized: each selected track is tapped after its inserts/fader and before downstream buses/master; an aux stem includes upstream inputs. Track selection on a master export retains downstream routing.

Sampler/drum rack, other effects, SDK plug-ins, opaque device state, nonzero latency compensation, sends, sidechains, automation, take comping and warp/time-stretch processing remain unavailable. Audio rendering fails with the affected entity and a next action when that processing contributes. Bypass/remove it or render it externally and import WAV. Muted/noncontributing descriptors do not imply an audible failure. MIDI and DAWproject can retain editable data without rendering it.

Missing, unreadable, malformed, non-finite or out-of-range sources fail audio jobs; they are never silently skipped into a completed master. Intentional silence remains a valid render. Successful rate conversion and the sine guide voice appear in `result.warnings`, retained by master, stem and SFX jobs and called out in completion messages. A failed/cancelled job may retain partial output according to the existing owner-scoped cancellation contract.

## SFX loop verification

For each variant, seeded pitch/gain/timing processing precedes loop crop and up to 10 ms cosine boundary fades. This preserves the cropped frame count, with a short gain dip around the splice. Tiny loops below four frames become their channel's constant mean. Loop start/end sample fields must be supplied together and are relative to the rendered deliverable at the project sample rate.

After normalization, the final decoded WAV must have an endpoint jump no greater than `1e-6` per channel before `seamlessLoop` is recorded true. The manifest includes the method, measured `seamJump`, threshold and actual frame count for every variant. These are objective boundary checks; listening quality, spectral continuity and embedded WAV `smpl`/cue metadata remain separate work.

Regression tests cover positive controls and explicit unsupported errors, routed/master gain and mute, pre-master stems, MIDI CC/pitch, clip fades/loops, mixed-rate duration/pitch/anti-alias behavior, source failures, range consistency, final normalized seeded loop variants and composition using only public MCP help. Independent packaged Level 2 and dependent ModelBenchmark verification remain required for a corrected package handoff.
