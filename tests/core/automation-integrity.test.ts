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
  type AutomationLane,
  type AutomationPoint,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-automation', kind: 'agent', name: 'Automation Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };

function transaction(projectId: string, operations: ProjectOperation[]): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor: AGENT, label: 'Automation integrity', createdAt: nowIso(), operations };
}

function point(tick: number, value: number): AutomationPoint {
  return { ...entityBase('point', AGENT), tick, value, curve: 'linear' };
}

function lane(trackId: string): AutomationLane {
  return { ...entityBase('lane', AGENT), trackId, target: { kind: 'track', parameter: 'gainDb' }, points: {}, pointOrder: [], armed: false, visible: true };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[]) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations), { authenticatedActor: AGENT });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, AGENT, 'Undo automation operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

describe('automation reducer integrity', () => {
  it('keeps lane/point lifecycle operations reversible with exact ordered ownership', () => {
    let project = createProject('song', 'Automation inverses');
    const track = project.tracks[project.trackOrder[0]];
    const automationLane = lane(track.id);
    const late = point(960, 0.8);
    const early = point(120, 0.2);

    project = commitAndVerifyInverse(project, [{ kind: 'automation.lane.add', lane: automationLane }]);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: late }]);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: early }]);
    expect(project.automationLanes[automationLane.id].pointOrder).toEqual([early.id, late.id]);
    expect(project.automationLanes[automationLane.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: AGENT.id });
    expect(project.automationLanes[automationLane.id].points[early.id].createdBy).toBe(AGENT.id);

    project = commitAndVerifyInverse(project, [{ kind: 'automation.point.upsert', laneId: automationLane.id, point: { ...early, tick: 1_440, value: 0.6 } }]);
    expect(project.automationLanes[automationLane.id].pointOrder).toEqual([late.id, early.id]);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.point.delete', laneId: automationLane.id, pointId: late.id }]);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.lane.update', laneId: automationLane.id, changes: { armed: true, visible: false } }]);
    project = commitAndVerifyInverse(project, [{ kind: 'automation.lane.delete', laneId: automationLane.id }]);
    expect(project.automationLanes[automationLane.id]).toBeUndefined();
    expect(project.tracks[track.id].automationLaneIds).not.toContain(automationLane.id);
  });

  it('rejects orphaned, duplicate, incomplete and missing-target automation references', () => {
    const base = createProject('song', 'Automation integrity');
    const track = base.tracks[base.trackOrder[0]];
    const automationLane = lane(track.id);
    const populated = applyProjectTransaction(base, transaction(base.id, [{ kind: 'automation.lane.add', lane: automationLane }]), { authenticatedActor: AGENT }).project;

    const orphaned = structuredClone(populated);
    orphaned.tracks[track.id].automationLaneIds = [];
    expect(() => validateProjectIntegrity(orphaned)).toThrow(/automation lane .* orphaned/i);

    const duplicate = structuredClone(populated);
    duplicate.tracks[track.id].automationLaneIds.push(automationLane.id);
    expect(() => validateProjectIntegrity(duplicate)).toThrow(/duplicate automation lane/i);

    const incompleteOrder = structuredClone(populated);
    const unlisted = point(240, 0.5);
    incompleteOrder.automationLanes[automationLane.id].points[unlisted.id] = unlisted;
    expect(() => validateProjectIntegrity(incompleteOrder)).toThrow(/invalid point order/i);

    const missingTarget = structuredClone(populated);
    missingTarget.automationLanes[automationLane.id].target = { kind: 'device', deviceId: 'missing-device', parameterId: 'gain' };
    expect(() => validateProjectIntegrity(missingTarget)).toThrow(/targets a missing device/i);
  });
});
