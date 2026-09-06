import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { strFromU8, unzipSync } from 'fflate';
import yauzl from 'yauzl';
import {
  HUMAN_ACTOR, createId, createTrack, entityBase, nowIso,
  type Actor, type AsyncJob, type AudioClip, type MediaAsset, type MidiClip, type ProjectOperation, type ProjectTransaction, type SfxDeliverable,
} from '@aimuse/core';
import type { ExportReport } from '../../src/main/export-manager';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
import { decodeWav, encodeFloat32Wav } from '../../src/main/wav';
import { RecoveryJournal } from '../../src/main/journal';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

describe('export pipeline', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let exports: ExportManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-export-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    exports = new ExportManager(projects, audio, new AuthorityManager());
    await audio.start();
    await projects.initialize();
    await addMidiFixture();
  });

  afterEach(async () => {
    await audio.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function addMidiFixture(): Promise<void> {
    const project = projects.getActiveProject()!;
    const master = project.tracks[project.trackOrder.at(-1)!];
    const track = createTrack('instrument', 'Fixture Lead', '#8b5cf6', HUMAN_ACTOR);
    track.routing.outputTrackId = master.id;
    const note = { ...entityBase('note', HUMAN_ACTOR), startTick: 0, durationTicks: 480, pitch: 69, velocity: 0.8, releaseVelocity: 0.5, channel: 0, probability: 1 };
    const bend = { ...entityBase('bend', HUMAN_ACTOR), tick: 240, value: 0.25, channel: 0 };
    const clip: MidiClip = {
      ...entityBase('clip', HUMAN_ACTOR), kind: 'midi', trackId: track.id, name: 'Lead phrase', color: track.color,
      startTick: 480, durationTicks: 960, muted: false, gainDb: 0,
      fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false,
      notes: { [note.id]: note }, noteOrder: [note.id], controls: {}, controlOrder: [], pitchBends: { [bend.id]: bend }, pitchBendOrder: [bend.id],
    };
    const transaction: ProjectTransaction = {
      id: createId('tx'), clientOperationId: createId('fixture'), projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Add export fixture', createdAt: nowIso(), operations: [{ kind: 'track.add', track, index: project.trackOrder.length - 1 }, { kind: 'clip.add', clip }], checkpointPolicy: 'none',
    };
    expect(await projects.apply(transaction, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
  }

  async function terminal(jobId: string): Promise<AsyncJob<ExportReport>> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = projects.getJob<ExportReport>(jobId)!;
      if (['completed', 'failed', 'cancelled', 'waiting-for-user'].includes(job.status)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error('Export job did not finish.');
  }

  async function centralDirectoryNames(path: string): Promise<string[]> {
    return new Promise((resolvePromise, reject) => {
      yauzl.open(path, { lazyEntries: true }, (error, archive) => {
        if (error || !archive) return reject(error ?? new Error('ZIP central directory could not be opened.'));
        const names: string[] = [];
        archive.once('error', reject);
        archive.once('end', () => resolvePromise(names));
        archive.on('entry', (entry) => { names.push(entry.fileName); archive.readEntry(); });
        archive.readEntry();
      });
    });
  }

  async function addContentAddressedAudio(leftBytes: Buffer, rightBytes: Buffer): Promise<{ archivePath: string }> {
    const project = projects.getActiveProject()!;
    const master = project.tracks[project.trackOrder.at(-1)!];
    const track = createTrack('audio', 'Content-addressed audio', '#06b6d4', HUMAN_ACTOR);
    track.routing.outputTrackId = master.id;
    const declaredSha256 = createHash('sha256').update(leftBytes).digest('hex');
    const sources = [join(root, 'source-a.wav'), join(root, 'source-b.wav')];
    await Promise.all([writeFile(sources[0], leftBytes), writeFile(sources[1], rightBytes)]);
    const assets: MediaAsset[] = sources.map((sourcePath, index) => ({
      ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: `Source ${index + 1}.wav`, mimeType: 'audio/wav', sha256: declaredSha256,
      byteLength: index ? rightBytes.length : leftBytes.length, storage: 'managed-cache', externalPath: sourcePath,
      sampleRate: 48_000, channels: 2, durationSamples: 48_000, source: 'import',
    }));
    const clips: AudioClip[] = assets.map((asset, index) => ({
      ...entityBase('clip', HUMAN_ACTOR), kind: 'audio', trackId: track.id, assetId: asset.id, name: `Reference ${index + 1}`, color: track.color,
      startTick: index * 960, durationTicks: 960, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false,
      sourceStartSample: 0, sourceDurationSamples: 48_000, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers: [],
    }));
    const operations: ProjectOperation[] = [
      ...assets.map((asset) => ({ kind: 'asset.add' as const, asset })),
      { kind: 'track.add', track, index: project.trackOrder.length - 1 },
      ...clips.map((clip) => ({ kind: 'clip.add' as const, clip })),
    ];
    expect(await projects.apply({ id: createId('tx'), clientOperationId: createId('audio-fixture'), projectId: project.id, actor: HUMAN_ACTOR, label: 'Add content-addressed audio fixtures', createdAt: nowIso(), operations, checkpointPolicy: 'none' }, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    assets.forEach((asset, index) => projects.registerAssetSource(asset.id, sources[index]));
    return { archivePath: `audio/${declaredSha256}.wav` };
  }

  it('exports Standard MIDI with tempo, notes, and normalized pitch bend intact', async () => {
    const destination = join(root, 'song-midi');
    const job = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'midi', destination }).jobId);
    expect(job).toMatchObject({ status: 'completed', result: { destination: `${destination}.mid`, warnings: [] } });

    const midi = new Midi(await readFile(`${destination}.mid`));
    expect(midi.header.ppq).toBe(960);
    expect(midi.header.tempos[0]).toMatchObject({ ticks: 0, bpm: 120 });
    const track = midi.tracks.find((value) => value.name === 'Fixture Lead')!;
    expect(track.notes[0]).toMatchObject({ ticks: 480, durationTicks: 480, midi: 69 });
    expect(track.pitchBends[0]).toMatchObject({ ticks: 720, value: 0.25 });
  });

  it('does not resurrect a queued agent export after cancellation during approval preflight', async () => {
    const actor: Actor = { id: 'agent-export-cancel', kind: 'agent', name: 'Export cancellation agent', color: '#06b6d4' };
    const reservation = projects.reserveApproval(actor.id)!;
    const destination = join(root, 'cancelled-before-approval');
    const { jobId } = exports.start({ projectId: projects.getActiveProjectId()!, kind: 'midi', destination }, actor, reservation.reservationId);
    expect(projects.cancelJob(jobId)).toMatchObject({ status: 'cancelled' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(projects.getJob(jobId)).toMatchObject({ status: 'cancelled' });
    expect(projects.getJob(jobId)).not.toHaveProperty('approval');
    await expect(stat(`${destination}.mid`)).rejects.toThrow();
    const next = projects.reserveApproval('agent-after-cancel');
    expect(next).toEqual({ reservationId: expect.stringMatching(/^approval-reservation_/) });
    projects.releaseApprovalReservation(next!.reservationId);
  });

  it('produces deterministic loudness-normalized WAV renders and a DAWproject fallback report', async () => {
    const first = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'master', destination: join(root, 'master-a'), format: 'wav' }).jobId);
    const second = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'master', destination: join(root, 'master-b'), format: 'wav' }).jobId);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    const left = await readFile(join(root, 'master-a.wav'));
    const right = await readFile(join(root, 'master-b.wav'));
    expect(left.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(left.equals(right)).toBe(true);

    const daw = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'dawproject', destination: join(root, 'interchange') }).jobId);
    expect(daw.status).toBe('completed');
    const archive = unzipSync(await readFile(join(root, 'interchange.dawproject')));
    expect(Object.keys(archive).sort()).toEqual(['fallback-report.json', 'metadata.xml', 'project.xml']);
    expect(strFromU8(archive['project.xml'])).toContain('<Project version="1.0">');
    expect(JSON.parse(strFromU8(archive['fallback-report.json']))).toMatchObject({ format: 'AIMuse DAWproject fallback report', warnings: [] });
  });

  it('writes one central-directory member for identical content-addressed DAWproject media while retaining every XML reference', async () => {
    const payload = Buffer.from('identical controlled DAWproject media');
    const { archivePath } = await addContentAddressedAudio(payload, payload);
    const destination = join(root, 'deduplicated.dawproject');
    const job = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'dawproject', destination }).jobId);
    expect(job).toMatchObject({ status: 'completed', result: { warnings: [] } });

    const names = await centralDirectoryNames(destination);
    expect(names).toHaveLength(new Set(names).size);
    expect(names.filter((name) => name === archivePath)).toEqual([archivePath]);
    expect(names.sort()).toEqual(['fallback-report.json', 'metadata.xml', 'project.xml', archivePath].sort());
    const extracted = unzipSync(await readFile(destination));
    const projectXml = strFromU8(extracted['project.xml']);
    expect(projectXml.split(`path="${archivePath}"`)).toHaveLength(3);
    expect(Buffer.from(extracted[archivePath])).toEqual(payload);
  });

  it('fails before writing a DAWproject when one archive member path resolves to different payloads', async () => {
    const { archivePath } = await addContentAddressedAudio(Buffer.from('left'), Buffer.from('rift'));
    const destination = join(root, 'conflicting.dawproject');
    const job = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'dawproject', destination }).jobId);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'export-failed' } });
    expect(job.message).toBe(`DAWproject archive member ${archivePath} resolves to different payloads.`);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.startsWith('conflicting.dawproject'))).toEqual([]);
  });

  it('checks the effective extension for collisions and refuses codec substitution', async () => {
    const collision = join(root, 'already-there.mid');
    await writeFile(collision, 'existing');
    const collisionJob = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'midi', destination: join(root, 'already-there') }).jobId);
    expect(collisionJob).toMatchObject({ status: 'failed', error: { code: 'export-failed' } });
    expect(await readFile(collision, 'utf8')).toBe('existing');

    const mp3Path = join(root, 'master.mp3');
    const codecJob = await terminal(exports.start({ projectId: projects.getActiveProjectId()!, kind: 'master', destination: join(root, 'master'), format: 'mp3' }).jobId);
    expect(codecJob.status).toBe('failed');
    expect(codecJob.message).toContain('did not silently substitute WAV');
    await expect(stat(mp3Path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renders named SFX variations with deterministic metadata and distinct audio', async () => {
    const project = projects.getActiveProject()!;
    const deliverable: SfxDeliverable = {
      ...entityBase('sfx-deliverable', HUMAN_ACTOR), name: 'Magic Confirm', startTick: 0, endTick: 1_920, variantCount: 3,
      tags: ['ui', 'magic'], seamlessLoop: false, tailMilliseconds: 120,
      variation: { seed: 42, pitchRangeSemitones: 1.5, gainRangeDb: 1, timingRangeMilliseconds: 8 },
      targetLufs: -16, namingTemplate: '{name}_{tags}_{index}', exportFormat: 'wav',
    };
    expect(await projects.apply({ id: createId('tx'), clientOperationId: createId('sfx'), projectId: project.id, actor: HUMAN_ACTOR, label: 'Create SFX export', createdAt: nowIso(), operations: [{ kind: 'sfx-deliverable.add', deliverable }], checkpointPolicy: 'none' }, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    const destination = join(root, 'sfx');
    const job = await terminal(exports.start({ projectId: project.id, kind: 'sfx-batch', destination, format: 'wav' }).jobId);
    expect(job.status).toBe('completed');

    const paths = [1, 2, 3].map((index) => join(destination, `Magic Confirm_ui-magic_0${index}.wav`));
    const audio = await Promise.all(paths.map((path) => readFile(path)));
    expect(new Set(audio.map((bytes) => bytes.toString('base64'))).size).toBe(3);
    const manifest = JSON.parse(await readFile(join(destination, 'sfx-export.json'), 'utf8')) as { files: Array<Record<string, unknown>> };
    expect(manifest.files).toHaveLength(3);
    expect(manifest.files[0]).toMatchObject({ deliverableId: deliverable.id, variant: 1, tags: ['ui', 'magic'], targetLufs: -16, variation: { pitchSemitones: 0, gainDb: 0, timingMilliseconds: 0 } });
  });
  async function edit(operations: ProjectOperation[]): Promise<void> {
    expect(await projects.apply({ id: createId('tx'), clientOperationId: createId('edit'), projectId: projects.getActiveProjectId()!, actor: HUMAN_ACTOR, label: 'Export regression edit', createdAt: nowIso(), operations, checkpointPolicy: 'none' }, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
  }
  const energy = (channel: Float32Array) => Math.sqrt(channel.reduce((sum, sample) => sum + sample * sample, 0) / channel.length);
  it('preserves renderer warnings and applies the master fader after loudness normalization', async () => {
    const projectId = projects.getActiveProjectId()!;
    const first = await terminal(exports.start({ projectId, kind: 'master', destination: join(root, 'full.wav') }).jobId);
    expect(first.result?.warnings.join(' ')).toContain('sine guide voice'); expect(first.message).toContain('warning');
    const full = decodeWav(await readFile(join(root, 'full.wav')));
    const master = Object.values(projects.getActiveProject()!.tracks).find((track) => track.kind === 'master')!;
    await edit([{ kind: 'track.update', trackId: master.id, changes: { gainDb: -18 } }]);
    expect((await terminal(exports.start({ projectId, kind: 'master', destination: join(root, 'quiet.wav') }).jobId)).status).toBe('completed');
    const quiet = decodeWav(await readFile(join(root, 'quiet.wav')));
    expect(energy(quiet.data[0]) / energy(full.data[0])).toBeCloseTo(10 ** (-18 / 20), 5);
    await edit([{ kind: 'track.update', trackId: master.id, changes: { mute: true } }]);
    expect((await terminal(exports.start({ projectId, kind: 'master', destination: join(root, 'muted.wav') }).jobId)).status).toBe('completed');
    expect(energy(decodeWav(await readFile(join(root, 'muted.wav'))).data[0])).toBe(0);
  });
  it('exports every final loop variant with verified endpoints after pitch/timing changes and normalization', async () => {
    const project = projects.getActiveProject()!; const path = join(root, 'loop-source.wav');
    const source = Float32Array.from({ length: 192000 }, (_, index) => 0.3 * Math.sin(2 * Math.PI * 233.7 * index / 48000 + 0.4));
    const bytes = encodeFloat32Wav([source, source], 48000); await writeFile(path, bytes);
    const asset: MediaAsset = { ...entityBase('asset'), kind: 'audio', name: 'Loop source.wav', mimeType: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, storage: 'linked', externalPath: path, sampleRate: 48000, channels: 2, durationSamples: source.length };
    const track = createTrack('audio', 'Seam fixture', '#06b6d4');
    const clip: AudioClip = { ...entityBase('clip'), kind: 'audio', assetId: asset.id, trackId: track.id, name: 'Non-periodic tone', color: track.color, startTick: 0, durationTicks: 7680, sourceStartSample: 0, sourceDurationSamples: source.length, transposeSemitones: 0, stretchMode: 'repitch', reverse: false, warpMarkers: [], muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false };
    const deliverable: SfxDeliverable = { ...entityBase('sfx'), id: 'tide-hum-loop', name: 'Tide hum loop', startTick: 0, endTick: 7680, variantCount: 5, tags: [], seamlessLoop: true, tailMilliseconds: 0, variation: { seed: 42, pitchRangeSemitones: 1, gainRangeDb: 0.5, timingRangeMilliseconds: 1 }, targetLufs: -18, namingTemplate: 'loop-{index}', exportFormat: 'wav' };
    await edit([{ kind: 'asset.add', asset }, { kind: 'track.add', track }, { kind: 'clip.add', clip }, { kind: 'sfx-deliverable.add', deliverable }]);
    const destination = join(root, 'loops'); expect((await terminal(exports.start({ projectId: project.id, kind: 'sfx-batch', destination }).jobId)).status).toBe('completed');
    const manifest = JSON.parse(await readFile(join(destination, 'sfx-export.json'), 'utf8')) as { files: Array<{ file: string; seamlessLoop: boolean; loopEndSample: number; loopVerification: { seamJump: number } }> };
    expect(manifest.files).toHaveLength(5);
    for (const entry of manifest.files) {
      const pcm = decodeWav(await readFile(join(destination, entry.file))); expect(pcm.frames).toBe(192000); expect(entry.loopEndSample).toBe(pcm.frames);
      expect(entry.seamlessLoop).toBe(true); expect(entry.loopVerification.seamJump).toBeLessThanOrEqual(1e-6);
      for (const channel of pcm.data) { expect(Math.abs(channel[0] - channel[channel.length - 1])).toBe(0); expect(Math.abs(channel[1] - channel[0])).toBeLessThan(0.0001); expect(energy(channel)).toBeGreaterThan(0.01); }
    }
    await edit([{ kind: 'sfx-deliverable.update', deliverableId: deliverable.id, changes: { loopStartSample: 0, loopEndSample: 3, variantCount: 1 } }]);
    const tiny = join(root, 'tiny'); expect((await terminal(exports.start({ projectId: project.id, kind: 'sfx-batch', destination: tiny }).jobId)).status).toBe('completed');
    const tinyPcm = decodeWav(await readFile(join(tiny, 'loop-01.wav'))); expect(tinyPcm.frames).toBe(3); expect(tinyPcm.data[0][0]).toBe(tinyPcm.data[0][2]);
  });

  it('reports unsupported authored processing as non-retryable until the project changes', async () => {
    const project = projects.getActiveProject()!; const track = Object.values(project.tracks).find((track) => track.name === 'Fixture Lead')!;
    await edit([{ kind: 'device.add', device: { ...entityBase('device'), trackId: track.id, name: 'Unsupported Reverb', format: 'builtin', builtinKind: 'reverb', bypassed: false, degraded: false, latencySamples: 0, parameters: {} } }]);
    const job = await terminal(exports.start({ projectId: project.id, kind: 'master', destination: join(root, 'unsupported.wav') }).jobId);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'unsupported-audio-render', retryable: false, message: expect.stringContaining('Bypass/remove') } });
  });

});
