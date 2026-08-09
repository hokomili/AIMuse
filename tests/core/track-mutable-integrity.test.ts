import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-track-fields', kind: 'agent', name: 'Track Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-track-fields-reviewer', kind: 'agent', name: 'Track Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operation: ProjectOperation, actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Track mutable-field integrity', createdAt: nowIso(), operations: [operation] };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function updateAndVerifyInverse(project: AIMuseProject, trackId: string, changes: ProjectOperation & { kind: 'track.update' }, actor: Actor): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, changes, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo track update', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  expect(committed.project.tracks[trackId].createdAt).toBe(project.tracks[trackId].createdAt);
  expect(committed.project.tracks[trackId].createdBy).toBe(project.tracks[trackId].createdBy);
  expect(committed.project.tracks[trackId].updatedBy).toBe(actor.id);
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function trackContext(): { project: AIMuseProject; track: Track; masterId: string } {
  const project = createProject('song', 'Track fields');
  const track = project.tracks[project.trackOrder[0]];
  const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
  return { project, track, masterId };
}

describe('track mutable-field integrity', () => {
  it('keeps every declared track.update field semantically invertible and attributed', () => {
    const { project, track, masterId } = trackContext();
    const updated = updateAndVerifyInverse(project, track.id, {
      kind: 'track.update', trackId: track.id, expectedRevision: track.revision,
      changes: {
        name: 'Reviewed track', color: '#123456', gainDb: -6, pan: 0.25,
        mute: true, solo: true, armed: true, frozen: true, collapsed: true,
        routing: {
          outputTrackId: masterId,
          inputDeviceId: 'mock-audio-input', inputChannels: [0, 1],
          midiInputDeviceId: 'mock-midi-input', midiOutputDeviceId: 'mock-midi-output', monitor: 'on',
        },
      },
    }, REVIEWER);
    expect(updated.tracks[track.id]).toMatchObject({
      name: 'Reviewed track', color: '#123456', gainDb: -6, pan: 0.25,
      mute: true, solo: true, armed: true, frozen: true, collapsed: true,
      routing: { outputTrackId: masterId, inputChannels: [0, 1], monitor: 'on' },
    });
  });

  it('accepts declared boundaries and rejects invalid mutable values without semantic routing policy', () => {
    const { project, track, masterId } = trackContext();
    const boundaryRouting = {
      outputTrackId: masterId,
      inputDeviceId: 'i'.repeat(500), inputChannels: Array.from({ length: 64 }, (_, index) => index),
      midiInputDeviceId: 'm'.repeat(500), midiOutputDeviceId: 'o'.repeat(500), monitor: 'off' as const,
    };
    const boundary = applyProjectTransaction(project, transaction(project.id, {
      kind: 'track.update', trackId: track.id,
      changes: { name: 'n'.repeat(200), color: 'c'.repeat(40), gainDb: -120, pan: 1, routing: boundaryRouting },
    }, AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(boundary);

    const routing = structuredClone(track.routing);
    const invalidChanges: Array<Record<string, unknown>> = [
      { name: '' }, { name: 'n'.repeat(201) }, { color: 'c'.repeat(41) },
      { gainDb: Number.NaN }, { gainDb: -121 }, { gainDb: 25 }, { pan: Number.POSITIVE_INFINITY }, { pan: -1.01 }, { pan: 1.01 },
      { mute: 'yes' }, { solo: 1 }, { armed: null }, { frozen: 'no' }, { collapsed: 0 },
      { routing: null },
      { routing: { ...routing, outputTrackId: '' } }, { routing: { ...routing, outputTrackId: 't'.repeat(241) } },
      { routing: { ...routing, inputDeviceId: 'i'.repeat(501) } },
      { routing: { ...routing, inputChannels: Array.from({ length: 65 }, () => 0) } },
      { routing: { ...routing, inputChannels: [-1] } }, { routing: { ...routing, inputChannels: [0.5] } },
      { routing: { ...routing, midiInputDeviceId: 'm'.repeat(501) } },
      { routing: { ...routing, midiOutputDeviceId: 'm'.repeat(501) } },
      { routing: { ...routing, monitor: 'sometimes' } },
    ];
    for (const changes of invalidChanges) {
      const invalid = structuredClone(project);
      Object.assign(invalid.tracks[track.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/Track .* invalid/i);
      const operation = { kind: 'track.update', trackId: track.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, operation, AGENT), { authenticatedActor: AGENT })).toThrow(/Track .* invalid/i);
      expect(project.tracks[track.id]).toEqual(track);
    }
  });
});
