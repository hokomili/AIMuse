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
  type EntityBase,
  type ProjectOperation,
  type ProjectTransaction,
  type SfxDeliverable,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-sfx-entity-base', kind: 'agent', name: 'SFX Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-sfx-entity-base', kind: 'human', name: 'SFX Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'SFX deliverable entity metadata integrity', createdAt: nowIso(), operations };
}

function deliverable(overrides: Partial<SfxDeliverable> = {}): SfxDeliverable {
  return {
    ...entityBase('deliverable', AGENT), name: 'Impact', startTick: 0, endTick: 960, variantCount: 2, tags: ['impact'], seamlessLoop: false,
    tailMilliseconds: 250, variation: { seed: 7, pitchRangeSemitones: 2, gainRangeDb: 3, timingRangeMilliseconds: 25 },
    targetLufs: -16, namingTemplate: '{name}_{index}', exportFormat: 'wav', ...overrides,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo SFX deliverable entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('SFX deliverable EntityBase declared metadata integrity', () => {
  it('preserves normalized attribution, revisions, lifecycle and semantic inverses at exact valid boundaries', () => {
    let project = createProject('sfx', 'SFX deliverable EntityBase lifecycle', AGENT);
    const value = deliverable({
      id: 'd'.repeat(240),
      revision: 42,
      createdAt: '2026-08-08T01:02:03Z',
      updatedAt: '2026-08-07T01:02:03.123456Z',
      createdBy: 'c'.repeat(240),
      updatedBy: 'u'.repeat(240),
    });

    project = commitAndVerifyInverse(project, [{ kind: 'sfx-deliverable.add', deliverable: value }], AGENT);
    expect(project.sfxDeliverables[value.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    const createdAt = project.sfxDeliverables[value.id].createdAt;

    project = commitAndVerifyInverse(project, [{
      kind: 'sfx-deliverable.update', deliverableId: value.id, changes: { name: 'Reviewed impact' },
      expectedRevision: project.sfxDeliverables[value.id].revision,
    }], REVIEWER);
    expect(project.sfxDeliverables[value.id]).toMatchObject({ revision: 1, createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, name: 'Reviewed impact' });

    project = commitAndVerifyInverse(project, [{
      kind: 'sfx-deliverable.delete', deliverableId: value.id, expectedRevision: project.sfxDeliverables[value.id].revision,
    }], REVIEWER);
    expect(project.sfxDeliverables[value.id]).toBeUndefined();
  });

  it('accepts independent boundaries and rejects malformed stored, incoming, update-target and delete-target metadata', () => {
    const base = createProject('sfx', 'SFX deliverable EntityBase boundaries', AGENT);
    const value = deliverable();
    const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'sfx-deliverable.add', deliverable: value }], AGENT), { authenticatedActor: AGENT }).project;
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
      const stored = structuredClone(project);
      Object.assign(stored.sfxDeliverables[value.id], changes);
      validateProjectIntegrity(stored);

      const incoming = { ...deliverable(), ...changes } as SfxDeliverable;
      const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'sfx-deliverable.add', deliverable: incoming }], AGENT), { authenticatedActor: AGENT });
      validateProjectIntegrity(committed.project);
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
      const stored = structuredClone(project);
      Object.assign(stored.sfxDeliverables[value.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incoming = { ...deliverable(), ...changes } as unknown as SfxDeliverable;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'sfx-deliverable.add', deliverable: incoming }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    for (const operation of [
      { kind: 'sfx-deliverable.update', deliverableId: value.id, changes: { name: 'Reviewed impact' } },
      { kind: 'sfx-deliverable.delete', deliverableId: value.id },
    ] as ProjectOperation[]) {
      const corrupted = structuredClone(project);
      corrupted.sfxDeliverables[value.id].revision = -1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
      expect(corrupted).toEqual(before);
    }
    expect(project).toEqual(original);
  });
});
