import type { Device } from '@aimuse/core';

export type Stereo = [Float32Array, Float32Array];
export const gainFromDb = (db: number): number => 10 ** (db / 20);
export function parameter(device: Device, id: string, fallback: number): number { return device.parameters[id]?.value ?? fallback; }

/** Same low-pass coefficient/state form as native/src/dsp.cpp. */
export function lowPass(sampleRate: number, cutoff: number, q: number): (sample: number) => number {
  const omega = 2 * Math.PI * Math.min(sampleRate * 0.495, Math.max(1, cutoff)) / sampleRate;
  const cosine = Math.cos(omega); const alpha = Math.sin(omega) / (2 * Math.max(0.01, q));
  const b0 = (1 - cosine) / (2 * (1 + alpha)); const b1 = 2 * b0;
  const a1 = -2 * cosine / (1 + alpha); const a2 = (1 - alpha) / (1 + alpha);
  let z1 = 0; let z2 = 0;
  return (input) => { const output = input * b0 + z1; z1 = input * b1 + z2 - a1 * output; z2 = input * b0 - a2 * output; return output; };
}

export function processDevice(data: Stereo, device: Device, sampleRate: number): void {
  if (device.bypassed || device.builtinKind === 'analyzer' || device.builtinKind === 'subtractive-synth') return;
  if (device.builtinKind === 'utility') {
    const gain = gainFromDb(parameter(device, 'gain', 0)); const width = parameter(device, 'width', 1);
    for (let i = 0; i < data[0].length; i += 1) { const mid = (data[0][i] + data[1][i]) * 0.5; const side = (data[0][i] - data[1][i]) * 0.5 * width; data[0][i] = (mid + side) * gain; data[1][i] = (mid - side) * gain; }
  } else if (device.builtinKind === 'compressor') {
    const threshold = parameter(device, 'threshold', -18); const ratio = parameter(device, 'ratio', 4);
    const attack = Math.exp(-1 / (sampleRate * Math.max(0.00001, parameter(device, 'attack', 0.01))));
    const release = Math.exp(-1 / (sampleRate * Math.max(0.00001, parameter(device, 'release', 0.12))));
    let envelope = 0;
    for (let i = 0; i < data[0].length; i += 1) { const detector = Math.max(Math.abs(data[0][i]), Math.abs(data[1][i])); const coefficient = detector > envelope ? attack : release; envelope = coefficient * envelope + (1 - coefficient) * detector; const db = 20 * Math.log10(Math.max(envelope, 1e-12)); const gain = gainFromDb(db > threshold ? threshold + (db - threshold) / ratio - db : 0); data[0][i] *= gain; data[1][i] *= gain; }
  } else if (device.builtinKind === 'delay') {
    const delay = Math.max(1, parameter(device, 'time', 0.25) * sampleRate); const length = Math.ceil(delay) + 2;
    const feedback = parameter(device, 'feedback', 0.35); const mix = parameter(device, 'mix', 0.25);
    for (const channel of data) { const buffer = new Float32Array(length); let cursor = 0; for (let i = 0; i < channel.length; i += 1) { const position = (cursor - delay + length) % length; const first = Math.floor(position); const fraction = position - first; const delayed = buffer[first] * (1 - fraction) + buffer[(first + 1) % length] * fraction; const input = channel[i]; buffer[cursor] = Math.max(-1, Math.min(1, input + delayed * feedback)); channel[i] = input * (1 - mix) + delayed * mix; cursor = (cursor + 1) % length; } }
  }
}

/** Finite windowed-sinc interpolation with a lower cutoff for downsampling.
 * See Julius O. Smith, Windowed Sinc Interpolation (Physical Audio Signal Processing).
 * https://www.dsprelated.com/freebooks/pasp/Windowed_Sinc_Interpolation.html
 * Coefficients are cached by fractional phase; channel/sample data never is.
 */
export function sampleInterpolator(step: number): (source: Float32Array, position: number, start: number, end: number) => number {
  const cutoff = Math.min(1, 1 / step) * 0.94; const radius = Math.ceil(24 / cutoff); const phases = new Map<number, Float64Array>();
  return (source, position, start, end) => {
    if (position < start || position >= end) return 0;
    if (step === 1 && Number.isInteger(position)) return source[position] ?? 0;
    let index = Math.floor(position); const phase = Math.round((position - index) * 1024);
    if (phase === 1024) index += 1;
    const key = phase % 1024; let coefficients = phases.get(key);
    if (!coefficients) { coefficients = new Float64Array(radius * 2 + 1); let sum = 0; for (let offset = -radius; offset <= radius; offset += 1) { const distance = offset - key / 1024; const normalized = distance / radius; const sinc = Math.abs(distance) < 1e-12 ? cutoff : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance); const window = Math.abs(normalized) < 1 ? 0.42 + 0.5 * Math.cos(Math.PI * normalized) + 0.08 * Math.cos(2 * Math.PI * normalized) : 0; const value = sinc * window; coefficients[offset + radius] = value; sum += value; } for (let i = 0; i < coefficients.length; i += 1) coefficients[i] /= sum; phases.set(key, coefficients); }
    let value = 0; for (let offset = -radius; offset <= radius; offset += 1) { const sample = index + offset; if (sample >= start && sample < end) value += (source[sample] ?? 0) * coefficients[offset + radius]; } return value;
  };
}
