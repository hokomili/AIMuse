import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject, createTrack, entityBase, type AIMuseProject, type AudioClip, type BuiltinDeviceKind, type Device, type MidiClip } from '@aimuse/core';
import { renderProjectToWav, type ProjectRenderRequest } from '../../src/main/project-renderer';
import { decodeWav, encodeFloat32Wav } from '../../src/main/wav';

function fixture(): { project: AIMuseProject; clip: MidiClip } {
  const project = createProject('song'); const track = project.tracks[project.trackOrder[0]];
  const note = { ...entityBase('note'), startTick: 0, durationTicks: 960, pitch: 69, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
  const clip: MidiClip = { ...entityBase('clip'), kind: 'midi', name: 'Tone', trackId: track.id, startTick: 0, durationTicks: 1920, color: track.color, gainDb: 0, muted: false, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false, notes: { [note.id]: note }, noteOrder: [note.id], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [] };
  project.clips[clip.id] = clip; track.clipIds.push(clip.id); return { project, clip };
}
function addDevice(project: AIMuseProject, kind: BuiltinDeviceKind, values: Record<string, number> = {}): Device {
  const track = project.tracks[project.trackOrder[0]];
  const device: Device = { ...entityBase('device'), name: kind, trackId: track.id, format: 'builtin', builtinKind: kind, bypassed: false, degraded: false, latencySamples: 0, parameters: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { id, name: id, value, defaultValue: value, min: -100, max: 20000, automatable: true }])) };
  project.devices[device.id] = device; track.deviceIds.push(device.id); return device;
}
function rms(samples: Float32Array): number { return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length); }
function crossings(samples: Float32Array): number { let count = 0; for (let i = 1; i < samples.length; i += 1) if (samples[i - 1] <= 0 && samples[i] > 0) count += 1; return count; }

