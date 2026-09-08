import { describe, expect, it } from 'vitest';
import { createProject } from '@aimuse/core';
import { measureLoudness } from '../../src/main/loudness';
import { normalizeLoudness } from '../../src/main/loudness-normalization';
import { analyzePcm } from '../../src/main/media-manager';
import { decodeWav, type DecodedWav } from '../../src/main/wav';

function signal(channels = 2, sampleRate = 48000, seconds = 4): DecodedWav {
  const frames = Math.round(sampleRate * seconds);
  return { sampleRate, frames, channels, data: Array.from({ length: channels }, () => Float32Array.from({ length: frames }, (_, index) => 0.1 * Math.sin(2 * Math.PI * 1000 * index / sampleRate))) };
}

describe('loudness measurement and final normalization', () => {
  it.each([44100, 48000, 96000])('agrees with the independent FFmpeg 7.1 EBU R128 reference at %i Hz', sampleRate => {
    // Frozen independent measurements: 4-second 1 kHz sine at amplitude 0.1,
    // FFmpeg ebur128=peak=true reports -23.0 mono / -20.0 identical stereo.
    expect(measureLoudness(signal(1, sampleRate)).integratedLufs).toBeCloseTo(-23, 1);
    expect(measureLoudness(signal(2, sampleRate)).integratedLufs).toBeCloseTo(-20, 1);
  });

  it('counts each channel independently, including opposite polarity and left-only stereo', () => {
    const stereo = signal(); const reference = measureLoudness(stereo).integratedLufs!;
    stereo.data[1] = Float32Array.from(stereo.data[0], value => -value);
    expect(measureLoudness(stereo).integratedLufs).toBe(reference);
    const analysis = analyzePcm(stereo, 'antiphase');
    expect(analysis.integratedLufs).toBe(reference);
    expect(analysis.peakDbfs).toBeCloseTo(-20, 4);
    expect(analysis.rmsDbfs).toBeCloseTo(-23.0103, 4);
    stereo.data[1].fill(0);
    expect(measureLoudness(stereo).integratedLufs).toBe(measureLoudness(signal(1)).integratedLufs);
    stereo.data[1] = Float32Array.from(stereo.data[0], (_, i) => 0.1 * Math.cos(2 * Math.PI * 1000 * i / stereo.sampleRate));
    expect(measureLoudness(stereo).integratedLufs).toBeCloseTo(reference, 3);
  });

  it('gates quiet blocks instead of diluting the loudness with the silent tail', () => {
    const pcm = signal(); for (const channel of pcm.data) for (let i = 96000; i < pcm.frames; i++) channel[i] *= 0.001;
    // Includes partial transition blocks; independent FFmpeg reports -20.3.
    expect(measureLoudness(pcm).integratedLufs).toBeCloseTo(-20.3, 1);
  });

  it('reports sub-block padding and leaves silence/below-gate audio explicit', () => {
    const short = measureLoudness(signal(2, 48000, 0.1));
    expect(short.shortBlockPadded).toBe(true); expect(short.integratedLufs).toBeCloseTo(-26, 1);
    const silent = signal(); for (const channel of silent.data) channel.fill(0);
    const result = normalizeLoudness(silent, -14);
    expect(result.loudness.output.integratedLufs).toBeNull(); expect(result.loudness.output.samplePeak).toBe(0);
    expect(result.loudness.appliedGainDb).toBe(0);
    const quiet = signal(); for (const channel of quiet.data) for (let i = 0; i < quiet.frames; i++) channel[i] *= 1e-4;
    const low = normalizeLoudness(quiet, -14);
    expect(low.loudness.input.integratedLufs).toBeNull(); expect(low.loudness.appliedGainDb).toBe(0);
    expect(low.warnings.join(' ')).toContain('below the loudness gate');
  });

  it.each([1, 2])('hits the target with linear gain for %i channels, including antiphase', channels => {
    const pcm = signal(channels); if (channels === 2) pcm.data[1] = Float32Array.from(pcm.data[0], value => -value);
    const original = pcm.data.map(channel => channel.slice());
    const { wav, loudness, warnings } = normalizeLoudness(pcm, -14);
    expect(loudness.output.integratedLufs).toBeCloseTo(-14, 4);
    expect(loudness.peakLimited).toBe(false); expect(warnings).toEqual([]);
    const output = decodeWav(wav); const gain = 10 ** (loudness.appliedGainDb / 20);
    for (let ch = 0; ch < channels; ch++) for (const i of [5, 11, 77, 70001]) expect(output.data[ch][i]).toBeCloseTo(original[ch][i] * gain, 6);
  });

  it('reports a peak-constrained shortfall and does not distort the waveform', () => {
    const pcm = signal(); for (const channel of pcm.data) { for (let i = 0; i < pcm.frames; i++) channel[i] *= 0.01; channel[24000] = 0.95; }
    const { loudness, warnings } = normalizeLoudness(pcm, -14);
    expect(loudness.peakLimited).toBe(true);
    expect(loudness.output.samplePeak).toBeCloseTo(0.98, 6);
    expect(loudness.output.integratedLufs!).toBeLessThan(-14.05);
    expect(warnings.join(' ')).toContain('sample-peak cap'); expect(loudness.clippedSamples).toBe(0);
  });

  it('keeps final master gain, pan and mute effective and reports actual encoded levels', () => {
    const project = createProject('song'); const master = Object.values(project.tracks).find(track => track.kind === 'master')!;
    master.gainDb = -18;
    const quiet = normalizeLoudness(signal(), -14, master);
    expect(quiet.loudness.normalized.integratedLufs).toBeCloseTo(-14, 4);
    expect(quiet.loudness.output.integratedLufs).toBeCloseTo(-32, 4);
    master.gainDb = 0; master.pan = -1;
    const panned = normalizeLoudness(signal(), -14, master);
    expect(decodeWav(panned.wav).data[1].every(sample => Math.abs(sample) < 1e-8)).toBe(true);
    master.pan = 0; master.mute = true;
    const muted = normalizeLoudness(signal(), -14, master);
    expect(muted.loudness.output.integratedLufs).toBeNull(); expect(muted.loudness.output.samplePeak).toBe(0);
    master.mute = false; master.gainDb = 24;
    const clipped = normalizeLoudness(signal(), -14, master);
    expect(clipped.loudness.clippedSamples).toBeGreaterThan(0); expect(clipped.loudness.output.samplePeak).toBe(1);
    expect(clipped.warnings.join(' ')).toContain('samples were clipped');
  });

  it('refuses non-finite PCM and unknown multichannel layouts', () => {
    const invalid = signal(); invalid.data[0][4] = NaN;
    expect(() => measureLoudness(invalid)).toThrow('non-finite');
    expect(() => measureLoudness(signal(6))).toThrow('explicit channel layout');
  });
});
