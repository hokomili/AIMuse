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
  type GenerationProvenance,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-provenance-mutable', kind: 'agent', name: 'Provenance Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-provenance-reviewer', kind: 'agent', name: 'Provenance Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Provenance mutable integrity', createdAt: nowIso(), operations };
}

function asset(name: string): MediaAsset {
  return {
    ...entityBase('asset', AGENT), kind: 'audio', name, mimeType: 'audio/wav', sha256: 'e'.repeat(64), byteLength: 64,
    storage: 'embedded', source: 'generation',
  };
}

function provenance(assetId: string, referenceAssetId: string): GenerationProvenance {
  return {
    ...entityBase('provenance', AGENT), assetId, provider: 'stability', model: 'fixture-model', kind: 'music', prompt: 'fixture prompt',
    referenceAssetIds: [referenceAssetId], rightsDeclaration: 'original', transformations: [], experimental: true,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo provenance mutable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Provenance mutable values');
  const generated = asset('Generated');
  const reference = asset('Reference');
  const generation = provenance(generated.id, reference.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'asset.add', asset: generated }, { kind: 'asset.add', asset: reference },
    { kind: 'provenance.register', provenance: generation },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, generated, reference, generation };
}

describe('generation-provenance mutable declared-value integrity', () => {
  it('preserves asset relationships, attribution and semantic inverses across register and update', () => {
    let project = createProject('song', 'Provenance mutable lifecycles');
    const generated = asset('Generated');
    const reference = asset('Reference');
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'asset.add', asset: generated }, { kind: 'asset.add', asset: reference },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const generation = provenance(generated.id, reference.id);
    project = commitAndVerifyInverse(project, [{ kind: 'provenance.register', provenance: generation }]);
    const createdAt = project.provenance[generation.id].createdAt;
    const transformations = Array.from({ length: 200 }, (_, index) => index === 0 ? 't'.repeat(500) : `step-${index}`);

    project = commitAndVerifyInverse(project, [{
      kind: 'provenance.update', provenanceId: generation.id,
      changes: { modelVersion: 'v'.repeat(100), transformations }, expectedRevision: project.provenance[generation.id].revision,
    }], REVIEWER);
    expect(project.provenance[generation.id]).toMatchObject({
      assetId: generated.id, referenceAssetIds: [reference.id], modelVersion: 'v'.repeat(100), transformations,
      createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
  });

  it('accepts exact declared boundaries and rejects malformed mutable values before mutation', () => {
    const { project, generation } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const emptyVersion = applyProjectTransaction(project, transaction(project.id, [{
      kind: 'provenance.update', provenanceId: generation.id, changes: { modelVersion: '' },
      expectedRevision: project.provenance[generation.id].revision,
    }], REVIEWER), { authenticatedActor: REVIEWER });
    expect(emptyVersion.project.provenance[generation.id].modelVersion).toBe('');

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { modelVersion: 'v'.repeat(101) }, message: /invalid model version/i },
      { changes: { modelVersion: 42 }, message: /invalid model version/i },
      { changes: { transformations: 'trim' }, message: /invalid transformations/i },
      { changes: { transformations: Array.from({ length: 201 }, () => 'trim') }, message: /invalid transformations/i },
      { changes: { transformations: ['t'.repeat(501)] }, message: /invalid transformations/i },
      { changes: { transformations: [42] }, message: /invalid transformations/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.provenance[generation.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = {
        kind: 'provenance.update', provenanceId: generation.id, changes,
        expectedRevision: project.provenance[generation.id].revision,
      } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidRegister = provenance(generation.assetId, generation.referenceAssetIds[0]);
    invalidRegister.transformations = Array.from({ length: 201 }, () => 'trim');
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'provenance.register', provenance: invalidRegister }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid transformations/i);
    expect(project).toEqual(original);
  });
});