describe('authored audio render behavior', () => {
  let root: string; let sequence = 0;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-render-contract-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function render(project: AIMuseProject, options: Partial<ProjectRenderRequest> = {}) { const destination = join(root, `${sequence++}.wav`); const result = await renderProjectToWav({ project, destination, endTick: 1920, ...options }); return { ...result, pcm: decodeWav(await readFile(destination)) }; }
  async function wavFixture(sampleRate: number, frequency: number) {
    const { project, clip: midi } = fixture(); const track = project.tracks[project.trackOrder[0]]; const path = join(root, `${sampleRate}-${frequency}.wav`);
    const source = Float32Array.from({ length: sampleRate }, (_, index) => 0.4 * Math.sin(2 * Math.PI * frequency * index / sampleRate));
    await writeFile(path, encodeFloat32Wav([source], sampleRate));
    const asset = { ...entityBase('asset'), kind: 'audio' as const, name: 'Source.wav', mimeType: 'audio/wav', sha256: 'a'.repeat(64), byteLength: 44 + source.length * 4, storage: 'linked' as const, externalPath: path, sampleRate, channels: 1, durationSamples: source.length };
    project.assets[asset.id] = asset;
    const clip: AudioClip = { ...entityBase('clip'), name: midi.name, kind: 'audio', trackId: track.id, color: track.color, startTick: 0, durationTicks: 1920, muted: false, gainDb: 0, fadeIn: midi.fadeIn, fadeOut: midi.fadeOut, loopEnabled: false, assetId: asset.id, sourceStartSample: 0, sourceDurationSamples: source.length, transposeSemitones: 0, stretchMode: 'repitch', reverse: false, warpMarkers: [] };
    project.clips = { [clip.id]: clip }; track.clipIds = [clip.id]; return { project, clip, path };
  }
  it('honors synth attack/filter and inserts; bypass restores the guide voice', async () => {
    const { project } = fixture(); const plain = await render(project);
    const synth = addDevice(project, 'subtractive-synth', { attack: 0.4, cutoff: 100, resonance: 0 });
    const filtered = await render(project); expect(rms(filtered.pcm.data[0])).toBeLessThan(rms(plain.pcm.data[0]) * 0.1);
    synth.parameters.cutoff.value = 8000; const open = await render(project); expect(rms(open.pcm.data[0].slice(0, 4800))).toBeLessThan(rms(plain.pcm.data[0].slice(0, 4800)) * 0.4);
    synth.bypassed = true; const bypassed = await render(project); expect(bypassed.pcm.data).toEqual(plain.pcm.data);
    addDevice(project, 'utility', { gain: -18 }); const quiet = await render(project); expect(rms(quiet.pcm.data[0]) / rms(plain.pcm.data[0])).toBeCloseTo(10 ** (-18 / 20), 5);
  });
  it('applies compressor and delayed wet signal using their authored controls', async () => {
    const { project } = fixture(); const original = await render(project);
    const compressor = addDevice(project, 'compressor', { threshold: -40, ratio: 20, attack: 0.0001 });
    expect(rms((await render(project)).pcm.data[0])).toBeLessThan(rms(original.pcm.data[0]) * 0.3); compressor.bypassed = true;
    addDevice(project, 'delay', { time: 0.2, mix: 1, feedback: 0 }); const delayed = await render(project);
    expect(rms(delayed.pcm.data[0].slice(0, 9600))).toBe(0); expect(rms(delayed.pcm.data[0].slice(9600))).toBeGreaterThan(0.01);
  });
  it.each(['sampler', 'drum-rack', 'eq', 'reverb'] as const)('fails explicitly for active %s processing and writes no success WAV', async (kind) => {
    const { project } = fixture(); addDevice(project, kind); const destination = join(root, 'unsupported.wav');
    await expect(renderProjectToWav({ project, destination })).rejects.toThrow(new RegExp(`${kind}.*not supported`)); await expect(access(destination)).rejects.toThrow();
  });
  it('follows bus/master gain and mute while raw stems tap before downstream buses', async () => {
    const { project } = fixture(); const track = project.tracks[project.trackOrder[0]]; const master = project.tracks[project.trackOrder[1]]; const baseline = await render(project);
    const bus = createTrack('aux', 'Bus', '#fff'); bus.gainDb = -6; project.tracks[bus.id] = bus; project.trackOrder.splice(1, 0, bus.id); track.routing.outputTrackId = bus.id;
    master.gainDb = -12; const routed = await render(project); expect(rms(routed.pcm.data[0]) / rms(baseline.pcm.data[0])).toBeCloseTo(10 ** (-18 / 20), 5);
    const stem = await render(project, { trackIds: [track.id], stem: true }); expect(stem.pcm.data).toEqual(baseline.pcm.data);
    const busStem = await render(project, { trackIds: [bus.id], stem: true }); expect(rms(busStem.pcm.data[0]) / rms(baseline.pcm.data[0])).toBeCloseTo(10 ** (-6 / 20), 5);
    bus.mute = true; expect(rms((await render(project)).pcm.data[0])).toBe(0); bus.mute = false; track.solo = true;
    expect(rms((await render(project)).pcm.data[0])).toBeGreaterThan(0); master.mute = true; expect(rms((await render(project)).pcm.data[0])).toBe(0);
  });
  it('renders CC7 silence, pitch bend, loop repetition and clip fades', async () => {
    const { project, clip } = fixture(); const original = await render(project);
    const cc = { ...entityBase('cc'), tick: 0, controller: 7, value: 0, channel: 0 }; clip.controls[cc.id] = cc; clip.controlOrder.push(cc.id);
    expect(rms((await render(project)).pcm.data[0])).toBe(0); clip.controls = {}; clip.controlOrder = [];
    const bend = { ...entityBase('bend'), tick: 0, value: 1, channel: 0 }; clip.pitchBends[bend.id] = bend;
    expect(crossings((await render(project)).pcm.data[0])).toBeGreaterThan(crossings(original.pcm.data[0]) * 1.1);
    clip.pitchBends = {}; clip.loopEnabled = true; clip.loopLengthTicks = 960;
    expect(rms((await render(project)).pcm.data[0].slice(24000))).toBeGreaterThan(0.02);
    clip.fadeIn = { durationTicks: 1920, curve: 'linear' };
    expect(rms((await render(project)).pcm.data[0].slice(0, 4800))).toBeLessThan(rms(original.pcm.data[0].slice(0, 4800)) * 0.2);
  });
  it('resamples 48 kHz into 44.1 kHz with duration/pitch preserved and attenuates above-Nyquist energy', async () => {
    const { project } = await wavFixture(48000, 1000); project.settings.sampleRate = 44100;
    const converted = await render(project); expect(converted.durationSamples).toBe(44100); expect(converted.warnings.join(' ')).toContain('48000 Hz to 44100 Hz');
    expect(rms(converted.pcm.data[0])).toBeCloseTo(0.4 / Math.sqrt(2), 2); expect(crossings(converted.pcm.data[0])).toBeGreaterThanOrEqual(999); expect(crossings(converted.pcm.data[0])).toBeLessThanOrEqual(1001);
    const high = await wavFixture(96000, 30000); high.project.settings.sampleRate = 44100;
    const filtered = await render(high.project); expect(rms(filtered.pcm.data[0].slice(100, -100))).toBeLessThan(0.002);
  });
  it('accepts legacy unmodified stretch-tagged imports but rejects requested stretching', async () => {
    const { project, clip } = await wavFixture(48000, 440); clip.stretchMode = 'stretch'; project.settings.sampleRate = 44100;
    expect(rms((await render(project)).pcm.data[0])).toBeGreaterThan(0.1); clip.durationTicks *= 2;
    await expect(render(project)).rejects.toThrow('time stretching');
  });
  it('clips audio to the timeline, repeats/reverses source and applies fades', async () => {
    const { project, clip } = await wavFixture(48000, 1000); clip.durationTicks = 960;
    const cropped = await render(project); expect(rms(cropped.pcm.data[0].slice(24000))).toBe(0);
    clip.durationTicks = 1920; clip.sourceDurationSamples = 24000; clip.loopEnabled = true; clip.loopLengthTicks = 960;
    const looped = await render(project); expect(looped.pcm.data[0].slice(0, 24000)).toEqual(looped.pcm.data[0].slice(24000));
    clip.reverse = true; const reversed = await render(project); expect(reversed.pcm.data[0][0]).toBeCloseTo(looped.pcm.data[0][23999], 6);
    clip.fadeOut = { durationTicks: 960, curve: 'equal-power' }; const faded = await render(project); expect(faded.pcm.data[0].at(-1)).toBe(0);
  });
  it('fails on missing, malformed and out-of-range sources, but accepts intentional silence', async () => {
    const { project, clip, path } = await wavFixture(48000, 440); clip.sourceDurationSamples++;
    await expect(render(project)).rejects.toThrow('source range'); clip.sourceDurationSamples--;
    await writeFile(path, Buffer.from('invalid')); await expect(render(project)).rejects.toThrow('RIFF');
    await rm(path); await expect(render(project)).rejects.toThrow('ENOENT');
    await writeFile(path, encodeFloat32Wav([new Float32Array(48000)], 48000)); expect(rms((await render(project)).pcm.data[0])).toBe(0);
  });
  it('keeps range renders identical to full-render slices including delay state', async () => {
    const { project } = fixture(); addDevice(project, 'delay', { time: 0.2, feedback: 0.6 });
    const full = await render(project); const range = await render(project, { startTick: 960 });
    expect(range.pcm.data[0]).toEqual(full.pcm.data[0].slice(24000));
  });
});
