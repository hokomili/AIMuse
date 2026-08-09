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
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-checkpoint-value', kind: 'agent', name: 'Checkpoint Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-checkpoint-reviewer', kind: 'agent', name: 'Checkpoint Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Checkpoint value integrity', createdAt: nowIso(), operations };
}

function snapshot(id = createId('asset')): MediaAsset {
  return {
    ...entityBase('asset', AGENT),
    id,
    kind: 'checkpoint',
    name: 'Checkpoint snapshot',
    mimeType: 'application/json',
    sha256: 'c'.repeat(64),
    byteLength: 0,
    storage: 'embedded',
    source: 'system',
  };
}

function checkpoint(snapshotAssetId: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    ...entityBase('checkpoint', AGENT),
    name: 'Checkpoint',
    projectRevision: 0,
    snapshotAssetId,
    automatic: false,
    ...overrides,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo checkpoint operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('checkpoint declared-value integrity', () => {
  it('preserves declared values, attribution and semantic register/delete inverses', () => {
    let project = createProject('song', 'Checkpoint value lifecycles');
    const media = snapshot();
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'asset.add', asset: media }], AGENT), { authenticatedActor: AGENT }).project;
    const value = checkpoint(media.id, {
      name: 'n'.repeat(500),
      projectRevision: 0,
      automatic: true,
      reason: 'r'.repeat(2_000),
    });

    project = commitAndVerifyInverse(project, [{ kind: 'checkpoint.register', checkpoint: value }]);
    expect(project.checkpoints[value.id]).toMatchObject({
      name: 'n'.repeat(500),
      projectRevision: 0,
      snapshotAssetId: media.id,
      automatic: true,
      reason: 'r'.repeat(2_000),
      createdBy: AGENT.id,
      updatedBy: AGENT.id,
    });

    project = commitAndVerifyInverse(project, [{ kind: 'checkpoint.delete', checkpointId: value.id, expectedRevision: project.checkpoints[value.id].revision }], REVIEWER);
    expect(project.checkpoints[value.id]).toBeUndefined();
    expect(project.assets[media.id]).toBeDefined();
    expect(project.activity.at(-1)?.actor.id).toBe(REVIEWER.id);
  });

  it('accepts exact boundaries and rejects malformed register and stored values before reference lookup', () => {
    const shortIdMedia = snapshot('s');
    const longIdMedia = snapshot('s'.repeat(240));
    const base = createProject('song', 'Checkpoint value boundaries');
    let project = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'asset.add', asset: shortIdMedia },
      { kind: 'asset.add', asset: longIdMedia },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const existing = checkpoint(shortIdMedia.id);
    project = applyProjectTransaction(project, transaction(project.id, [{ kind: 'checkpoint.register', checkpoint: existing }], AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(project);
    const original = structuredClone(project);

    const accepted = [
      checkpoint(shortIdMedia.id, { name: 'n', projectRevision: 0, automatic: false, reason: '' }),
      checkpoint(longIdMedia.id, { name: 'n'.repeat(500), projectRevision: 42, automatic: true, reason: 'r'.repeat(2_000) }),
      checkpoint(shortIdMedia.id, { reason: undefined }),
    ];
    for (const value of accepted) {
      const result = applyProjectTransaction(project, transaction(project.id, [{ kind: 'checkpoint.register', checkpoint: value }], AGENT), { authenticatedActor: AGENT });
      validateProjectIntegrity(result.project);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { name: '' }, message: /invalid name/i },
      { changes: { name: 'n'.repeat(501) }, message: /invalid name/i },
      { changes: { name: 42 }, message: /invalid name/i },
      { changes: { projectRevision: -1 }, message: /invalid project revision/i },
      { changes: { projectRevision: 0.5 }, message: /invalid project revision/i },
      { changes: { projectRevision: Number.NaN }, message: /invalid project revision/i },
      { changes: { snapshotAssetId: '' }, message: /invalid snapshot asset ID/i },
      { changes: { snapshotAssetId: 's'.repeat(241) }, message: /invalid snapshot asset ID/i },
      { changes: { snapshotAssetId: 42 }, message: /invalid snapshot asset ID/i },
      { changes: { automatic: 'true' }, message: /invalid automatic value/i },
      { changes: { automatic: 1 }, message: /invalid automatic value/i },
      { changes: { reason: 'r'.repeat(2_001) }, message: /invalid reason/i },
      { changes: { reason: 42 }, message: /invalid reason/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.checkpoints[existing.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);

      const candidate = { ...checkpoint(shortIdMedia.id), ...changes } as unknown as Checkpoint;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'checkpoint.register', checkpoint: candidate }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    const missingReference = checkpoint('missing-snapshot');
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'checkpoint.register', checkpoint: missingReference }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid checkpoint/i);
    const invalidStoredReference = structuredClone(project);
    invalidStoredReference.checkpoints[existing.id].snapshotAssetId = 'missing-snapshot';
    expect(() => validateProjectIntegrity(invalidStoredReference)).toThrow(/checkpoint .* invalid/i);
    expect(project).toEqual(original);
  });
});
