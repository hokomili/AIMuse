import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  validateTransaction,
  type Actor,
  type AIMuseProject,
  type Device,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-device-latency', kind: 'agent', name: 'Device Latency Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-device-latency', kind: 'human', name: 'Device Latency Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Device latency integrity', createdAt: nowIso(), operations };
}

function device(trackId: string, overrides: Record<string, unknown> = {}): Device {
  return {
    ...entityBase('device', AGENT),
    trackId,
    format: 'builtin',
    builtinKind: 'utility',
    name: 'Declared latency utility',
    bypassed: false,
    degraded: false,
    latencySamples: 0,
    parameters: {
      gain: { id: 'gain', name: 'Gain', value: 0, defaultValue: 0, min: -1, max: 1, automatable: true },
    },
    ...overrides,
  } as Device;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  validateProjectIntegrity(committed.project);
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo device latency operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; sourceTrackId: string; destinationTrackId: string; routedDevice: Device } {
  const base = createProject('song', 'Device latency rejection', AGENT);
  const sourceTrackId = base.trackOrder.find((id) => !['master', 'folder', 'midi'].includes(base.tracks[id].kind))!;
  const destination = createTrack('aux', 'Latency destination', '#a78bfa', AGENT);
  const routedDevice = device(sourceTrackId);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: destination },
    { kind: 'device.add', device: routedDevice },
  ]), { authenticatedActor: AGENT }).project;
  return { project, sourceTrackId, destinationTrackId: destination.id, routedDevice };
}

