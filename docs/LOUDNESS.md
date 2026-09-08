# Loudness measurement and WAV normalization

WAV analysis and master/SFX export use the mono/stereo programme-loudness algorithm in [ITU-R BS.1770-5, Annex 1](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf): independent per-channel K-weighting and power summation, 400 ms blocks with 75% overlap, a -70 LUFS absolute gate and a relative gate 10 LU below the absolute-gated level. Opposite-polarity channels retain their power. The sample-rate-dependent filter parameterization reproduces the standard's 48 kHz coefficients; its derivation is also documented by [Brecht De Man's reference implementation](https://github.com/BrechtDeMan/loudness.py) and [pyloudnorm's DeMan filters](https://github.com/csteinmetz1/pyloudnorm/blob/master/pyloudnorm/iirfilter.py).

The supported project sample rates are 44.1, 48 and 96 kHz. Analysis refuses an unspecified multichannel layout instead of assuming channel weights. Waveform, pitch and tempo visualization may still use a mono signal; peak and RMS statistics use the original channels. Silent/below-gate material has `loudness.integratedLufs: null`; the old top-level analysis number retains its -120 floor for client compatibility.

For audio shorter than 400 ms, AIMuse measures a zero-padded 400 ms window and sets `shortBlockPadded: true`. Export also warns about this extension. Longer files discard incomplete trailing measurement blocks. The short-window extension is explicit and is not a separate standards-compliance claim.

## Export order and peak constraints

1. Render the authored processing with the master fader deferred.
2. Measure the unnormalized audio, calculate linear gain, and restrict that gain so the largest sample before master controls does not exceed 0.98 (about -0.18 dBFS). Re-measure after applying gain to account for gating changes. There is no post-normalization waveshaper or automatic compression.
3. Apply the authored master gain, balance/pan and mute. Those controls intentionally affect final loudness; for example, a -18 dB master fader makes a -14 LUFS normalized signal approximately -32 LUFS when it remains above the measurement gate.
4. Encode the actual final Float32 WAV and measure its encoded samples. The existing final [-1, 1] clamp remains: excessive master gain produces an explicit clipping warning and clipped-sample count. It is never silently re-normalized to undo the fader.

If the pre-master sample cap prevents reaching the requested loudness, `peakLimited` is true and a warning states the target, achieved level and constraint. The target is a goal, not a promise to distort a transient-rich signal to reach it. The cap is a **sample-peak** constraint, not a true-peak limiter; intersample peaks and authored positive master gain can exceed that level. Silent audio stays silent. Nonzero material below the absolute gate is not boosted and reports why.

Each master export result includes `loudness` with `targetLufs`, `input`, `normalized` (before master controls), `output` (actual encoded WAV), `appliedGainDb`, `samplePeakCeiling`, `peakLimited`, `clippedSamples`, `masterGainDb`, `masterPan` and `masterMuted`. Each measurement includes its method, nullable `integratedLufs`, `samplePeak`, and `shortBlockPadded`. SFX variant manifests contain the same report per file after variation/loop processing; the SFX path has no additional deferred master stage. Raw stems remain unnormalized.

## Verification scope

Focused regressions cover known mono/stereo tones, antiphase, left-only and quadrature channels, quiet-block gating, silence, short clips, peak-limited output and master controls. The independent reference for the focused correction is FFmpeg 7.1's `ebur128` filter, with native channel layout and `peak=true`. Short-clip reference checks explicitly append silence to 400 ms. Reported integrated loudness has 0.1 LU resolution; comparisons use a 0.1 LU tolerance. Actual packaged exports, their reference logs and source/package bindings are retained separately for the delivered candidate.

This implements and checks the stated mono/stereo algorithm. It is not a full meter-conformance certificate, true-peak limiter, distribution master certification or subjective listening-quality judgment.
