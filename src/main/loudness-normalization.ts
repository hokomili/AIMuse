import type { AIMuseProject } from '@aimuse/core';
import { applyTrackFader } from './project-renderer';
import { measureLoudness, type LoudnessMeasurement } from './loudness';
import { decodeWav, encodeFloat32Wav, type DecodedWav } from './wav';

export interface LoudnessNormalization {
  targetLufs: number;
  input: LoudnessMeasurement;
  normalized: LoudnessMeasurement;
  output: LoudnessMeasurement;
  appliedGainDb: number;
  peakLimited: boolean;
  samplePeakCeiling: number;
  clippedSamples: number;
  masterGainDb: number;
  masterPan: number;
  masterMuted: boolean;
}

export function normalizeLoudness(decoded: DecodedWav, targetLufs: number, master?: AIMuseProject['tracks'][string]): { wav: Buffer; loudness: LoudnessNormalization; warnings: string[] } {
  if (!Number.isFinite(targetLufs)) throw new Error('Loudness target must be finite.');
  const input = measureLoudness(decoded);
  const ceiling = 0.98;
  const maximumGain = input.samplePeak > 0 ? ceiling / input.samplePeak : 1;
  let gain = input.integratedLufs === null ? Math.min(1, maximumGain) : Math.min(10 ** ((targetLufs - input.integratedLufs) / 20), maximumGain);
  const original = decoded.data;
  let normalized: LoudnessMeasurement;
  // Re-evaluate gates after gain changes rather than assuming that all blocks
  // admitted by the input's absolute gate will remain the same at the target.
  for (let iteration = 0; ; iteration++) {
    decoded.data = original.map(channel => Float32Array.from(channel, sample => sample * gain));
    normalized = measureLoudness(decoded);
    if (input.integratedLufs === null || normalized.integratedLufs === null || Math.abs(targetLufs - normalized.integratedLufs) < 0.01 || iteration === 3) break;
    const nextGain = Math.min(gain * 10 ** ((targetLufs - normalized.integratedLufs) / 20), maximumGain);
    if (Math.abs(nextGain - gain) < 1e-12) break;
    gain = nextGain;
  }
  const peakLimited = normalized.integratedLufs !== null && normalized.integratedLufs < targetLufs - 0.05 && gain >= maximumGain * (1 - 1e-7);
  if (master) {
    const stereo: [Float32Array, Float32Array] = [decoded.data[0], decoded.data[1] ?? decoded.data[0].slice()];
    applyTrackFader(stereo, master);
    decoded.data = decoded.channels === 1 ? [stereo[0].map((sample, index) => (sample + stereo[1][index]) * 0.5)] : stereo;
  }
  let clippedSamples = 0;
  for (const channel of decoded.data) for (const sample of channel) if (Math.abs(sample) > 1) clippedSamples++;
  // Preserve the existing output clamp after authored master controls, and
  // measure the actual encoded samples so neither clipping nor controls hide.
  const wav = encodeFloat32Wav(decoded.data, decoded.sampleRate);
  const output = measureLoudness(decodeWav(wav));
  const loudness: LoudnessNormalization = { targetLufs, input, normalized, output, appliedGainDb: 20 * Math.log10(gain), peakLimited, samplePeakCeiling: ceiling, clippedSamples, masterGainDb: master?.gainDb ?? 0, masterPan: master?.pan ?? 0, masterMuted: master?.mute ?? false };
  const warnings: string[] = [];
  if (input.shortBlockPadded) warnings.push('Loudness for audio shorter than 400 ms uses a zero-padded 400 ms measurement window.');
  if (input.integratedLufs === null && input.samplePeak > 0) warnings.push('Audio is below the loudness gate; no loudness boost was applied.');
  if (peakLimited) warnings.push(`Loudness target ${targetLufs.toFixed(2)} LUFS was constrained by the 0.98 sample-peak cap; achieved ${normalized.integratedLufs!.toFixed(2)} LUFS before master controls. This is not a true-peak limiter.`);
  if (normalized.integratedLufs !== null && !peakLimited && Math.abs(normalized.integratedLufs - targetLufs) > 0.05) warnings.push(`Loudness after normalization is ${normalized.integratedLufs.toFixed(2)} LUFS; requested ${targetLufs.toFixed(2)} LUFS. See the measured output report.`);
  if (clippedSamples) warnings.push(`Master controls exceeded 0 dBFS: ${clippedSamples} samples were clipped in the final WAV. Reduce master gain to avoid clipping.`);
  return { wav, loudness, warnings };
}
