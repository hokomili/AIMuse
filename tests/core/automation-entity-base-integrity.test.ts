import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type AutomationLane,
  type AutomationPoint,
  type Device,
  type EntityBase,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-automation-entity-base', kind: 'agent', name: 'Automation Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-automation-entity-base', kind: 'human', name: 'Automation Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Automation entity metadata integrity', createdAt: nowIso(), operations };
}

function point(tick: number, value: number): AutomationPoint {
  return { ...entityBase('point', AGENT), tick, value, curve: 'linear' };
}

function lane(trackId: string, points: AutomationPoint[] = [], deviceId?: string): AutomationLane {
  return {
    ...entityBase('lane', AGENT),
    trackId,
    target: deviceId === undefined ? { kind: 'track', parameter: 'gainDb' } : { kind: 'device', deviceId, parameterId: 'gain' },
    points: Object.fromEntries(points.map((value) => [value.id, value])),
    pointOrder: points.map((value) => value.id),
    armed: false,
    visible: true,
  };
}

function device(trackId: string): Device {
  return {
    ...entityBase('device', AGENT), trackId, format: 'builtin', builtinKind: 'utility', name: 'Automation Utility',
    bypassed: false, degraded: false, latencySamples: 0,
    parameters: { gain: { id: 'gain', name: 'Gain', value: 0, defaultValue: 0, min: -1, max: 1, automatable: true } },
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo automation entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; trackId: string; automationLane: AutomationLane; early: AutomationPoint; late: AutomationPoint } {
  const base = createProject('song', 'Automation EntityBase values', AGENT);
  const trackId = base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!;
  const early = point(120, 0.2);
  const late = point(960, 0.8);
  const automationLane = lane(trackId, [late, early]);
  const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'automation.lane.add', lane: automationLane }], AGENT), { authenticatedActor: AGENT }).project;
  return { project, trackId, automationLane, early, late };
}

function assignLaneBoundary(project: AIMuseProject, laneId: string, changes: Partial<EntityBase>): void {
  const automationLane = project.automationLanes[laneId];
  if (changes.id !== undefined && changes.id !== laneId) {
    const track = project.tracks[automationLane.trackId];
    track.automationLaneIds = track.automationLaneIds.map((id) => id === laneId ? changes.id! : id);
    delete project.automationLanes[laneId];
    project.automationLanes[changes.id] = automationLane;
  }
  Object.assign(automationLane, changes);
}

