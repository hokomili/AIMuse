import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { applyProjectTransaction, createProject, createTrack, entityBase, HUMAN_ACTOR, MAX_RECENT_ACTIVITY_ENTRIES, validateProjectIntegrity, type AIMuseProject, type MidiClip } from '@aimuse/core';

function elapsed(action: () => void): number { const started = performance.now(); action(); return performance.now() - started; }

describe('cross-platform canonical-model performance evidence', () => {
  it('gates large canonical-model interaction and sustained transaction integrity', async () => {
    const project = createProject('song', 'Performance fixture');
    const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
    const tracksStarted = performance.now();
    while (project.trackOrder.length < 200) {
      const index = project.trackOrder.length - 1;
      const track = createTrack('instrument', `Instrument ${index + 1}`, '#8b5cf6'); track.routing.outputTrackId = masterId;
      project.tracks[track.id] = track; project.trackOrder.splice(project.trackOrder.length - 1, 0, track.id);
    }
    const musicalTracks = project.trackOrder.filter((id) => project.tracks[id].kind !== 'master');
    for (let index = 0; index < 10_000; index += 1) {
      const track = project.tracks[musicalTracks[index % musicalTracks.length]];
      const clip: MidiClip = { ...entityBase('clip'), kind: 'midi', trackId: track.id, name: `Clip ${index + 1}`, color: track.color, startTick: (index % 500) * 240, durationTicks: 240, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [] };
      project.clips[clip.id] = clip; track.clipIds.push(clip.id);
    }
    const buildLargeModelMs = performance.now() - tracksStarted;
    const validateLargeModelMs = elapsed(() => validateProjectIntegrity(project));
    const interactiveProjectionMs = elapsed(() => {
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const start = iteration * 1_920; const end = start + 15_360;
        let visible = 0;
        for (const clip of Object.values(project.clips)) if (clip.startTick < end && clip.startTick + clip.durationTicks > start) visible += 1;
        if (visible < 0) throw new Error('Impossible projection.');
      }
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(project));

    let sustained: AIMuseProject = createProject('song', 'Autonomous transaction fixture');
    const transactionStarted = performance.now();
    for (let index = 0; index < 20_000; index += 1) {
      sustained = applyProjectTransaction(sustained, { id: `perf-tx-${index}`, clientOperationId: `perf-op-${index}`, projectId: sustained.id, actor: HUMAN_ACTOR, label: `Performance transaction ${index}`, createdAt: new Date(0).toISOString(), operations: [{ kind: 'project.rename', name: `Autonomous ${index}` }], checkpointPolicy: 'none' }, { authenticatedActor: HUMAN_ACTOR }).project;
    }
    const twentyThousandTransactionsMs = performance.now() - transactionStarted;
    validateProjectIntegrity(sustained);

    const evidence = {
      version: 1, recordedAt: new Date().toISOString(), node: process.version,
      machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
      fixture: { tracks: project.trackOrder.length, clips: Object.keys(project.clips).length, serializedBytes, committedTransactions: sustained.revision, retainedActivityEntries: sustained.activity.length },
      measurementsMs: { buildLargeModel: buildLargeModelMs, validateLargeModel: validateLargeModelMs, fortyViewportProjections: interactiveProjectionMs, twentyThousandTransactions: twentyThousandTransactionsMs },
      budgetsMs: { buildLargeModel: 10_000, validateLargeModel: 5_000, fortyViewportProjections: 5_000, twentyThousandTransactions: 120_000 },
      limitations: ['This source-level gate does not substitute for packaged pointer/frame pacing, real-time callback/xrun, eight-hour soak, or pinned-reference-machine evidence.'],
    };
    await mkdir(join('test-results', 'performance'), { recursive: true });
    await writeFile(join('test-results', 'performance', `canonical-model-${platform()}.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

    expect(project.trackOrder).toHaveLength(200); expect(Object.keys(project.clips)).toHaveLength(10_000);
    expect(sustained.revision).toBe(20_000); expect(sustained.activity).toHaveLength(MAX_RECENT_ACTIVITY_ENTRIES); expect(sustained.name).toBe('Autonomous 19999');
    expect(buildLargeModelMs).toBeLessThan(evidence.budgetsMs.buildLargeModel);
    expect(validateLargeModelMs).toBeLessThan(evidence.budgetsMs.validateLargeModel);
    expect(interactiveProjectionMs).toBeLessThan(evidence.budgetsMs.fortyViewportProjections);
    expect(twentyThousandTransactionsMs).toBeLessThan(evidence.budgetsMs.twentyThousandTransactions);
  });
});
