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
  type ProjectOperation,
  type ProjectTransaction,
  type Send,
  type SidechainRoute,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-send-sidechain', kind: 'agent', name: 'Routing Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-send-sidechain-reviewer', kind: 'agent', name: 'Routing Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Send/sidechain value integrity', createdAt: nowIso(), operations };
}

function device(trackId: string): Device {
  return {
    ...entityBase('device', AGENT), trackId, format: 'builtin', builtinKind: 'utility', name: 'Sidechain Utility',
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
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo send/sidechain operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Send/sidechain values');
  const sourceTrack = base.tracks[base.trackOrder[0]];
  const masterId = base.trackOrder.find((id) => base.tracks[id].kind === 'master')!;
  const destinationTrack = createTrack('aux', 'Destination', '#14b8a6', AGENT);
  destinationTrack.routing.outputTrackId = masterId;
  const destinationDevice = device(destinationTrack.id);
  const routedSend = send(sourceTrack.id, destinationTrack.id);
  const route = sidechain(sourceTrack.id, destinationDevice.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: destinationTrack }, { kind: 'device.add', device: destinationDevice },
    { kind: 'send.upsert', send: routedSend }, { kind: 'sidechain.upsert', route },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, routedSend, route };
}

describe('send and sidechain declared-value integrity', () => {
  it('preserves attribution and semantic inverses across upsert and delete lifecycles', () => {
    let project = createProject('song', 'Send/sidechain lifecycles');
    const sourceTrack = project.tracks[project.trackOrder[0]];
    const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
    const destinationTrack = createTrack('aux', 'Destination', '#14b8a6', AGENT);
    destinationTrack.routing.outputTrackId = masterId;
    const destinationDevice = device(destinationTrack.id);
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: destinationTrack }, { kind: 'device.add', device: destinationDevice },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const routedSend = send(sourceTrack.id, destinationTrack.id);
    const route = sidechain(sourceTrack.id, destinationDevice.id);
    project = commitAndVerifyInverse(project, [{ kind: 'send.upsert', send: routedSend }, { kind: 'sidechain.upsert', route }]);
    const sendCreatedAt = project.sends[routedSend.id].createdAt;
    const routeCreatedAt = project.sidechains[route.id].createdAt;

    project = commitAndVerifyInverse(project, [
      {
        kind: 'send.upsert', send: { ...routedSend, gainDb: 24, preFader: true, enabled: false },
        expectedRevision: project.sends[routedSend.id].revision,
      },
      {
        kind: 'sidechain.upsert', route: { ...route, busIndex: 7, enabled: false },
        expectedRevision: project.sidechains[route.id].revision,
      },
    ], REVIEWER);
    expect(project.sends[routedSend.id]).toMatchObject({
      gainDb: 24, preFader: true, enabled: false, createdAt: sendCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.sidechains[route.id]).toMatchObject({
      busIndex: 7, enabled: false, createdAt: routeCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });

    project = commitAndVerifyInverse(project, [
      { kind: 'send.delete', sendId: routedSend.id, expectedRevision: project.sends[routedSend.id].revision },
      { kind: 'sidechain.delete', routeId: route.id, expectedRevision: project.sidechains[route.id].revision },
    ], REVIEWER);
    expect(project.sends[routedSend.id]).toBeUndefined();
    expect(project.sidechains[route.id]).toBeUndefined();
  });

  it('accepts exact bounds and rejects malformed gain, flags or bus indices before mutation', () => {
    const { project, routedSend, route } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);

    for (const gainDb of [-120, 24]) {
      const result = applyProjectTransaction(project, transaction(project.id, [{
        kind: 'send.upsert', send: { ...project.sends[routedSend.id], gainDb }, expectedRevision: project.sends[routedSend.id].revision,
      }], REVIEWER), { authenticatedActor: REVIEWER });
      expect(result.project.sends[routedSend.id].gainDb).toBe(gainDb);
    }
    const zeroBus = applyProjectTransaction(project, transaction(project.id, [{
      kind: 'sidechain.upsert', route: { ...project.sidechains[route.id], busIndex: 0 }, expectedRevision: project.sidechains[route.id].revision,
    }], REVIEWER), { authenticatedActor: REVIEWER });
    expect(zeroBus.project.sidechains[route.id].busIndex).toBe(0);

    const invalidSendCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { gainDb: -120.000_001 }, message: /invalid gain/i },
      { changes: { gainDb: 24.000_001 }, message: /invalid gain/i },
      { changes: { gainDb: Number.NaN }, message: /invalid gain/i },
      { changes: { preFader: 'yes' }, message: /invalid state flags/i },
      { changes: { enabled: 1 }, message: /invalid state flags/i },
    ];
    for (const { changes, message } of invalidSendCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.sends[routedSend.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const invalidSend = { ...project.sends[routedSend.id], ...changes } as unknown as Send;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{
        kind: 'send.upsert', send: invalidSend, expectedRevision: project.sends[routedSend.id].revision,
      }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidSidechainCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { busIndex: -1 }, message: /invalid bus index/i },
      { changes: { busIndex: 0.5 }, message: /invalid bus index/i },
      { changes: { busIndex: Number.NaN }, message: /invalid bus index/i },
      { changes: { enabled: 'yes' }, message: /invalid state flag/i },
    ];
    for (const { changes, message } of invalidSidechainCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.sidechains[route.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const invalidRoute = { ...project.sidechains[route.id], ...changes } as unknown as SidechainRoute;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{
        kind: 'sidechain.upsert', route: invalidRoute, expectedRevision: project.sidechains[route.id].revision,
      }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }
    expect(project).toEqual(original);
  });
});
