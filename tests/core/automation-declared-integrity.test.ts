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
  type Actor,
  type AIMuseProject,
  type AutomationLane,
  type AutomationPoint,
  type Device,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-automation-declared', kind: 'agent', name: 'Automation Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-automation-declared', kind: 'human', name: 'Automation Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Automation declared integrity', createdAt: nowIso(), operations };
}

function point(overrides: Record<string, unknown> = {}): AutomationPoint {
  return { ...entityBase('point', AGENT), tick: 120, value: 0.5, curve: 'linear', ...overrides } as AutomationPoint;
}

function lane(trackId: string, points: AutomationPoint[] = [], overrides: Record<string, unknown> = {}): AutomationLane {
  return {
    ...entityBase('lane', AGENT), trackId, target: { kind: 'track', parameter: 'gainDb' },
    points: Object.fromEntries(points.map((value) => [value.id, value])), pointOrder: points.map((value) => value.id),
    armed: false, visible: true, ...overrides,
  } as AutomationLane;
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

function populatedProject(): { project: AIMuseProject; sourceTrack: Track; destinationTrack: Track; automatedDevice: Device; automationLane: AutomationLane; early: AutomationPoint } {
  const base = createProject('song', 'Automation declared values', AGENT);
  const sourceTrack = base.tracks[base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!];
  const destinationTrack = { ...createTrack('aux', 'Destination', '#a78bfa', AGENT), id: 'u'.repeat(240) };
  const automatedDevice = device(sourceTrack.id);
  const early = point({ id: 'p' });
  const late = point({ id: 'q'.repeat(240), tick: 960, value: 0.8 });
  const automationLane = lane(sourceTrack.id, [early, late], { target: { kind: 'device', deviceId: automatedDevice.id, parameterId: 'gain' } });
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: destinationTrack },
    { kind: 'device.add', device: automatedDevice },
    { kind: 'automation.lane.add', lane: automationLane },
  ]), { authenticatedActor: AGENT }).project;
  return { project, sourceTrack, destinationTrack, automatedDevice, automationLane, early };
}

function assignStoredLane(project: AIMuseProject, laneId: string, changes: Record<string, unknown>): void {
  const value = project.automationLanes[laneId];
  const nextTrackId = changes.trackId;
  if (Object.prototype.hasOwnProperty.call(changes, 'trackId') && nextTrackId !== value.trackId) {
    project.tracks[value.trackId].automationLaneIds = project.tracks[value.trackId].automationLaneIds.filter((id) => id !== value.id);
    if (typeof nextTrackId === 'string' && project.tracks[nextTrackId]) project.tracks[nextTrackId].automationLaneIds.push(value.id);
  }
  Object.assign(value as unknown as Record<string, unknown>, changes);
}

