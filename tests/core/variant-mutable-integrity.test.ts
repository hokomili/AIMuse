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
  type Checkpoint,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
  type Variant,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-variant-mutable', kind: 'agent', name: 'Variant Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-variant-reviewer', kind: 'agent', name: 'Variant Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Variant mutable integrity', createdAt: nowIso(), operations };
}

function snapshot(name: string): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'checkpoint', name, mimeType: 'application/json', sha256: 'f'.repeat(64), byteLength: 64,
    storage: 'embedded', source: 'system',
  };
}

function checkpoint(snapshotAssetId: string): Checkpoint {
  return { ...entityBase('checkpoint', AGENT), name: 'Base checkpoint', projectRevision: 0, snapshotAssetId, automatic: false };
}

function variant(baseCheckpointId: string, snapshotAssetId?: string): Variant {
  return { ...entityBase('variant', AGENT), name: 'Variant', baseCheckpointId, snapshotAssetId, status: 'active', projectRevision: 0 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo variant mutable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Variant mutable values');
  const baseSnapshot = snapshot('Base snapshot');
  const alternateSnapshot = snapshot('Alternate snapshot');
  const history = checkpoint(baseSnapshot.id);
  const alternate = variant(history.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'asset.add', asset: baseSnapshot }, { kind: 'asset.add', asset: alternateSnapshot },
    { kind: 'checkpoint.register', checkpoint: history }, { kind: 'variant.register', variant: alternate },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, baseSnapshot, alternateSnapshot, history, alternate };
}

describe('variant mutable declared-value integrity', () => {
  it('preserves history relationships, attribution and semantic inverses across register and update', () => {
    let project = createProject('song', 'Variant mutable lifecycles');
    const baseSnapshot = snapshot('Base snapshot');
    const alternateSnapshot = snapshot('Alternate snapshot');
    const history = checkpoint(baseSnapshot.id);
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'asset.add', asset: baseSnapshot }, { kind: 'asset.add', asset: alternateSnapshot },
      { kind: 'checkpoint.register', checkpoint: history },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const alternate = variant(history.id);
    project = commitAndVerifyInverse(project, [{ kind: 'variant.register', variant: alternate }]);
    const createdAt = project.variants[alternate.id].createdAt;

    project = commitAndVerifyInverse(project, [{
      kind: 'variant.update', variantId: alternate.id,
      changes: { name: 'V'.repeat(500), status: 'merged', projectRevision: 42, snapshotAssetId: alternateSnapshot.id },
      expectedRevision: project.variants[alternate.id].revision,
    }], REVIEWER);
    expect(project.variants[alternate.id]).toMatchObject({
      name: 'V'.repeat(500), status: 'merged', projectRevision: 42, snapshotAssetId: alternateSnapshot.id,
      baseCheckpointId: history.id, createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
  });

  it('accepts exact declared values and rejects malformed mutable fields before mutation', () => {
    const { project, alternate } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    for (const status of ['active', 'merged', 'discarded'] as const) {
      const accepted = structuredClone(project);
      accepted.variants[alternate.id].status = status;
      validateProjectIntegrity(accepted);
    }
    const clearedSnapshot = applyProjectTransaction(project, transaction(project.id, [{
      kind: 'variant.update', variantId: alternate.id, changes: { snapshotAssetId: undefined },
      expectedRevision: project.variants[alternate.id].revision,
    }], REVIEWER), { authenticatedActor: REVIEWER });
    expect(clearedSnapshot.project.variants[alternate.id].snapshotAssetId).toBeUndefined();

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { name: '' }, message: /invalid name/i },
      { changes: { name: 'n'.repeat(501) }, message: /invalid name/i },
      { changes: { name: 42 }, message: /invalid name/i },
      { changes: { status: 'archived' }, message: /invalid status/i },
      { changes: { projectRevision: -1 }, message: /invalid project revision/i },
      { changes: { projectRevision: 0.5 }, message: /invalid project revision/i },
      { changes: { projectRevision: Number.NaN }, message: /invalid project revision/i },
      { changes: { snapshotAssetId: '' }, message: /invalid snapshot asset ID/i },
      { changes: { snapshotAssetId: 's'.repeat(241) }, message: /invalid snapshot asset ID/i },
      { changes: { snapshotAssetId: 42 }, message: /invalid snapshot asset ID/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.variants[alternate.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = {
        kind: 'variant.update', variantId: alternate.id, changes, expectedRevision: project.variants[alternate.id].revision,
      } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidRegister = variant(alternate.baseCheckpointId);
    invalidRegister.name = '';
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'variant.register', variant: invalidRegister }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid name/i);
    expect(project).toEqual(original);
  });
});
