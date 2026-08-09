import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { strFromU8, unzipSync } from 'fflate';
import {
  HUMAN_ACTOR, createId, createTrack, entityBase, nowIso,
  type AsyncJob, type MidiClip, type ProjectTransaction, type SfxDeliverable,
} from '@aimuse/core';
import type { ExportReport } from '../../src/main/export-manager';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
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
});
