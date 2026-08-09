import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { MediaManager } from '../../src/main/media-manager';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

describe('MediaManager MIDI import', () => {
  let root: string;
  let audio: AudioEngineController;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-media-'));
    audio = new AudioEngineController();
    await audio.start();
  });

  afterEach(async () => {
    await audio.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('converts SMF notes, CC, and pitch bends into granular 960 PPQ project entities', async () => {
    const projects = new ProjectService({
      appVersion: 'test',
      checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')),
      audio,
    });
    await projects.initialize();
    const project = projects.getActiveProject()!;

    const midi = new Midi();
    const source = midi.addTrack();
    source.name = 'Lead';
    source.channel = 2;
    source.addNote({ midi: 64, ticks: 480, durationTicks: 240, velocity: 0.8 });
    source.addCC({ number: 1, ticks: 240, value: 0.5 });
    // @tonejs/midi's writer accepts the raw signed 14-bit value.
    source.addPitchBend({ ticks: 120, value: 2_048 });
    const sourcePath = join(root, 'lead.mid');
    await writeFile(sourcePath, midi.toArray());

    const media = new MediaManager(join(root, 'managed'), projects, new AuthorityManager());
    const result = await media.importPaths(project.id, [sourcePath]);

    expect(result.warnings).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].asset).toMatchObject({ kind: 'midi', mimeType: 'audio/midi', source: 'import' });

    const imported = projects.getProject(project.id)!;
    const track = Object.values(imported.tracks).find((value) => value.name === 'Lead');
    expect(track).toMatchObject({ kind: 'instrument' });
    const clip = Object.values(imported.clips).find((value) => value.kind === 'midi' && value.trackId === track?.id);
    expect(clip?.kind).toBe('midi');
    if (!clip || clip.kind !== 'midi') throw new Error('Expected an imported MIDI clip.');

    expect(Object.values(clip.notes)[0]).toMatchObject({ startTick: 960, durationTicks: 480, pitch: 64, channel: 2 });
    expect(Object.values(clip.controls)[0]).toMatchObject({ tick: 480, controller: 1, channel: 2 });
    expect(Object.values(clip.pitchBends)[0]).toMatchObject({ tick: 240, value: 0.25, channel: 2 });
    expect(clip.durationTicks).toBeGreaterThanOrEqual(3_840);
  });
});
