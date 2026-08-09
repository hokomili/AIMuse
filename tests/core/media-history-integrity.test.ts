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
  type Checkpoint,
  type GenerationProvenance,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
  type Variant,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-media', kind: 'agent', name: 'Media Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-media-reviewer', kind: 'agent', name: 'Media Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Media history integrity', createdAt: nowIso(), operations };
}

function asset(kind: MediaAsset['kind'], name: string): MediaAsset {
  return { ...entityBase('asset', AGENT), kind, name, mimeType: 'application/octet-stream', sha256: 'a'.repeat(64), byteLength: 64, storage: 'embedded', source: 'system' };
}

function provenance(assetId: string, referenceAssetId: string): GenerationProvenance {
  return {
    ...entityBase('provenance', AGENT), assetId, provider: 'stability', model: 'fixture-model', kind: 'music', prompt: 'fixture prompt',
    referenceAssetIds: [referenceAssetId], rightsDeclaration: 'original', transformations: [], experimental: true,
  };
}

function checkpoint(snapshotAssetId: string, name = 'Checkpoint'): Checkpoint {
  return { ...entityBase('checkpoint', AGENT), name, projectRevision: 0, snapshotAssetId, automatic: false };
}

function variant(baseCheckpointId: string, snapshotAssetId?: string): Variant {
  return { ...entityBase('variant', AGENT), name: 'Variant', baseCheckpointId, snapshotAssetId, status: 'active', projectRevision: 0 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo media history operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  return committed.project;
}

describe('media, provenance, checkpoint and variant integrity', () => {
  it('keeps declared lifecycles reversible and blocks deletion of every referenced asset', () => {
    let project = createProject('song', 'Media history inverses');
    const generated = asset('audio', 'Generated audio');
    const reference = asset('audio', 'Reference audio');
    const checkpointMedia = asset('checkpoint', 'Checkpoint snapshot');
    const variantMedia = asset('checkpoint', 'Variant snapshot');
    const disposableMedia = asset('analysis', 'Disposable analysis');
    const disposableCheckpointMedia = asset('checkpoint', 'Disposable checkpoint snapshot');
    for (const value of [generated, reference, checkpointMedia, variantMedia, disposableMedia, disposableCheckpointMedia]) {
      project = commitAndVerifyInverse(project, [{ kind: 'asset.add', asset: value }]);
    }

    const generation = provenance(generated.id, reference.id);
    project = commitAndVerifyInverse(project, [{ kind: 'provenance.register', provenance: generation }]);
    project = commitAndVerifyInverse(project, [{ kind: 'provenance.update', provenanceId: generation.id, changes: { modelVersion: 'reviewed', transformations: ['trim'] } }], REVIEWER);
    expect(project.provenance[generation.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, modelVersion: 'reviewed' });

    const history = checkpoint(checkpointMedia.id);
    const alternate = variant(history.id);
    project = commitAndVerifyInverse(project, [{ kind: 'checkpoint.register', checkpoint: history }]);
    project = commitAndVerifyInverse(project, [{ kind: 'variant.register', variant: alternate }]);
    project = commitAndVerifyInverse(project, [{ kind: 'variant.update', variantId: alternate.id, changes: { name: 'Reviewed variant', snapshotAssetId: variantMedia.id, status: 'merged' } }], REVIEWER);
    expect(project.variants[alternate.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, snapshotAssetId: variantMedia.id });

    for (const assetId of [generated.id, reference.id, checkpointMedia.id, variantMedia.id]) {
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'asset.delete', assetId }], AGENT))).toThrow(/still referenced/i);
    }
    project = commitAndVerifyInverse(project, [{ kind: 'asset.delete', assetId: disposableMedia.id }]);
    expect(project.assets[disposableMedia.id]).toBeUndefined();

    const removableCheckpoint = checkpoint(disposableCheckpointMedia.id, 'Removable checkpoint');
    project = commitAndVerifyInverse(project, [{ kind: 'checkpoint.register', checkpoint: removableCheckpoint }]);
    project = commitAndVerifyInverse(project, [{ kind: 'checkpoint.delete', checkpointId: removableCheckpoint.id }]);
    expect(project.checkpoints[removableCheckpoint.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'asset.delete', assetId: disposableCheckpointMedia.id }]);
    expect(project.assets[disposableCheckpointMedia.id]).toBeUndefined();
  });

  it('rejects missing declared media, checkpoint and variant references', () => {
    const base = createProject('song', 'Media history integrity');
    const generated = asset('audio', 'Generated audio');
    const reference = asset('audio', 'Reference audio');
    const checkpointMedia = asset('checkpoint', 'Checkpoint snapshot');
    const variantMedia = asset('checkpoint', 'Variant snapshot');
    let populated = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'asset.add', asset: generated },
      { kind: 'asset.add', asset: reference },
      { kind: 'asset.add', asset: checkpointMedia },
      { kind: 'asset.add', asset: variantMedia },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const generation = provenance(generated.id, reference.id);
    const history = checkpoint(checkpointMedia.id);
    const alternate = variant(history.id, variantMedia.id);
    populated = applyProjectTransaction(populated, transaction(populated.id, [
      { kind: 'provenance.register', provenance: generation },
      { kind: 'checkpoint.register', checkpoint: history },
      { kind: 'variant.register', variant: alternate },
    ], AGENT), { authenticatedActor: AGENT }).project;

    const missingPrimary = structuredClone(populated);
    delete missingPrimary.assets[generated.id];
    expect(() => validateProjectIntegrity(missingPrimary)).toThrow(/generation provenance .* invalid/i);

    const missingReference = structuredClone(populated);
    delete missingReference.assets[reference.id];
    expect(() => validateProjectIntegrity(missingReference)).toThrow(/generation provenance .* invalid/i);

    const missingCheckpointMedia = structuredClone(populated);
    delete missingCheckpointMedia.assets[checkpointMedia.id];
    expect(() => validateProjectIntegrity(missingCheckpointMedia)).toThrow(/checkpoint .* invalid/i);

    const missingBase = structuredClone(populated);
    delete missingBase.checkpoints[history.id];
    expect(() => validateProjectIntegrity(missingBase)).toThrow(/variant .* invalid/i);

    const missingVariantMedia = structuredClone(populated);
    delete missingVariantMedia.assets[variantMedia.id];
    expect(() => validateProjectIntegrity(missingVariantMedia)).toThrow(/variant .* invalid/i);

    expect(() => applyProjectTransaction(populated, transaction(populated.id, [{ kind: 'checkpoint.register', checkpoint: checkpoint('missing-asset') }], AGENT))).toThrow(/invalid checkpoint/i);
    expect(() => applyProjectTransaction(populated, transaction(populated.id, [{ kind: 'variant.update', variantId: alternate.id, changes: { snapshotAssetId: 'missing-asset' } }], AGENT))).toThrow(/snapshot media does not exist/i);
  });
});
