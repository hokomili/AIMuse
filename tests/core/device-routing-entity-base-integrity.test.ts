import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type Device,
  type EntityBase,
  type ProjectOperation,
  type ProjectTransaction,
  type Send,
  type SidechainRoute,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-device-routing-entity-base', kind: 'agent', name: 'Routing Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-device-routing-entity-base', kind: 'human', name: 'Routing Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Device routing entity metadata integrity', createdAt: nowIso(), operations };
}

function device(trackId: string): Device {
  return {
    ...entityBase('device', AGENT), trackId, format: 'builtin', builtinKind: 'utility', name: 'Routing Utility',
    bypassed: false, degraded: false, latencySamples: 0,
    parameters: { gain: { id: 'gain', name: 'Gain', value: 0, defaultValue: 0, min: -1, max: 1, automatable: true } },
  };
}

function send(sourceTrackId: string, destinationTrackId: string): Send {
  return { ...entityBase('send', AGENT), sourceTrackId, destinationTrackId, gainDb: -6, preFader: false, enabled: true };
}

function sidechain(sourceTrackId: string, destinationDeviceId: string): SidechainRoute {
  return { ...entityBase('sidechain', AGENT), sourceTrackId, destinationDeviceId, busIndex: 0, enabled: true };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo device routing entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): {
  project: AIMuseProject; sourceTrack: Track; destinationTrack: Track; routedDevice: Device; routedSend: Send; route: SidechainRoute;
} {
  const base = createProject('song', 'Device routing EntityBase values', AGENT);
  const sourceTrack = base.tracks[base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!];
  const masterId = base.trackOrder.find((id) => base.tracks[id].kind === 'master')!;
  const destinationTrack = createTrack('aux', 'Destination', '#14b8a6', AGENT);
  destinationTrack.routing.outputTrackId = masterId;
  const routedDevice = device(destinationTrack.id);
  const routedSend = send(sourceTrack.id, destinationTrack.id);
  const route = sidechain(sourceTrack.id, routedDevice.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: destinationTrack }, { kind: 'device.add', device: routedDevice },
    { kind: 'send.upsert', send: routedSend }, { kind: 'sidechain.upsert', route },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, destinationTrack, routedDevice, routedSend, route };
}

function assignStoredBoundary(project: AIMuseProject, family: 'device' | 'send' | 'sidechain', entityId: string, changes: Partial<EntityBase>): void {
  if (family === 'device') {
    const value = project.devices[entityId];
    if (changes.id !== undefined && changes.id !== entityId) {
      delete project.devices[entityId];
      project.devices[changes.id] = value;
      project.tracks[value.trackId].deviceIds = project.tracks[value.trackId].deviceIds.map((id) => id === entityId ? changes.id! : id);
      for (const route of Object.values(project.sidechains)) if (route.destinationDeviceId === entityId) route.destinationDeviceId = changes.id;
    }
    Object.assign(value, changes);
    return;
  }
  const collection = family === 'send' ? project.sends : project.sidechains;
  const value = collection[entityId];
  if (changes.id !== undefined && changes.id !== entityId) {
    delete collection[entityId];
    collection[changes.id] = value;
  }
  Object.assign(value, changes);
}

