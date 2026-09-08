import type { DecodedWav } from './wav';

export const LOUDNESS_METHOD = 'ITU-R BS.1770-5 mono/stereo' as const;
export interface LoudnessMeasurement {
  method: typeof LOUDNESS_METHOD;
  integratedLufs: number | null;
  samplePeak: number;
  shortBlockPadded: boolean;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; z1: number; z2: number }

function filter(c: Biquad, input: number): number {
  const output = c.b0 * input + c.z1;
  c.z1 = c.b1 * input - c.a1 * output + c.z2;
  c.z2 = c.b2 * input - c.a2 * output;
  return output;
}

function weighting(sampleRate: number): [Biquad, Biquad] {
  // Bilinear K-weighting parameterization matching BS.1770's 48 kHz tables;
  // see docs/LOUDNESS.md for the standard and the De Man parameter derivation.
  const k = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
  const q = 0.7071752369554196;
  const high = 10 ** (3.999843853973347 / 20);
  const middle = high ** 0.4996667741545416;
  const denominator = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (high + middle * k / q + k * k) / denominator,
    b1: 2 * (k * k - high) / denominator,
    b2: (high - middle * k / q + k * k) / denominator,
    a1: 2 * (k * k - 1) / denominator, a2: (1 - k / q + k * k) / denominator, z1: 0, z2: 0,
  };
  const h = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
  const d = 1 + h / 0.5003270373238773 + h * h;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: 2 * (h * h - 1) / d, a2: (1 - h / 0.5003270373238773 + h * h) / d, z1: 0, z2: 0 };
  return [shelf, highpass];
}

/** Independent channel filtering/power, 400 ms blocks, 75% overlap, -70/-10 LU gates. */
export function measureLoudness(decoded: DecodedWav): LoudnessMeasurement {
  const { channels, frames, sampleRate, data } = decoded;
  if (![1, 2].includes(channels) || data.length !== channels) throw new Error('Loudness measurement supports mono/stereo WAV only; multichannel audio requires an explicit channel layout.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !Number.isInteger(frames) || frames < 0 || data.some(channel => channel.length !== frames)) throw new Error('Invalid PCM dimensions for loudness measurement.');
  const blockFrames = Math.round(sampleRate * 0.4);
  const hopFrames = Math.round(sampleRate * 0.1);
  const states = data.map(() => weighting(sampleRate));
  const ring = new Float64Array(blockFrames);
  const powers: number[] = [];
  let energy = 0; let samplePeak = 0;
  // Sub-400 ms SFX use an explicitly reported zero-padded measurement window.
  // Normal-length material discards incomplete trailing blocks per the standard.
  for (let frame = 0; frame < Math.max(frames, blockFrames); frame++) {
    let power = 0;
    for (let channel = 0; channel < channels; channel++) {
      const sample = frame < frames ? data[channel][frame] : 0;
      if (!Number.isFinite(sample)) throw new Error('Loudness measurement encountered non-finite PCM.');
      samplePeak = Math.max(samplePeak, Math.abs(sample));
      const [shelf, highpass] = states[channel];
      const weighted = filter(highpass, filter(shelf, sample));
      power += weighted * weighted;
    }
    const index = frame % blockFrames;
    energy += power - ring[index]; ring[index] = power;
    if (frame + 1 >= blockFrames && (frame + 1 - blockFrames) % hopFrames === 0) powers.push(Math.max(0, energy / blockFrames));
  }
  const absoluteGate = 10 ** ((-70 + 0.691) / 10);
  const absolute = powers.filter(power => power > absoluteGate);
  let integratedLufs: number | null = null;
  if (absolute.length) {
    const relativeGate = absolute.reduce((sum, power) => sum + power, 0) / absolute.length / 10;
    const gated = absolute.filter(power => power > relativeGate);
    if (gated.length) integratedLufs = -0.691 + 10 * Math.log10(gated.reduce((sum, power) => sum + power, 0) / gated.length);
  }
  return { method: LOUDNESS_METHOD, integratedLufs, samplePeak, shortBlockPadded: frames < blockFrames };
}
