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
  type AutomationLane,
  type Device,
  type ProjectOperation,
  type ProjectTransaction,
  type Send,
  type SidechainRoute,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-routing', kind: 'agent', name: 'Routing Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-reviewer', kind: 'agent', name: 'Routing Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Device routing integrity', createdAt: nowIso(), operations };
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

function lane(trackId: string, deviceId: string): AutomationLane {
  return { ...entityBase('lane', AGENT), trackId, target: { kind: 'device', deviceId, parameterId: 'gain' }, points: {}, pointOrder: [], armed: false, visible: true };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo device routing operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

describe('device and routing reducer integrity', () => {
  it('keeps device/send/sidechain lifecycles reversible and preserves creation attribution', () => {
    let project = createProject('song', 'Device routing inverses');
    const sourceTrack = project.tracks[project.trackOrder[0]];
    const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
    const destinationTrack = createTrack('aux', 'Destination', '#14b8a6', AGENT);
    destinationTrack.routing.outputTrackId = masterId;
    project = commitAndVerifyInverse(project, [{ kind: 'track.add', track: destinationTrack }]);

    const routedDevice = device(sourceTrack.id);
    const routedSend = send(sourceTrack.id, destinationTrack.id);
    const route = sidechain(destinationTrack.id, routedDevice.id);
    project = commitAndVerifyInverse(project, [{ kind: 'device.add', device: routedDevice }]);
    project = commitAndVerifyInverse(project, [{ kind: 'device.update', deviceId: routedDevice.id, changes: { name: 'Reviewed Utility' } }], REVIEWER);
    expect(project.devices[routedDevice.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, name: 'Reviewed Utility' });
    project = commitAndVerifyInverse(project, [{ kind: 'device.parameter.set', deviceId: routedDevice.id, parameterId: 'gain', value: 0.5 }]);
    project = commitAndVerifyInverse(project, [{ kind: 'device.move', deviceId: routedDevice.id, trackId: destinationTrack.id, index: 0 }]);
    expect(project.tracks[sourceTrack.id].deviceIds).not.toContain(routedDevice.id);
    expect(project.tracks[destinationTrack.id].deviceIds).toEqual([routedDevice.id]);

    project = commitAndVerifyInverse(project, [{ kind: 'send.upsert', send: routedSend }]);
    project = commitAndVerifyInverse(project, [{ kind: 'send.upsert', send: { ...routedSend, gainDb: -3 }, expectedRevision: project.sends[routedSend.id].revision }], REVIEWER);
    expect(project.sends[routedSend.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, gainDb: -3 });

    project = commitAndVerifyInverse(project, [{ kind: 'sidechain.upsert', route }]);
    project = commitAndVerifyInverse(project, [{ kind: 'sidechain.upsert', route: { ...route, busIndex: 2 }, expectedRevision: project.sidechains[route.id].revision }], REVIEWER);
    expect(project.sidechains[route.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, busIndex: 2 });
    project = commitAndVerifyInverse(project, [{ kind: 'sidechain.delete', routeId: route.id }]);
    expect(project.sidechains[route.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'sidechain.upsert', route }]);

    const deviceLane = lane(destinationTrack.id, routedDevice.id);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.lane.add', lane: deviceLane }]);
    project = commitAndVerifyInverse(project, [{ kind: 'device.delete', deviceId: routedDevice.id }]);
    expect(project.devices[routedDevice.id]).toBeUndefined();
    expect(project.sidechains[route.id]).toBeUndefined();
    expect(project.automationLanes[deviceLane.id]).toBeUndefined();
    expect(project.sends[routedSend.id]).toBeDefined();
    project = commitAndVerifyInverse(project, [{ kind: 'send.delete', sendId: routedSend.id }]);
    expect(project.sends[routedSend.id]).toBeUndefined();
  });

  it('rejects malformed reciprocal device, state-media, send and sidechain references', () => {
    const base = createProject('song', 'Device routing integrity');
    const track = base.tracks[base.trackOrder[0]];
    const routedDevice = device(track.id);
    const populated = applyProjectTransaction(base, transaction(base.id, [{ kind: 'device.add', device: routedDevice }], AGENT), { authenticatedActor: AGENT }).project;

    const orphaned = structuredClone(populated);
    orphaned.tracks[track.id].deviceIds = [];
    expect(() => validateProjectIntegrity(orphaned)).toThrow(/device .* orphaned/i);

    const duplicate = structuredClone(populated);
    duplicate.tracks[track.id].deviceIds.push(routedDevice.id);
    expect(() => validateProjectIntegrity(duplicate)).toThrow(/duplicate device/i);

    const unsupportedTrack = structuredClone(populated);
    unsupportedTrack.tracks[track.id].kind = 'midi';
    expect(() => validateProjectIntegrity(unsupportedTrack)).toThrow(/unsupported track kind/i);

    const missingState = structuredClone(populated);
    missingState.devices[routedDevice.id].stateAssetId = 'missing-state';
    expect(() => validateProjectIntegrity(missingState)).toThrow(/missing state media/i);

    const missingSend = structuredClone(populated);
    const routedSend = send(track.id, 'missing-track');
    missingSend.sends[routedSend.id] = routedSend;
    expect(() => validateProjectIntegrity(missingSend)).toThrow(/send .* invalid/i);

    const missingSidechain = structuredClone(populated);
    const route = sidechain('missing-track', routedDevice.id);
    missingSidechain.sidechains[route.id] = route;
    expect(() => validateProjectIntegrity(missingSidechain)).toThrow(/sidechain .* invalid/i);
  });
});