describe('automation lane and point EntityBase declared metadata integrity', () => {
  it('preserves attribution, explicit and chronological point order, values and semantic operation inverses', () => {
    let project = createProject('song', 'Automation EntityBase lifecycles', AGENT);
    const trackId = project.trackOrder.find((id) => project.tracks[id].kind === 'instrument')!;
    const late = point(960, 0.8);
    const early = point(120, 0.2);
    const automationLane = lane(trackId, [late, early]);

    project = commitAndVerifyInverse(project, [{ kind: 'automation.lane.add', lane: automationLane }]);
    expect(project.automationLanes[automationLane.id]).toMatchObject({
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id, pointOrder: [late.id, early.id],
    });
    expect(project.automationLanes[automationLane.id].points[late.id]).toMatchObject({
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id, tick: 960, value: 0.8, curve: 'linear',
    });

    project = commitAndVerifyInverse(project, [{
      kind: 'automation.lane.update', laneId: automationLane.id, changes: { armed: true, visible: false }, expectedRevision: project.automationLanes[automationLane.id].revision,
    }], REVIEWER);
    expect(project.automationLanes[automationLane.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, armed: true, visible: false });

    const middle = point(480, 0.5);
    project = commitAndVerifyInverse(project, [{
      kind: 'automation.point.upsert', laneId: automationLane.id, point: middle, expectedRevision: project.automationLanes[automationLane.id].revision,
    }], REVIEWER);
    expect(project.automationLanes[automationLane.id].pointOrder).toEqual([early.id, middle.id, late.id]);
    expect(project.automationLanes[automationLane.id].points[middle.id]).toMatchObject({ revision: 0, createdBy: REVIEWER.id, updatedBy: REVIEWER.id, tick: 480, value: 0.5 });

    project = commitAndVerifyInverse(project, [{
      kind: 'automation.point.upsert', laneId: automationLane.id, point: { ...middle, tick: 1_440, value: 0.6 }, expectedRevision: project.automationLanes[automationLane.id].revision,
    }], REVIEWER);
    expect(project.automationLanes[automationLane.id].pointOrder).toEqual([early.id, late.id, middle.id]);
    expect(project.automationLanes[automationLane.id].points[middle.id]).toMatchObject({ revision: 1, updatedBy: REVIEWER.id, tick: 1_440, value: 0.6 });

    project = commitAndVerifyInverse(project, [{
      kind: 'automation.point.delete', laneId: automationLane.id, pointId: late.id, expectedRevision: project.automationLanes[automationLane.id].revision,
    }], REVIEWER);
    expect(project.automationLanes[automationLane.id].pointOrder).toEqual([early.id, middle.id]);
    project = commitAndVerifyInverse(project, [{
      kind: 'automation.lane.delete', laneId: automationLane.id, expectedRevision: project.automationLanes[automationLane.id].revision,
    }], REVIEWER);
    expect(project.automationLanes[automationLane.id]).toBeUndefined();
    expect(project.tracks[trackId].automationLaneIds).not.toContain(automationLane.id);
  });

  it('accepts exact independent boundaries and rejects malformed stored, incoming, existing-target and cleanup metadata', () => {
    const { project, trackId, automationLane, early, late } = populatedProject();
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
    for (const changes of acceptedCases) {
      const acceptedLane = structuredClone(project);
      assignLaneBoundary(acceptedLane, automationLane.id, changes);
      validateProjectIntegrity(acceptedLane);

      const acceptedPoint = structuredClone(project);
      Object.assign(acceptedPoint.automationLanes[automationLane.id].points[early.id], changes);
      validateProjectIntegrity(acceptedPoint);
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
      const invalidLane = structuredClone(project);
      Object.assign(invalidLane.automationLanes[automationLane.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidLane)).toThrow(message);

      const invalidPoint = structuredClone(project);
      Object.assign(invalidPoint.automationLanes[automationLane.id].points[early.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidPoint)).toThrow(message);

      const incomingLane = { ...lane(trackId), ...changes } as unknown as AutomationLane;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: incomingLane }], AGENT), { authenticatedActor: AGENT })).toThrow(message);

      const incomingNestedPoint = { ...point(240, 0.4), ...changes } as unknown as AutomationPoint;
      const laneWithIncomingPoint = lane(trackId, [incomingNestedPoint]);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: laneWithIncomingPoint }], AGENT), { authenticatedActor: AGENT })).toThrow(message);

      const incomingPoint = { ...point(240, 0.4), ...changes } as unknown as AutomationPoint;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: incomingPoint }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidLaneOperations: ProjectOperation[] = [
      { kind: 'automation.lane.update', laneId: automationLane.id, changes: { armed: true } },
      { kind: 'automation.lane.delete', laneId: automationLane.id },
      { kind: 'automation.point.upsert', laneId: automationLane.id, point: point(240, 0.4) },
      { kind: 'automation.point.delete', laneId: automationLane.id, pointId: early.id },
    ];
    for (const operation of invalidLaneOperations) {
      const invalid = structuredClone(project);
      invalid.automationLanes[automationLane.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidPointOperations: ProjectOperation[] = [
      { kind: 'automation.lane.update', laneId: automationLane.id, changes: { visible: false } },
      { kind: 'automation.lane.delete', laneId: automationLane.id },
      { kind: 'automation.point.upsert', laneId: automationLane.id, point: { ...early, tick: 240 } },
      { kind: 'automation.point.delete', laneId: automationLane.id, pointId: early.id },
    ];
    for (const operation of invalidPointOperations) {
      const invalid = structuredClone(project);
      invalid.automationLanes[automationLane.id].points[early.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidCarriedPoint = structuredClone(project);
    invalidCarriedPoint.automationLanes[automationLane.id].points[late.id].revision = -1;
    expect(() => applyProjectTransaction(invalidCarriedPoint, transaction(invalidCarriedPoint.id, [{
      kind: 'automation.point.upsert', laneId: automationLane.id, point: point(240, 0.4),
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);

    const invalidTrackCleanup = structuredClone(project);
    invalidTrackCleanup.automationLanes[automationLane.id].points[early.id].revision = -1;
    expect(() => applyProjectTransaction(invalidTrackCleanup, transaction(invalidTrackCleanup.id, [{
      kind: 'track.delete', trackId, cascade: true,
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);

    const deviceBase = createProject('song', 'Automation device cleanup', AGENT);
    const deviceTrackId = deviceBase.trackOrder.find((id) => deviceBase.tracks[id].kind === 'instrument')!;
    const automatedDevice = device(deviceTrackId);
    const deviceLane = lane(deviceTrackId, [point(240, 0.4)], automatedDevice.id);
    const deviceProject = applyProjectTransaction(deviceBase, transaction(deviceBase.id, [
      { kind: 'device.add', device: automatedDevice }, { kind: 'automation.lane.add', lane: deviceLane },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const invalidDeviceCleanup = structuredClone(deviceProject);
    invalidDeviceCleanup.automationLanes[deviceLane.id].points[deviceLane.pointOrder[0]].revision = -1;
    const invalidDeviceCleanupOriginal = structuredClone(invalidDeviceCleanup);
    expect(() => applyProjectTransaction(invalidDeviceCleanup, transaction(invalidDeviceCleanup.id, [{
      kind: 'device.delete', deviceId: automatedDevice.id,
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    expect(invalidDeviceCleanup).toEqual(invalidDeviceCleanupOriginal);
    expect(project).toEqual(original);
  });
});