describe('automation lane and point declared-value integrity', () => {
  it('preserves exact boundaries, independent targets, attribution and semantic inverses', () => {
    const base = createProject('song', 'Automation declared boundary lifecycle', AGENT);
    const destinationTrack = { ...createTrack('aux', 'Boundary destination', '#14b8a6', AGENT), id: 't'.repeat(240) };
    const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'track.add', track: destinationTrack }]), { authenticatedActor: AGENT }).project;
    const before = project;
    const boundaryPoint = point({ id: 'p'.repeat(240), tick: Number.MAX_SAFE_INTEGER, value: Number.MAX_VALUE, curve: 'bezier', tension: 1 });
    const boundaryLane = lane(destinationTrack.id, [boundaryPoint], { target: { kind: 'track', parameter: 'pan' }, armed: true, visible: false });

    const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: boundaryLane }]), { authenticatedActor: AGENT });
    expect(() => validateProject(committed.project)).not.toThrow();
    validateProjectIntegrity(committed.project);
    expect(committed.project.automationLanes[boundaryLane.id]).toMatchObject({
      trackId: destinationTrack.id, target: { kind: 'track', parameter: 'pan' }, armed: true, visible: false,
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id,
    });
    expect(committed.project.automationLanes[boundaryLane.id].points[boundaryPoint.id]).toMatchObject({
      tick: Number.MAX_SAFE_INTEGER, value: Number.MAX_VALUE, curve: 'bezier', tension: 1,
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id,
    });

    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo automation lane registration', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(before));
  });

  it('accepts declared values and rejects malformed stored, incoming, mutation-target and cleanup data', () => {
    const { project, sourceTrack, destinationTrack, automatedDevice, automationLane, early } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const acceptedLaneCases: Array<Record<string, unknown>> = [
      { trackId: destinationTrack.id, target: { kind: 'track', parameter: 'gainDb' } },
      { target: { kind: 'track', parameter: 'gainDb' } }, { target: { kind: 'track', parameter: 'pan' } },
      { target: { kind: 'device', deviceId: automatedDevice.id, parameterId: 'p' } },
      { target: { kind: 'device', deviceId: automatedDevice.id, parameterId: 'p'.repeat(500) } },
      { points: {}, pointOrder: [] },
      { armed: false }, { armed: true }, { visible: false }, { visible: true },
    ];
    for (const changes of acceptedLaneCases) {
      const stored = structuredClone(project);
      assignStoredLane(stored, automationLane.id, changes);
      expect(() => validateProject(stored)).not.toThrow();
      validateProjectIntegrity(stored);

      const incoming = lane(sourceTrack.id, [], changes);
      const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: incoming }]), { authenticatedActor: AGENT });
      validateProjectIntegrity(committed.project);
    }

    const acceptedPointCases: Array<Record<string, unknown>> = [
      { tick: 0 }, { tick: Number.MAX_SAFE_INTEGER },
      { value: -Number.MAX_VALUE }, { value: Number.MAX_VALUE },
      { curve: 'hold' }, { curve: 'linear' }, { curve: 'bezier' },
      { tension: -1 }, { tension: 1 }, { tension: undefined },
    ];
    for (const changes of acceptedPointCases) {
      const stored = structuredClone(project);
      Object.assign(stored.automationLanes[automationLane.id].points[early.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).not.toThrow();
      validateProjectIntegrity(stored);

      const incoming = point(changes);
      const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: incoming }]), { authenticatedActor: AGENT });
      validateProjectIntegrity(committed.project);
    }

    const invalidLaneCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { armed: 'yes' }, message: /invalid state flags/i },
      { changes: { armed: undefined }, message: /invalid state flags/i },
      { changes: { visible: 'yes' }, message: /invalid state flags/i },
      { changes: { visible: undefined }, message: /invalid state flags/i },
      { changes: { trackId: '' }, message: /invalid track ID/i },
      { changes: { trackId: 't'.repeat(241) }, message: /invalid track ID/i },
      { changes: { trackId: 42 }, message: /invalid track ID/i },
      { changes: { target: null }, message: /invalid target/i },
      { changes: { target: { kind: 'unknown' } }, message: /invalid target/i },
      { changes: { target: { kind: 'track', parameter: 'volume' } }, message: /invalid target/i },
      { changes: { target: { kind: 'device', deviceId: '', parameterId: 'gain' } }, message: /invalid target/i },
      { changes: { target: { kind: 'device', deviceId: automatedDevice.id, parameterId: '' } }, message: /invalid target/i },
      { changes: { target: { kind: 'device', deviceId: automatedDevice.id, parameterId: 'p'.repeat(501) } }, message: /invalid target/i },
      { changes: { points: null }, message: /invalid point record/i },
      { changes: { points: [] }, message: /invalid point record/i },
      { changes: { points: { '': point() }, pointOrder: [''] }, message: /invalid point record/i },
      { changes: { points: { ['p'.repeat(241)]: point() }, pointOrder: ['p'.repeat(241)] }, message: /invalid point record/i },
      { changes: { pointOrder: 'point' }, message: /invalid point order/i },
      { changes: { pointOrder: [''] }, message: /invalid point order/i },
      { changes: { pointOrder: [42] }, message: /invalid point order/i },
    ];
    for (const { changes, message } of invalidLaneCases) {
      const stored = structuredClone(project);
      assignStoredLane(stored, automationLane.id, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incoming = lane(sourceTrack.id, [], changes);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: incoming }]), { authenticatedActor: AGENT })).toThrow(message);
    }

    const invalidPointCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { tick: -1 }, message: /invalid tick/i },
      { changes: { tick: 0.5 }, message: /invalid tick/i },
      { changes: { tick: Number.MAX_SAFE_INTEGER + 1 }, message: /invalid tick/i },
      { changes: { tick: Number.NaN }, message: /invalid tick/i },
      { changes: { value: Number.NaN }, message: /invalid value/i },
      { changes: { value: Number.POSITIVE_INFINITY }, message: /invalid value/i },
      { changes: { value: 'loud' }, message: /invalid value/i },
      { changes: { curve: 'step' }, message: /invalid curve/i },
      { changes: { curve: 42 }, message: /invalid curve/i },
      { changes: { tension: -1.1 }, message: /invalid tension/i },
      { changes: { tension: 1.1 }, message: /invalid tension/i },
      { changes: { tension: Number.NaN }, message: /invalid tension/i },
      { changes: { tension: 'tight' }, message: /invalid tension/i },
    ];
    for (const { changes, message } of invalidPointCases) {
      const stored = structuredClone(project);
      Object.assign(stored.automationLanes[automationLane.id].points[early.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incomingPoint = point(changes);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: incomingPoint }]), { authenticatedActor: AGENT })).toThrow(message);
      const incomingLane = lane(sourceTrack.id, [incomingPoint]);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'automation.lane.add', lane: incomingLane }]), { authenticatedActor: AGENT })).toThrow(message);
    }

    const corruptedLaneOperations: ProjectOperation[] = [
      { kind: 'automation.lane.update', laneId: automationLane.id, changes: { visible: false } },
      { kind: 'automation.lane.delete', laneId: automationLane.id },
      { kind: 'automation.point.upsert', laneId: automationLane.id, point: point() },
      { kind: 'automation.point.delete', laneId: automationLane.id, pointId: early.id },
      { kind: 'track.delete', trackId: sourceTrack.id, cascade: true },
    ];
    for (const operation of corruptedLaneOperations) {
      const corrupted = structuredClone(project);
      (corrupted.automationLanes[automationLane.id] as unknown as { armed: unknown }).armed = 'yes';
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid state flags/i);
      expect(corrupted).toEqual(before);
    }

    const corruptedPointOperations: ProjectOperation[] = [
      { kind: 'automation.lane.update', laneId: automationLane.id, changes: { visible: false } },
      { kind: 'automation.lane.delete', laneId: automationLane.id },
      { kind: 'automation.point.upsert', laneId: automationLane.id, point: point() },
      { kind: 'automation.point.delete', laneId: automationLane.id, pointId: early.id },
      { kind: 'track.delete', trackId: sourceTrack.id, cascade: true },
      { kind: 'device.delete', deviceId: automatedDevice.id },
    ];
    for (const operation of corruptedPointOperations) {
      const corrupted = structuredClone(project);
      (corrupted.automationLanes[automationLane.id].points[early.id] as unknown as { curve: unknown }).curve = 'step';
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid curve/i);
      expect(corrupted).toEqual(before);
    }
    expect(project).toEqual(original);
  });
});
