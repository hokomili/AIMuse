import { describe, expect, it } from 'vitest';
import {
  applyProjectTransaction,
  createId,
  createProject,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type Checkpoint,
  type EntityBase,
  type GenerationProvenance,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
  type Variant,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-media-history-entity-base', kind: 'agent', name: 'Media History Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-media-history-entity-base', kind: 'human', name: 'Media History Reviewer', color: '#a78bfa' };

type Family = 'asset' | 'provenance' | 'checkpoint' | 'variant';

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Media history entity metadata integrity', createdAt: nowIso(), operations };
}

function asset(name: string, kind: MediaAsset['kind'] = 'audio'): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind, name, mimeType: 'application/octet-stream', sha256: 'a'.repeat(64),
    byteLength: 64, storage: 'embedded', source: 'system',
  };
}

function provenance(assetId: string, referenceAssetId: string): GenerationProvenance {
  return {
    ...entityBase('provenance', AGENT), assetId, provider: 'stability', model: 'fixture-model', kind: 'music',
    prompt: 'fixture prompt', referenceAssetIds: [referenceAssetId], rightsDeclaration: 'original', transformations: [], experimental: true,
  };
}

function checkpoint(snapshotAssetId: string): Checkpoint {
  return { ...entityBase('checkpoint', AGENT), name: 'Checkpoint', projectRevision: 0, snapshotAssetId, automatic: false };
}

function variant(baseCheckpointId: string, snapshotAssetId?: string): Variant {
  return { ...entityBase('variant', AGENT), name: 'Variant', baseCheckpointId, snapshotAssetId, status: 'active', projectRevision: 0 };
}

function populatedProject(): {
  project: AIMuseProject;
  ids: Record<Family | 'deletableAsset' | 'deletableCheckpoint', string>;
} {
  const base = createProject('song', 'Media history EntityBase values', AGENT);
  const generated = asset('Generated');
  const reference = asset('Reference');
  const snapshot = asset('Checkpoint snapshot', 'checkpoint');
  const variantSnapshot = asset('Variant snapshot', 'checkpoint');
  const deletableAsset = asset('Disposable analysis', 'analysis');
  const deletableCheckpointSnapshot = asset('Disposable checkpoint snapshot', 'checkpoint');
  const generation = provenance(generated.id, reference.id);
  const history = checkpoint(snapshot.id);
  const alternate = variant(history.id, variantSnapshot.id);
  const deletableCheckpoint = checkpoint(deletableCheckpointSnapshot.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    ...[generated, reference, snapshot, variantSnapshot, deletableAsset, deletableCheckpointSnapshot].map((value): ProjectOperation => ({ kind: 'asset.add', asset: value })),
    { kind: 'provenance.register', provenance: generation },
    { kind: 'checkpoint.register', checkpoint: history },
    { kind: 'variant.register', variant: alternate },
    { kind: 'checkpoint.register', checkpoint: deletableCheckpoint },
  ]), { authenticatedActor: AGENT }).project;
  return {
    project,
    ids: {
      asset: generated.id,
      provenance: generation.id,
      checkpoint: history.id,
      variant: alternate.id,
      deletableAsset: deletableAsset.id,
      deletableCheckpoint: deletableCheckpoint.id,
    },
  };
}

function storedEntity(project: AIMuseProject, family: Family, id: string): EntityBase {
  if (family === 'asset') return project.assets[id];
  if (family === 'provenance') return project.provenance[id];
  if (family === 'checkpoint') return project.checkpoints[id];
  return project.variants[id];
}

function incomingOperation(family: Family, changes: Record<string, unknown>, project: AIMuseProject, ids: Record<Family | 'deletableAsset' | 'deletableCheckpoint', string>): ProjectOperation {
  if (family === 'asset') return { kind: 'asset.add', asset: { ...asset('Incoming'), ...changes } as MediaAsset };
  if (family === 'provenance') return { kind: 'provenance.register', provenance: { ...provenance(ids.asset, ids.asset), ...changes } as GenerationProvenance };
  if (family === 'checkpoint') return { kind: 'checkpoint.register', checkpoint: { ...checkpoint(project.checkpoints[ids.checkpoint].snapshotAssetId), ...changes } as Checkpoint };
  return { kind: 'variant.register', variant: { ...variant(ids.checkpoint), ...changes } as Variant };
}

describe('media and history EntityBase declared metadata integrity', () => {
  it('accepts exact independent boundaries and rejects malformed stored and incoming metadata before normalization', () => {
    const { project, ids } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const families: Family[] = ['asset', 'provenance', 'checkpoint', 'variant'];
    const acceptedCases: Array<Record<string, unknown>> = [
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
    for (const family of families) for (const changes of acceptedCases) {
      const stored = structuredClone(project);
      Object.assign(storedEntity(stored, family, ids[family]), changes);
      validateProjectIntegrity(stored);

      const committed = applyProjectTransaction(project, transaction(project.id, [incomingOperation(family, changes, project, ids)]), { authenticatedActor: AGENT });
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
    for (const { changes, message } of invalidCases) for (const family of families) {
      const stored = structuredClone(project);
      Object.assign(storedEntity(stored, family, ids[family]) as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(stored)).toThrow(message);
      expect(() => applyProjectTransaction(project, transaction(project.id, [incomingOperation(family, changes, project, ids)]), { authenticatedActor: AGENT })).toThrow(message);
    }
    expect(project).toEqual(original);
  });

  it('rejects corrupted existing targets before update or deletion while preserving attribution and source state', () => {
    const { project, ids } = populatedProject();
    const cases: Array<{ family: Family; targetId: string; operation: ProjectOperation }> = [
      { family: 'asset', targetId: ids.deletableAsset, operation: { kind: 'asset.delete', assetId: ids.deletableAsset } },
      { family: 'provenance', targetId: ids.provenance, operation: { kind: 'provenance.update', provenanceId: ids.provenance, changes: { modelVersion: 'reviewed' } } },
      { family: 'checkpoint', targetId: ids.deletableCheckpoint, operation: { kind: 'checkpoint.delete', checkpointId: ids.deletableCheckpoint } },
      { family: 'variant', targetId: ids.variant, operation: { kind: 'variant.update', variantId: ids.variant, changes: { name: 'Reviewed variant' } } },
    ];
    for (const { family, targetId, operation } of cases) {
      const corrupted = structuredClone(project);
      storedEntity(corrupted, family, targetId).revision = -1;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
      expect(corrupted).toEqual(before);
    }
    expect(project.activity.at(-1)?.actor.id).toBe(AGENT.id);
  });
});
