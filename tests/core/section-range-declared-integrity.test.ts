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
  type ProjectOperation,
  type ProjectTransaction,
  type SongSection,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-section-range', kind: 'agent', name: 'Section Range Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-section-range', kind: 'human', name: 'Section Range Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Section range integrity', createdAt: nowIso(), operations };
}

function section(overrides: Record<string, unknown> = {}): SongSection {
  return {
    ...entityBase('section', AGENT),
    name: 'Declared section range',
    startTick: 120,
    endTick: 1_080,
    color: '',
    ...overrides,
  } as SongSection;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  validateProjectIntegrity(committed.project);
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo section range operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

describe('section range declared-value integrity', () => {
  it('preserves exact endpoints, overlapping equal ranges, explicit order, attribution and semantic inverses', () => {
    const base = createProject('song', 'Section range boundaries', AGENT);
    const fullRange = section({ name: 'Full declared section', startTick: 0, endTick: Number.MAX_SAFE_INTEGER, energy: 0 });
    const equalRange = section({ name: 'Equal overlapping section', startTick: 0, endTick: Number.MAX_SAFE_INTEGER, energy: 1 });
    const upperRange = section({ name: 'Upper endpoint section', startTick: Number.MAX_SAFE_INTEGER - 1, endTick: Number.MAX_SAFE_INTEGER });

    let project = commitAndVerifyInverse(base, [
      { kind: 'section.add', section: fullRange },
      { kind: 'section.add', section: upperRange, index: 0 },
      { kind: 'section.add', section: equalRange, index: 1 },
    ]);
    expect(project.sectionOrder).toEqual([upperRange.id, equalRange.id, fullRange.id]);
    expect(project.sections[fullRange.id]).toMatchObject({
      startTick: 0,
      endTick: Number.MAX_SAFE_INTEGER,
      energy: 0,
      createdBy: AGENT.id,
      updatedBy: AGENT.id,
    });
    expect(project.sections[equalRange.id]).toMatchObject({ startTick: 0, endTick: Number.MAX_SAFE_INTEGER, energy: 1 });
    expect(project.sections[upperRange.id].energy).toBeUndefined();

    project = commitAndVerifyInverse(project, [{
      kind: 'section.update',
      sectionId: upperRange.id,
      changes: { name: 'Reviewed independent range', startTick: 0, endTick: 1, energy: 0.5 },
    }], REVIEWER);
    expect(project.sectionOrder).toEqual([upperRange.id, equalRange.id, fullRange.id]);
    expect(project.sections[upperRange.id]).toMatchObject({
      name: 'Reviewed independent range',
      startTick: 0,
      endTick: 1,
      energy: 0.5,
      createdBy: AGENT.id,
      updatedBy: REVIEWER.id,
      revision: 1,
    });

    project = commitAndVerifyInverse(project, [{ kind: 'section.delete', sectionId: equalRange.id }], REVIEWER);
    expect(project.sectionOrder).toEqual([upperRange.id, fullRange.id]);
    expect(project.sections[equalRange.id]).toBeUndefined();
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects malformed stored, incoming, update, corrupt-target and delete ranges with section diagnostics', () => {
    const base = createProject('song', 'Section range rejection', AGENT);
    const current = section({ name: 'Current section' });
    const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'section.add', section: current }]), { authenticatedActor: AGENT }).project;
    const original = structuredClone(project);
    const invalidCases: Array<Record<string, unknown>> = [
      { startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 },
      { startTick: 0, endTick: Number.MAX_SAFE_INTEGER + 1 },
      { startTick: -1, endTick: 1 },
      { startTick: 0.5, endTick: 1 },
      { startTick: Number.NaN, endTick: 1 },
      { startTick: Number.NEGATIVE_INFINITY, endTick: 1 },
      { startTick: 'start', endTick: 1 },
      { startTick: 120, endTick: -1 },
      { startTick: 120, endTick: 120 },
      { startTick: 120, endTick: 119 },
      { startTick: 120, endTick: 120.5 },
      { startTick: 120, endTick: Number.NaN },
      { startTick: 120, endTick: Number.POSITIVE_INFINITY },
      { startTick: 120, endTick: 'end' },
    ];

    for (const changes of invalidCases) {
      const caseLabel = JSON.stringify(changes);
      const stored = structuredClone(project);
      Object.assign(stored.sections[current.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored), caseLabel).toThrow();
      expect(() => validateProjectIntegrity(stored), caseLabel).toThrow(/section .* invalid range or energy/i);

      const incoming = section({ id: createId('section'), name: 'Rejected section range', ...changes });
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.add', section: incoming }]), { authenticatedActor: AGENT }), caseLabel).toThrow(/section .* invalid range or energy/i);
      const update = { kind: 'section.update', sectionId: current.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [update], REVIEWER), { authenticatedActor: REVIEWER }), caseLabel).toThrow(/section .* invalid range or energy/i);
    }

    const strictUnsafeUpdate = transaction(project.id, [{
      kind: 'section.update',
      sectionId: current.id,
      changes: { startTick: 0, endTick: Number.MAX_SAFE_INTEGER + 1 },
    }], REVIEWER);
    expect(() => validateTransaction(strictUnsafeUpdate)).toThrow();
    expect(() => applyProjectTransaction(project, strictUnsafeUpdate, { authenticatedActor: REVIEWER })).toThrow(/section .* invalid range or energy/i);

    for (const operation of [
      { kind: 'section.update', sectionId: current.id, changes: { startTick: 240, endTick: 480 } },
      { kind: 'section.delete', sectionId: current.id },
    ] as ProjectOperation[]) {
      const corrupted = structuredClone(project);
      corrupted.sections[current.id].startTick = Number.MAX_SAFE_INTEGER + 1;
      corrupted.sections[current.id].endTick = Number.MAX_SAFE_INTEGER + 3;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/section .* invalid range or energy/i);
      expect(corrupted).toEqual(before);
    }

    const invalidEntity = section({ id: '', startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.add', section: invalidEntity }]), { authenticatedActor: AGENT })).toThrow(/invalid entity id/i);
    const duplicate = section({ id: current.id, startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.add', section: duplicate }]), { authenticatedActor: AGENT })).toThrow(/already exists/i);
    const invalidText = section({ id: createId('section'), name: '', startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 });
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.add', section: invalidText }]), { authenticatedActor: AGENT })).toThrow(/invalid text/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.update', sectionId: current.id, changes: { name: '', startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid text/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.update', sectionId: 'missing-section', changes: { startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/does not exist/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'section.update', sectionId: current.id, expectedRevision: 99, changes: { startTick: Number.MAX_SAFE_INTEGER + 1, endTick: Number.MAX_SAFE_INTEGER + 3 } }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/changed from revision/i);

    const invalidOrder = structuredClone(project);
    invalidOrder.sections[current.id].startTick = Number.MAX_SAFE_INTEGER + 1;
    invalidOrder.sections[current.id].endTick = Number.MAX_SAFE_INTEGER + 3;
    invalidOrder.sectionOrder.push(current.id);
    expect(() => validateProjectIntegrity(invalidOrder)).toThrow(/order is incomplete or contains duplicates/i);
    expect(project).toEqual(original);
  });
});
