import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  entityBase,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  validateTransaction,
  type Actor,
  type AIMuseProject,
  type Marker,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-marker-range', kind: 'agent', name: 'Marker Range Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-marker-range', kind: 'human', name: 'Marker Range Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Marker range integrity', createdAt: nowIso(), operations };
}

function marker(overrides: Record<string, unknown> = {}): Marker {
  return {
    ...entityBase('marker', AGENT),
    tick: 120,
    name: 'Declared marker range',
    color: '',
    kind: 'marker',
    ...overrides,
  } as Marker;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  validateProjectIntegrity(committed.project);
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo marker range operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

describe('marker range declared-value integrity', () => {
  it('preserves exact independent endpoints, explicit order, equal ticks, attribution and semantic inverses', () => {
    const base = createProject('song', 'Marker range boundaries', AGENT);
    const fullRange = marker({ name: 'Full declared range', tick: 0, endTick: Number.MAX_SAFE_INTEGER, kind: 'marker' });
    const equalTick = marker({ name: 'Equal tick cue', tick: 0, kind: 'cue' });
    const upperPoint = marker({ name: 'Upper endpoint region', tick: Number.MAX_SAFE_INTEGER, kind: 'region' });

    let project = commitAndVerifyInverse(base, [
      { kind: 'marker.add', marker: fullRange },
      { kind: 'marker.add', marker: upperPoint, index: 0 },
      { kind: 'marker.add', marker: equalTick, index: 1 },
    ]);
    expect(project.markerOrder).toEqual([upperPoint.id, equalTick.id, fullRange.id]);
    expect(project.markers[fullRange.id]).toMatchObject({
      tick: 0,
      endTick: Number.MAX_SAFE_INTEGER,
      kind: 'marker',
      createdBy: AGENT.id,
      updatedBy: AGENT.id,
    });
    expect(project.markers[upperPoint.id]).toMatchObject({ tick: Number.MAX_SAFE_INTEGER, kind: 'region' });

    project = commitAndVerifyInverse(project, [{
      kind: 'marker.update',
      markerId: upperPoint.id,
      changes: { tick: Number.MAX_SAFE_INTEGER - 1, endTick: Number.MAX_SAFE_INTEGER, kind: 'marker' },
    }], REVIEWER);
    expect(project.markerOrder).toEqual([upperPoint.id, equalTick.id, fullRange.id]);
    expect(project.markers[upperPoint.id]).toMatchObject({
      tick: Number.MAX_SAFE_INTEGER - 1,
      endTick: Number.MAX_SAFE_INTEGER,
      createdBy: AGENT.id,
      updatedBy: REVIEWER.id,
      revision: 1,
    });

    project = commitAndVerifyInverse(project, [{ kind: 'marker.delete', markerId: equalTick.id }], REVIEWER);
    expect(project.markerOrder).toEqual([upperPoint.id, fullRange.id]);
    expect(project.markers[equalTick.id]).toBeUndefined();
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects malformed stored, incoming, update, corrupt-target and delete values with established precedence', () => {
    const base = createProject('song', 'Marker range rejection', AGENT);
    const current = marker({ name: 'Current point marker' });
    const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'marker.add', marker: current }]), { authenticatedActor: AGENT }).project;
    const original = structuredClone(project);
    const invalidCases: Array<Record<string, unknown>> = [
      { tick: Number.MAX_SAFE_INTEGER + 1 },
      { tick: -1 },
      { tick: 0.5 },
      { tick: Number.NaN },
      { tick: Number.POSITIVE_INFINITY },
      { tick: 'tick' },
      { endTick: Number.MAX_SAFE_INTEGER + 1 },
      { endTick: -1 },
      { endTick: 120 },
      { endTick: 119 },
      { endTick: 120.5 },
      { endTick: Number.NaN },
      { endTick: Number.POSITIVE_INFINITY },
      { endTick: 'end' },
    ];

    for (const changes of invalidCases) {
      const caseLabel = JSON.stringify(changes);
      const stored = structuredClone(project);
      Object.assign(stored.markers[current.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored), caseLabel).toThrow();
      expect(() => validateProjectIntegrity(stored), caseLabel).toThrow(/invalid range/i);

      const incoming = marker({ id: createId('marker'), name: 'Rejected marker range', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.add', marker: incoming }]), { authenticatedActor: AGENT }), caseLabel).toThrow(/invalid range/i);
      const update = { kind: 'marker.update', markerId: current.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [update], REVIEWER), { authenticatedActor: REVIEWER }), caseLabel).toThrow(/invalid range/i);
    }

    const strictUnsafeUpdate = transaction(project.id, [{
      kind: 'marker.update',
      markerId: current.id,
      changes: { tick: Number.MAX_SAFE_INTEGER + 1 },
    }], REVIEWER);
    expect(() => validateTransaction(strictUnsafeUpdate)).toThrow();
    expect(() => applyProjectTransaction(project, strictUnsafeUpdate, { authenticatedActor: REVIEWER })).toThrow(/invalid range/i);

    for (const operation of [
      { kind: 'marker.update', markerId: current.id, changes: { tick: 240, endTick: 480 } },
      { kind: 'marker.delete', markerId: current.id },
    ] as ProjectOperation[]) {
      const corrupted = structuredClone(project);
      corrupted.markers[current.id].tick = Number.MAX_SAFE_INTEGER + 1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid range/i);
      expect(corrupted).toEqual(before);
    }

    const invalidEntity = marker({ id: '', tick: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.add', marker: invalidEntity }]), { authenticatedActor: AGENT })).toThrow(/invalid entity id/i);
    const duplicate = marker({ id: current.id, tick: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.add', marker: duplicate }]), { authenticatedActor: AGENT })).toThrow(/already exists/i);
    const invalidText = marker({ id: createId('marker'), name: '', tick: Number.MAX_SAFE_INTEGER + 1 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.add', marker: invalidText }]), { authenticatedActor: AGENT })).toThrow(/invalid text/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.update', markerId: current.id, changes: { name: '', tick: Number.MAX_SAFE_INTEGER + 1 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid text/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.update', markerId: 'missing-marker', changes: { tick: Number.MAX_SAFE_INTEGER + 1 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/does not exist/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'marker.update', markerId: current.id, expectedRevision: 99, changes: { tick: Number.MAX_SAFE_INTEGER + 1 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/changed from revision/i);

    const invalidOrder = structuredClone(project);
    invalidOrder.markers[current.id].tick = Number.MAX_SAFE_INTEGER + 1;
    invalidOrder.markerOrder.push(current.id);
    expect(() => validateProjectIntegrity(invalidOrder)).toThrow(/order is incomplete or contains duplicates/i);
    expect(project).toEqual(original);
  });
});
