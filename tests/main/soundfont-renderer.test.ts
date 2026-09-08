import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject, entityBase, type MidiClip, type Device, type ProjectOperation, applyProjectTransaction, validateProjectIntegrity } from '@aimuse/core';
import { BUNDLED_SOUNDFONT, DEFAULT_SOUNDFONT } from '../../src/common/soundfont-library';
import { bundledSoundFontPath, parseSoundFont, soundFontPresets } from '../../src/main/soundfont-bank';
import { renderProjectToWav } from '../../src/main/project-renderer';
import { decodeWav } from '../../src/main/wav';

function fixture(program = 0, bank = 0) {
  const project = createProject('song'); const track = project.tracks[project.trackOrder[0]];
  const note = { ...entityBase('note'), startTick: 0, durationTicks: 480, pitch: bank === 128 ? 38 : 60, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
  const clip: MidiClip = { ...entityBase('clip'), kind: 'midi', name: 'Sampled phrase', trackId: track.id, startTick: 0, durationTicks: 1920, color: track.color, gainDb: 0, muted: false, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false, notes: { [note.id]: note }, noteOrder: [note.id], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [] };
  const device: Device = { ...entityBase('device'), name: 'SoundFont', trackId: track.id, format: 'builtin', builtinKind: 'soundfont', bypassed: false, degraded: false, latencySamples: 0, parameters: {}, soundfont: { ...DEFAULT_SOUNDFONT, bank, program } };
  project.devices[device.id] = device; track.deviceIds.push(device.id); project.clips[clip.id] = clip; track.clipIds.push(clip.id);
  return { project, clip, note, device, track };
}
const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);

