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
  type Actor,
  type AIMuseProject,
  type GenerationProvenance,
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-provenance-declared', kind: 'agent', name: 'Provenance Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'reviewer-provenance-declared', kind: 'human', name: 'Provenance Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Generation provenance declared integrity', createdAt: nowIso(), operations };
}

function asset(name: string, id?: string): MediaAsset {
  return {
    ...entityBase('asset', AGENT), ...(id ? { id } : {}), kind: 'audio', name, mimeType: 'audio/wav', sha256: 'e'.repeat(64),
    byteLength: 64, storage: 'embedded', source: 'generation',
  };
}

function provenance(assetId: string, referenceAssetId: string, overrides: Record<string, unknown> = {}): GenerationProvenance {
  return {
    ...entityBase('provenance', AGENT), assetId, provider: 'stability', model: 'fixture-model', kind: 'music', prompt: 'fixture prompt',
    referenceAssetIds: [referenceAssetId], rightsDeclaration: 'original', transformations: [], experimental: true, ...overrides,
  } as GenerationProvenance;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function populatedProject(): { project: AIMuseProject; generated: MediaAsset; reference: MediaAsset; generation: GenerationProvenance } {
  const base = createProject('song', 'Generation provenance declared values', AGENT);
  const generated = asset('Generated', 'g');
  const reference = asset('Reference', 'r'.repeat(240));
  const generation = provenance(generated.id, reference.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'asset.add', asset: generated },
    { kind: 'asset.add', asset: reference },
    { kind: 'provenance.register', provenance: generation },
  ]), { authenticatedActor: AGENT }).project;
  return { project, generated, reference, generation };
}

