import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, entityBase, type MidiClip } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { decodeWav } from '../../src/main/wav';

const audioBinary = resolve('native/build/aimuse-audio.exe');
const scannerBinary = resolve('native/build/aimuse-plugin-scanner.exe');

describe.skipIf(!existsSync(audioBinary))('native service protocol', () => {
  it('handshakes, acknowledges graph revision, and mirrors transport safely', async () => {
    const playbackRoot = await mkdtemp(join(tmpdir(), 'aimuse-playback-contract-'));
    const controller = new AudioEngineController(audioBinary, 'test', playbackRoot);
    await controller.start();
    expect(controller.status()).toMatchObject({ mode: 'native', connected: true });
    const project = createProject('song', 'Native');
    project.revision = 7;
    const track = project.tracks[project.trackOrder[0]];
    const note = { ...entityBase('note'), startTick: 0, durationTicks: 960, pitch: 69, velocity: 0.9, releaseVelocity: 0.5, channel: 0, probability: 1 };
    const clip: MidiClip = {
      ...entityBase('clip'), kind: 'midi', trackId: track.id, name: 'Audible contract', color: track.color,
      startTick: 0, durationTicks: 1_920, muted: false, gainDb: 0,
      fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false,
      notes: { [note.id]: note }, noteOrder: [note.id], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
    };
    project.clips[clip.id] = clip; track.clipIds.push(clip.id);
    await expect(controller.prepareProject(project)).resolves.toEqual({ graphRevision: 7 });
    expect(controller.snapshot().graphRevision).toBe(0);
    await expect(controller.commitPreparedProject(project)).resolves.toEqual({ graphRevision: 7 });
    expect(controller.snapshot().graphRevision).toBe(7);
    await expect(controller.transport('play')).resolves.toMatchObject({ status: 'playing', projectId: project.id });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const beforeEdit = controller.snapshot();
    const edited = structuredClone(project); edited.revision = 8; edited.tracks[edited.trackOrder[0]].mute = true;
    await expect(controller.prepareProject(edited)).resolves.toEqual({ graphRevision: 8 });
    await expect(controller.commitPreparedProject(edited)).resolves.toEqual({ graphRevision: 8 });
    expect(controller.snapshot()).toMatchObject({ status: 'playing', graphRevision: 8, projectId: project.id });
    expect(controller.snapshot().tick).toBeGreaterThanOrEqual(beforeEdit.tick);
    expect(controller.snapshot().sample).toBeGreaterThan(0);
    await expect(controller.transport('pause')).resolves.toMatchObject({ status: 'paused' });
    expect(controller.snapshot().sample).toBeGreaterThan(0);
    const previewPath = join(playbackRoot, (await readdir(playbackRoot)).find((name) => name.endsWith('.wav'))!);
    const preview = decodeWav(await readFile(previewPath));
    expect(Math.max(...preview.data[0].subarray(0, Math.min(preview.frames, 48_000)))).toBeGreaterThan(0.01);
    await expect(controller.transport('stop')).resolves.toMatchObject({ status: 'stopped', tick: 0 });
    await controller.stop();
    await rm(playbackRoot, { recursive: true, force: true });
  });
});

describe.skipIf(!existsSync(scannerBinary))('isolated scanner fixtures', () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-scanner-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns only explicit fixture metadata and never invents a real plug-in identity', async () => {
    const module = join(root, 'fixture.clap');
    await writeFile(module, 'fixture');
    await writeFile(`${module}.aimuse-fixture.json`, JSON.stringify([{ pluginUid: 'org.aimuse.fixture', name: 'Fixture Synth', vendor: 'AIMuse', version: '1', instrument: true, categories: ['Synth'], parameters: [] }]));
    const result = spawnSync(scannerBinary, ['--scan', module], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject([{ pluginUid: 'org.aimuse.fixture', name: 'Fixture Synth' }]);
    const realish = join(root, 'unknown.clap');
    await writeFile(realish, 'not a plug-in');
    const rejected = spawnSync(scannerBinary, ['--scan', realish], { encoding: 'utf8', windowsHide: true });
    expect(rejected.status).toBe(11);
    expect(rejected.stderr).toContain('adapter is not linked');
  });
});