describe('device, send and sidechain EntityBase declared metadata integrity', () => {
  it('preserves attribution, routing membership, cleanup and semantic operation inverses', () => {
    let project = createProject('song', 'Device routing EntityBase lifecycles', AGENT);
    const sourceTrack = project.tracks[project.trackOrder.find((id) => project.tracks[id].kind === 'instrument')!];
    const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
    const destinationTrack = createTrack('aux', 'Destination', '#14b8a6', AGENT);
    destinationTrack.routing.outputTrackId = masterId;
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: destinationTrack }], AGENT), { authenticatedActor: AGENT }).project;

    const routedDevice = device(sourceTrack.id);
    project = commitAndVerifyInverse(project, [{ kind: 'device.add', device: routedDevice }]);
    expect(project.devices[routedDevice.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    expect(project.tracks[sourceTrack.id].deviceIds).toContain(routedDevice.id);

    project = commitAndVerifyInverse(project, [{
      kind: 'device.update', deviceId: routedDevice.id, changes: { name: 'Reviewed Utility', bypassed: true }, expectedRevision: project.devices[routedDevice.id].revision,
    }], REVIEWER);
    project = commitAndVerifyInverse(project, [{
      kind: 'device.parameter.set', deviceId: routedDevice.id, parameterId: 'gain', value: 0.5, expectedRevision: project.devices[routedDevice.id].revision,
    }], REVIEWER);
    project = commitAndVerifyInverse(project, [{
      kind: 'device.move', deviceId: routedDevice.id, trackId: destinationTrack.id, index: 0, expectedRevision: project.devices[routedDevice.id].revision,
    }], REVIEWER);
    expect(project.devices[routedDevice.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, trackId: destinationTrack.id });
    expect(project.tracks[sourceTrack.id].deviceIds).not.toContain(routedDevice.id);
    expect(project.tracks[destinationTrack.id].deviceIds).toEqual([routedDevice.id]);

    const routedSend = send(sourceTrack.id, destinationTrack.id);
    const route = sidechain(sourceTrack.id, routedDevice.id);
    project = commitAndVerifyInverse(project, [{ kind: 'send.upsert', send: routedSend }, { kind: 'sidechain.upsert', route }]);
    project = commitAndVerifyInverse(project, [
      { kind: 'send.upsert', send: { ...routedSend, gainDb: -3, preFader: true, enabled: false }, expectedRevision: project.sends[routedSend.id].revision },
      { kind: 'sidechain.upsert', route: { ...route, busIndex: 2, enabled: false }, expectedRevision: project.sidechains[route.id].revision },
    ], REVIEWER);
    expect(project.sends[routedSend.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, gainDb: -3, preFader: true, enabled: false });
    expect(project.sidechains[route.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, busIndex: 2, enabled: false });

    project = commitAndVerifyInverse(project, [
      { kind: 'send.delete', sendId: routedSend.id }, { kind: 'sidechain.delete', routeId: route.id },
    ], REVIEWER);
    project = commitAndVerifyInverse(project, [{ kind: 'send.upsert', send: routedSend }, { kind: 'sidechain.upsert', route }]);
    const readdedDevice = structuredClone(project.devices[routedDevice.id]);
    project = commitAndVerifyInverse(project, [{ kind: 'device.delete', deviceId: routedDevice.id }], REVIEWER);
    expect(project.devices[routedDevice.id]).toBeUndefined();
    expect(project.sidechains[route.id]).toBeUndefined();
    expect(project.sends[routedSend.id]).toBeDefined();

    project = commitAndVerifyInverse(project, [{ kind: 'device.add', device: readdedDevice }, { kind: 'sidechain.upsert', route }]);
    project = commitAndVerifyInverse(project, [{ kind: 'track.delete', trackId: destinationTrack.id, cascade: true }], REVIEWER);
    expect(project.tracks[destinationTrack.id]).toBeUndefined();
    expect(project.devices[routedDevice.id]).toBeUndefined();
    expect(project.sends[routedSend.id]).toBeUndefined();
    expect(project.sidechains[route.id]).toBeUndefined();
  });

  it('accepts exact independent boundaries and rejects malformed stored, incoming, existing-target and cleanup metadata', () => {
    const { project, sourceTrack, destinationTrack, routedDevice, routedSend, route } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);

    const acceptedCases: Array<Partial<EntityBase>> = [
      { id: 'i' },
      { id: 'i'.repeat(240) },
      { revision: 0 },
      { revision: 42 },
      { createdAt: '2026-08-08T01:02:03Z', updatedAt: '2026-08-07T01:02:03.123456Z' },
      { createdBy: 'c' },
      { createdBy: 'c'.repeat(240) },
      { updatedBy: 'u' },
      { updatedBy: 'u'.repeat(240) },
    ];
    for (const family of ['device', 'send', 'sidechain'] as const) for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      assignStoredBoundary(accepted, family, family === 'device' ? routedDevice.id : family === 'send' ? routedSend.id : route.id, changes);
      validateProjectIntegrity(accepted);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { id: '' }, message: /invalid entity ID/i },
      { changes: { id: 'i'.repeat(241) }, message: /invalid entity ID/i },
      { changes: { id: 42 }, message: /invalid entity ID/i },
      { changes: { revision: -1 }, message: /invalid entity revision/i },
      { changes: { revision: 0.5 }, message: /invalid entity revision/i },
      { changes: { revision: Number.NaN }, message: /invalid entity revision/i },
      { changes: { createdAt: '2026-02-30T00:00:00Z' }, message: /invalid creation timestamp/i },
      { changes: { createdAt: 42 }, message: /invalid creation timestamp/i },
      { changes: { updatedAt: '2026-08-07T00:00:00+00:00' }, message: /invalid update timestamp/i },
      { changes: { updatedAt: 42 }, message: /invalid update timestamp/i },
      { changes: { createdBy: '' }, message: /invalid creator ID/i },
      { changes: { createdBy: 'c'.repeat(241) }, message: /invalid creator ID/i },
      { changes: { createdBy: 42 }, message: /invalid creator ID/i },
      { changes: { updatedBy: '' }, message: /invalid updater ID/i },
      { changes: { updatedBy: 'u'.repeat(241) }, message: /invalid updater ID/i },
      { changes: { updatedBy: 42 }, message: /invalid updater ID/i },
    ];
    for (const { changes, message } of invalidCases) {
      for (const [family, entityId] of [['device', routedDevice.id], ['send', routedSend.id], ['sidechain', route.id]] as const) {
        const invalid = structuredClone(project);
        const collection = family === 'device' ? invalid.devices : family === 'send' ? invalid.sends : invalid.sidechains;
        Object.assign(collection[entityId] as unknown as Record<string, unknown>, changes);
        expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      }

      const incomingDevice = { ...device(sourceTrack.id), ...changes } as unknown as Device;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'device.add', device: incomingDevice }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      const incomingSend = { ...send(sourceTrack.id, destinationTrack.id), ...changes } as unknown as Send;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'send.upsert', send: incomingSend }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      const incomingRoute = { ...sidechain(sourceTrack.id, routedDevice.id), ...changes } as unknown as SidechainRoute;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'sidechain.upsert', route: incomingRoute }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    const invalidDeviceOperations: ProjectOperation[] = [
      { kind: 'device.update', deviceId: routedDevice.id, changes: { bypassed: true } },
      { kind: 'device.move', deviceId: routedDevice.id, trackId: sourceTrack.id, index: 0 },
      { kind: 'device.parameter.set', deviceId: routedDevice.id, parameterId: 'gain', value: 0.5 },
      { kind: 'device.delete', deviceId: routedDevice.id },
    ];
    for (const operation of invalidDeviceOperations) {
      const invalid = structuredClone(project);
      invalid.devices[routedDevice.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    for (const operation of [
      { kind: 'send.upsert', send: { ...routedSend, gainDb: -3 } }, { kind: 'send.delete', sendId: routedSend.id },
    ] as ProjectOperation[]) {
      const invalid = structuredClone(project);
      invalid.sends[routedSend.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }
    for (const operation of [
      { kind: 'sidechain.upsert', route: { ...route, busIndex: 1 } }, { kind: 'sidechain.delete', routeId: route.id },
    ] as ProjectOperation[]) {
      const invalid = structuredClone(project);
      invalid.sidechains[route.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidDeviceCleanup = structuredClone(project);
    invalidDeviceCleanup.sidechains[route.id].revision = -1;
    expect(() => applyProjectTransaction(invalidDeviceCleanup, transaction(invalidDeviceCleanup.id, [{
      kind: 'device.delete', deviceId: routedDevice.id,
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);

    for (const family of ['device', 'send', 'sidechain'] as const) {
      const invalid = structuredClone(project);
      if (family === 'device') invalid.devices[routedDevice.id].revision = -1;
      else if (family === 'send') invalid.sends[routedSend.id].revision = -1;
      else invalid.sidechains[route.id].revision = -1;
      const invalidOriginal = structuredClone(invalid);
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [{
        kind: 'track.delete', trackId: destinationTrack.id, cascade: true,
      }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
      expect(invalid).toEqual(invalidOriginal);
    }
    expect(project).toEqual(original);
  });
});