describe('device latency declared-value integrity', () => {
  it('preserves exact safe endpoints, order, attribution and semantic inverses across every device path', () => {
    const base = createProject('song', 'Device latency boundaries', AGENT);
    const sourceTrackId = base.trackOrder.find((id) => !['master', 'folder', 'midi'].includes(base.tracks[id].kind))!;
    const destination = createTrack('aux', 'Latency destination', '#a78bfa', AGENT);
    let project = commitAndVerifyInverse(base, [{ kind: 'track.add', track: destination }]);

    const maximum = device(sourceTrackId, { name: 'Maximum latency', latencySamples: Number.MAX_SAFE_INTEGER });
    const zero = device(sourceTrackId, { name: 'Zero latency', latencySamples: 0 });
    project = commitAndVerifyInverse(project, [
      { kind: 'device.add', device: maximum },
      { kind: 'device.add', device: zero, index: 0 },
    ]);
    expect(project.tracks[sourceTrackId].deviceIds).toEqual([zero.id, maximum.id]);
    expect(project.devices[maximum.id]).toMatchObject({ latencySamples: Number.MAX_SAFE_INTEGER, createdBy: AGENT.id, updatedBy: AGENT.id });
    expect(project.devices[zero.id]).toMatchObject({ latencySamples: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    expect(() => validateProject(project)).not.toThrow();

    project = commitAndVerifyInverse(project, [{
      kind: 'device.update',
      deviceId: zero.id,
      expectedRevision: project.devices[zero.id].revision,
      changes: { latencySamples: Number.MAX_SAFE_INTEGER },
    }], REVIEWER);
    expect(project.devices[zero.id]).toMatchObject({ latencySamples: Number.MAX_SAFE_INTEGER, createdBy: AGENT.id, updatedBy: REVIEWER.id, revision: 1 });
    expect(project.tracks[sourceTrackId].deviceIds).toEqual([zero.id, maximum.id]);

    project = commitAndVerifyInverse(project, [{
      kind: 'device.parameter.set',
      deviceId: maximum.id,
      parameterId: 'gain',
      value: 1,
      expectedRevision: project.devices[maximum.id].revision,
    }], REVIEWER);
    expect(project.devices[maximum.id]).toMatchObject({ latencySamples: Number.MAX_SAFE_INTEGER, updatedBy: REVIEWER.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'device.move',
      deviceId: maximum.id,
      trackId: destination.id,
      index: 0,
      expectedRevision: project.devices[maximum.id].revision,
    }], REVIEWER);
    expect(project.tracks[sourceTrackId].deviceIds).toEqual([zero.id]);
    expect(project.tracks[destination.id].deviceIds).toEqual([maximum.id]);
    expect(project.devices[maximum.id]).toMatchObject({ latencySamples: Number.MAX_SAFE_INTEGER, trackId: destination.id });

    project = commitAndVerifyInverse(project, [{ kind: 'device.delete', deviceId: zero.id }], REVIEWER);
    expect(project.devices[zero.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'track.delete', trackId: destination.id, cascade: true }], REVIEWER);
    expect(project.devices[maximum.id]).toBeUndefined();
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects malformed stored, incoming, update and corrupt-target latency before mutation or cleanup', () => {
    const { project, sourceTrackId, destinationTrackId, routedDevice } = populatedProject();
    const original = structuredClone(project);
    const invalidValues: unknown[] = [
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'latency',
    ];

    for (const value of invalidValues) {
      const stored = structuredClone(project);
      (stored.devices[routedDevice.id] as unknown as { latencySamples: unknown }).latencySamples = value;
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(/device .* invalid latency/i);

      const incoming = device(sourceTrackId, { id: createId('device'), latencySamples: value });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: incoming }]), { authenticatedActor: AGENT })).toThrow(/device .* invalid latency/i);

      const update = {
        kind: 'device.update',
        deviceId: routedDevice.id,
        changes: { latencySamples: value },
      } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [update], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/device .* invalid latency/i);
    }

    const strictUnsafeUpdate = transaction(project.id, [{
      kind: 'device.update',
      deviceId: routedDevice.id,
      changes: { latencySamples: Number.MAX_SAFE_INTEGER + 1 },
    }], REVIEWER);
    expect(() => validateTransaction(strictUnsafeUpdate)).toThrow();
    expect(() => applyProjectTransaction(project, strictUnsafeUpdate, { authenticatedActor: REVIEWER })).toThrow(/device .* invalid latency/i);

    const corruptedTargetOperations: ProjectOperation[] = [
      { kind: 'device.update', deviceId: routedDevice.id, changes: { name: 'Reviewed device' } },
      { kind: 'device.move', deviceId: routedDevice.id, trackId: destinationTrackId, index: 0 },
      { kind: 'device.parameter.set', deviceId: routedDevice.id, parameterId: 'gain', value: 0.5 },
      { kind: 'device.delete', deviceId: routedDevice.id },
      { kind: 'track.delete', trackId: sourceTrackId, cascade: true },
    ];
    for (const operation of corruptedTargetOperations) {
      const corrupted = structuredClone(project);
      corrupted.devices[routedDevice.id].latencySamples = Number.MAX_SAFE_INTEGER + 1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/device .* invalid latency/i);
      expect(corrupted).toEqual(before);
    }

    const repairable = structuredClone(project);
    repairable.devices[routedDevice.id].latencySamples = Number.MAX_SAFE_INTEGER + 1;
    const repaired = applyProjectTransaction(repairable, transaction(repairable.id, [{
      kind: 'device.update',
      deviceId: routedDevice.id,
      changes: { latencySamples: 0 },
    }], REVIEWER), { authenticatedActor: REVIEWER }).project;
    expect(repaired.devices[routedDevice.id]).toMatchObject({ latencySamples: 0, createdBy: AGENT.id, updatedBy: REVIEWER.id, revision: 1 });
    expect(() => validateProject(repaired)).not.toThrow();
    validateProjectIntegrity(repaired);

    const invalidEntity = device(sourceTrackId, { id: '', name: '', latencySamples: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: invalidEntity }]), { authenticatedActor: AGENT })).toThrow(/invalid entity id/i);
    const invalidFormat = device(sourceTrackId, { format: 'au', name: '', latencySamples: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: invalidFormat }]), { authenticatedActor: AGENT })).toThrow(/invalid format/i);
    const invalidName = device(sourceTrackId, { name: '', latencySamples: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: invalidName }]), { authenticatedActor: AGENT })).toThrow(/invalid name/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.update', deviceId: 'missing-device', changes: { latencySamples: Number.MAX_SAFE_INTEGER + 1 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/does not exist/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.update', deviceId: routedDevice.id, expectedRevision: 99, changes: { latencySamples: Number.MAX_SAFE_INTEGER + 1 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/changed from revision/i);

    const invalidStoredEntity = structuredClone(project);
    invalidStoredEntity.devices[routedDevice.id].id = '';
    invalidStoredEntity.devices[routedDevice.id].name = '';
    invalidStoredEntity.devices[routedDevice.id].latencySamples = Number.MAX_SAFE_INTEGER + 1;
    expect(() => validateProjectIntegrity(invalidStoredEntity)).toThrow(/invalid entity id/i);
    expect(project).toEqual(original);
  });
});