describe('SoundFont rendering', () => {
  let root: string; let sequence = 0;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-soundfont-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function render(project: ReturnType<typeof fixture>['project'], startTick = 0, endTick = 1920) {
    const destination = join(root, `${sequence++}.wav`);
    await renderProjectToWav({ project, destination, startTick, endTick });
    return decodeWav(await readFile(destination));
  }
  it('ships the documented preset catalog and resolves the same asset in main and worker package layouts', async () => {
    const bank = parseSoundFont(await readFile(bundledSoundFontPath()));
    expect(soundFontPresets(bank)).toEqual([...BUNDLED_SOUNDFONT.presets].sort((a, b) => a.bank - b.bank || a.program - b.program));
    expect(bank.presets).toHaveLength(287);
    expect(bundledSoundFontPath('/tmp/AIMuse.app/Contents/Resources/app.asar/.vite/build')).toBe('/tmp/AIMuse.app/Contents/Resources/soundfonts/GeneralUser-GS.sf2');
    expect(bundledSoundFontPath(resolve('.vite/build'))).toBe(resolve('build/soundfonts/GeneralUser-GS.sf2'));
  });
  it('renders distinct repeatable piano, strings, bass and percussion with finite stereo PCM', async () => {
    const signals: Float32Array[] = [];
    for (const [program, bank] of [[0, 0], [48, 0], [33, 0], [0, 128], [0, 11], [0, 120]]) {
      const { project } = fixture(program, bank); const first = await render(project);
      expect(first.frames).toBe(48000); expect(first.channels).toBe(2);
      expect(first.data.every((channel) => channel.every(Number.isFinite))).toBe(true);
      expect(rms(first.data[0])).toBeGreaterThan(0.0001);
      expect((await render(project)).data).toEqual(first.data);
      signals.push(first.data[0]);
    }
    for (let i = 1; i < signals.length; i += 1) expect(signals[i]).not.toEqual(signals[0]);
  });
  it('honors velocity, per-channel volume/pan and sustain while keeping note channel 10 melodic when selected', async () => {
    const { project, clip, note } = fixture(); const loud = await render(project);
    note.velocity = 0.25; expect(rms((await render(project)).data[0])).toBeLessThan(rms(loud.data[0]) * 0.5); note.velocity = 0.8;
    note.channel = 9; expect((await render(project)).data).toEqual(loud.data); note.channel = 0;
    const cc = { ...entityBase('cc'), tick: 0, controller: 7, value: 0, channel: 0 }; clip.controls[cc.id] = cc; clip.controlOrder.push(cc.id);
    expect(rms((await render(project)).data[0])).toBeLessThan(1e-6);
    cc.controller = 10; const left = await render(project); expect(rms(left.data[1])).toBeLessThan(rms(left.data[0]) * 0.01);
    cc.controller = 64; cc.value = 1; const sustained = await render(project);
    expect(rms(sustained.data[0].slice(30000))).toBeGreaterThan(rms(loud.data[0].slice(30000)) * 2);
  });
  it('preserves preroll, restarts loops, and applies clip gain/fades and track routing', async () => {
    const { project, clip, track } = fixture();
    clip.loopEnabled = true; clip.loopLengthTicks = 960;
    const full = await render(project); expect(full.data[0].slice(0, 24000).every((sample, i) => sample === full.data[0][24000 + i])).toBe(true);
    const range = await render(project, 960); expect(range.data[0]).toEqual(full.data[0].slice(24000));
    clip.gainDb = -6; track.gainDb = -6;
    const quiet = await render(project); expect(rms(quiet.data[0]) / rms(full.data[0])).toBeCloseTo(10 ** (-12 / 20), 5);
    clip.fadeIn.durationTicks = 960;
    expect(rms((await render(project)).data[0].slice(0, 12000))).toBeLessThan(rms(quiet.data[0].slice(0, 12000)) * 0.5);
  });
  it('rejects missing presets and unsupported controls without writing a success artifact', async () => {
    const { project, device, clip } = fixture(127, 127); const destination = join(root, 'rejected.wav');
    await expect(renderProjectToWav({ project, destination })).rejects.toThrow('is missing'); await expect(access(destination)).rejects.toThrow();
    device.soundfont = { ...DEFAULT_SOUNDFONT };
    const cc = { ...entityBase('cc'), tick: 0, controller: 91, value: 1, channel: 0 }; clip.controls[cc.id] = cc;
    await expect(renderProjectToWav({ project, destination })).rejects.toThrow('controller 91'); await expect(access(destination)).rejects.toThrow();
  });
  it('requires matching imported bytes and protects referenced banks from deletion', async () => {
    const { project, device } = fixture(); const path = join(root, 'custom.sf2');
    await writeFile(path, await readFile(bundledSoundFontPath()));
    const asset = { ...entityBase('asset'), kind: 'soundfont' as const, name: 'Custom.sf2', mimeType: 'audio/sf2', sha256: BUNDLED_SOUNDFONT.sha256, byteLength: BUNDLED_SOUNDFONT.byteLength, storage: 'managed-cache' as const, externalPath: path };
    const original = await render(project); project.assets[asset.id] = asset; device.soundfont = { source: 'asset', assetId: asset.id, bank: 0, program: 0 };
    validateProjectIntegrity(project); expect((await render(project)).data).toEqual(original.data);
    const operation: ProjectOperation = { kind: 'asset.delete', assetId: asset.id };
    expect(() => applyProjectTransaction(project, { id: 'tx', clientOperationId: 'delete-bank', projectId: project.id, actor: { id: 'human-local', kind: 'human', name: 'You', color: '#fff' }, label: 'Delete bank', createdAt: new Date().toISOString(), operations: [operation], checkpointPolicy: 'none' })).toThrow('still referenced');
    await writeFile(path, Buffer.from('changed'));
    await expect(render(project)).rejects.toThrow('SoundFont content changed');
  });
  it('rejects truncated or non-SF2 input before synthesis', async () => {
    expect(() => parseSoundFont(Buffer.from('not an SF2'))).toThrow('complete SF2');
    const bytes = await readFile(bundledSoundFontPath());
    bytes.writeUInt32LE(0xffffffff, 16);
    expect(() => parseSoundFont(bytes)).toThrow('exceeds its container');
  });
});