describe('generation-provenance immutable declared-value integrity', () => {
  it('preserves exact declared boundaries, references, attribution and semantic inverses', () => {
    let project = createProject('song', 'Generation provenance boundary lifecycle', AGENT);
    const generated = asset('Generated', 'g'.repeat(240));
    const reference = asset('Reference', 'r');
    project = applyProjectTransaction(project, transaction(project.id, [
      { kind: 'asset.add', asset: generated }, { kind: 'asset.add', asset: reference },
    ]), { authenticatedActor: AGENT }).project;
    const before = project;
    const generation = provenance(generated.id, reference.id, {
      provider: 'lyria', model: 'm'.repeat(300), kind: 'section-replace', prompt: 'p'.repeat(20_000), lyrics: 'l'.repeat(200_000),
      referenceAssetIds: Array.from({ length: 20 }, () => reference.id), requestId: 'q'.repeat(500), costMinor: 0,
      currency: 'c'.repeat(10), rightsDeclaration: 'owned-reference', experimental: false,
    });

    const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'provenance.register', provenance: generation }]), { authenticatedActor: AGENT });
    validateProjectIntegrity(committed.project);
    expect(committed.project.provenance[generation.id]).toMatchObject({
      assetId: generated.id, provider: 'lyria', model: 'm'.repeat(300), kind: 'section-replace', prompt: 'p'.repeat(20_000),
      lyrics: 'l'.repeat(200_000), referenceAssetIds: Array.from({ length: 20 }, () => reference.id), requestId: 'q'.repeat(500),
      costMinor: 0, currency: 'c'.repeat(10), rightsDeclaration: 'owned-reference', experimental: false,
      revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id,
    });

    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo provenance registration', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(before));
  });

  it('accepts independent declared values and rejects malformed stored, incoming and update-target metadata without mutation', () => {
    const { project, generated, reference, generation } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const acceptedCases: Array<Record<string, unknown>> = [
      { assetId: reference.id },
      { provider: 'elevenlabs' }, { provider: 'stability' }, { provider: 'lyria' },
      { model: 'm' }, { model: 'm'.repeat(300) },
      { kind: 'music' }, { kind: 'sfx' }, { kind: 'audio-to-audio' }, { kind: 'section-replace' },
      { prompt: 'p' }, { prompt: 'p'.repeat(20_000) },
      { lyrics: '' }, { lyrics: 'l'.repeat(200_000) },
      { referenceAssetIds: [] }, { referenceAssetIds: Array.from({ length: 20 }, () => reference.id) },
      { requestId: '' }, { requestId: 'q'.repeat(500) },
      { costMinor: 0 }, { costMinor: Number.MAX_SAFE_INTEGER },
      { currency: '' }, { currency: 'c'.repeat(10) },
      { rightsDeclaration: 'original' }, { rightsDeclaration: 'licensed' }, { rightsDeclaration: 'owned-reference' },
      { experimental: false }, { experimental: true },
    ];
    for (const changes of acceptedCases) {
      const stored = structuredClone(project);
      Object.assign(stored.provenance[generation.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).not.toThrow();
      validateProjectIntegrity(stored);

      const incoming = provenance(generated.id, reference.id, changes);
      const committed = applyProjectTransaction(project, transaction(project.id, [{ kind: 'provenance.register', provenance: incoming }]), { authenticatedActor: AGENT });
      validateProjectIntegrity(committed.project);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { assetId: '' }, message: /invalid asset ID/i },
      { changes: { assetId: 'a'.repeat(241) }, message: /invalid asset ID/i },
      { changes: { assetId: 42 }, message: /invalid asset ID/i },
      { changes: { provider: 'unknown' }, message: /invalid provider/i },
      { changes: { provider: 42 }, message: /invalid provider/i },
      { changes: { model: '' }, message: /invalid model/i },
      { changes: { model: 'm'.repeat(301) }, message: /invalid model/i },
      { changes: { model: 42 }, message: /invalid model/i },
      { changes: { kind: 'speech' }, message: /invalid kind/i },
      { changes: { kind: 42 }, message: /invalid kind/i },
      { changes: { prompt: '' }, message: /invalid prompt/i },
      { changes: { prompt: 'p'.repeat(20_001) }, message: /invalid prompt/i },
      { changes: { prompt: 42 }, message: /invalid prompt/i },
      { changes: { lyrics: 'l'.repeat(200_001) }, message: /invalid lyrics/i },
      { changes: { lyrics: 42 }, message: /invalid lyrics/i },
      { changes: { referenceAssetIds: 'reference' }, message: /invalid reference asset IDs/i },
      { changes: { referenceAssetIds: Array.from({ length: 21 }, () => reference.id) }, message: /invalid reference asset IDs/i },
      { changes: { referenceAssetIds: [''] }, message: /invalid reference asset IDs/i },
      { changes: { referenceAssetIds: [42] }, message: /invalid reference asset IDs/i },
      { changes: { requestId: 'q'.repeat(501) }, message: /invalid request ID/i },
      { changes: { requestId: 42 }, message: /invalid request ID/i },
      { changes: { costMinor: -1 }, message: /invalid cost/i },
      { changes: { costMinor: 0.5 }, message: /invalid cost/i },
      { changes: { costMinor: Number.NaN }, message: /invalid cost/i },
      { changes: { currency: 'c'.repeat(11) }, message: /invalid currency/i },
      { changes: { currency: 42 }, message: /invalid currency/i },
      { changes: { rightsDeclaration: 'unknown' }, message: /invalid rights declaration/i },
      { changes: { rightsDeclaration: 42 }, message: /invalid rights declaration/i },
      { changes: { experimental: 'yes' }, message: /invalid experimental value/i },
      { changes: { experimental: undefined }, message: /invalid experimental value/i },
    ];
    for (const { changes, message } of invalidCases) {
      const stored = structuredClone(project);
      Object.assign(stored.provenance[generation.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(message);

      const incoming = provenance(generated.id, reference.id, changes);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'provenance.register', provenance: incoming }]), { authenticatedActor: AGENT })).toThrow(message);
    }

    const corrupted = structuredClone(project);
    (corrupted.provenance[generation.id] as unknown as { provider: unknown }).provider = 'unknown';
    const beforeUpdate = structuredClone(corrupted);
    expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [{
      kind: 'provenance.update', provenanceId: generation.id, changes: { modelVersion: 'reviewed' },
      expectedRevision: corrupted.provenance[generation.id].revision,
    }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid provider/i);
    expect(corrupted).toEqual(beforeUpdate);
    expect(project).toEqual(original);
  });
});
