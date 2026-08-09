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
  type MediaAsset,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-media-asset', kind: 'agent', name: 'Media Asset Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-media-asset-reviewer', kind: 'agent', name: 'Media Asset Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Media asset metadata integrity', createdAt: nowIso(), operations };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    ...entityBase('asset', AGENT),
    kind: 'audio',
    name: 'Media asset',
    mimeType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    byteLength: 64,
    storage: 'embedded',
    source: 'system',
    ...overrides,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo media asset operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('media asset declared metadata integrity', () => {
  it('preserves exact declared metadata, attribution and semantic add/delete inverses', () => {
    let project = createProject('song', 'Media asset metadata lifecycles');
    const value = asset({
      kind: 'audio',
      name: 'n'.repeat(500),
      mimeType: 'm'.repeat(200),
      sha256: 'A'.repeat(64),
      byteLength: 0,
      storage: 'embedded',
      relativePath: 'r'.repeat(2_000),
      externalPath: 'e'.repeat(32_000),
      sampleRate: 1,
      channels: 64,
      durationSamples: 0,
      source: 'generation',
    });

    project = commitAndVerifyInverse(project, [{ kind: 'asset.add', asset: value }]);
    expect(project.assets[value.id]).toMatchObject({
      kind: 'audio',
      name: 'n'.repeat(500),
      mimeType: 'm'.repeat(200),
      sha256: 'A'.repeat(64),
      byteLength: 0,
      storage: 'embedded',
      relativePath: 'r'.repeat(2_000),
      externalPath: 'e'.repeat(32_000),
      sampleRate: 1,
      channels: 64,
      durationSamples: 0,
      source: 'generation',
      createdBy: AGENT.id,
      updatedBy: AGENT.id,
    });

    project = commitAndVerifyInverse(project, [{ kind: 'asset.delete', assetId: value.id, expectedRevision: project.assets[value.id].revision }], REVIEWER);
    expect(project.assets[value.id]).toBeUndefined();
    expect(project.activity.at(-1)?.actor.id).toBe(REVIEWER.id);
  });

  it('accepts every literal and exact boundary while rejecting malformed add and stored metadata', () => {
    const existing = asset();
    const base = createProject('song', 'Media asset metadata values');
    const project = applyProjectTransaction(base, transaction(base.id, [{ kind: 'asset.add', asset: existing }], AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(project);
    const original = structuredClone(project);

    const acceptedCases: Array<Partial<MediaAsset>> = [
      ...(['audio', 'midi', 'plugin-state', 'analysis', 'audition', 'checkpoint'] as const).map((kind) => ({ kind })),
      ...(['embedded', 'linked', 'managed-cache'] as const).map((storage) => ({ storage })),
      ...(['import', 'recording', 'generation', 'render', 'system'] as const).map((source) => ({ source })),
      { name: 'n' },
      { mimeType: 'm' },
      { sha256: 'F'.repeat(64) },
      { byteLength: 0 },
      { relativePath: '', externalPath: '' },
      { relativePath: 'r'.repeat(2_000), externalPath: 'e'.repeat(32_000) },
      { sampleRate: 1 },
      { channels: 1 },
      { channels: 64 },
      { durationSamples: 0 },
      { source: undefined },
    ];
    for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      Object.assign(accepted.assets[existing.id], changes);
      validateProjectIntegrity(accepted);
    }

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { kind: 'video' }, message: /invalid kind/i },
      { changes: { name: '' }, message: /invalid name/i },
      { changes: { name: 'n'.repeat(501) }, message: /invalid name/i },
      { changes: { name: 42 }, message: /invalid name/i },
      { changes: { mimeType: '' }, message: /invalid MIME type/i },
      { changes: { mimeType: 'm'.repeat(201) }, message: /invalid MIME type/i },
      { changes: { mimeType: 42 }, message: /invalid MIME type/i },
      { changes: { sha256: 'a'.repeat(63) }, message: /invalid SHA-256/i },
      { changes: { sha256: 'g'.repeat(64) }, message: /invalid SHA-256/i },
      { changes: { sha256: 42 }, message: /invalid SHA-256/i },
      { changes: { byteLength: -1 }, message: /invalid byte length/i },
      { changes: { byteLength: 0.5 }, message: /invalid byte length/i },
      { changes: { byteLength: Number.NaN }, message: /invalid byte length/i },
      { changes: { storage: 'temporary' }, message: /invalid storage value/i },
      { changes: { relativePath: 'r'.repeat(2_001) }, message: /invalid path metadata/i },
      { changes: { relativePath: 42 }, message: /invalid path metadata/i },
      { changes: { externalPath: 'e'.repeat(32_001) }, message: /invalid path metadata/i },
      { changes: { externalPath: 42 }, message: /invalid path metadata/i },
      { changes: { sampleRate: 0 }, message: /invalid audio metadata/i },
      { changes: { sampleRate: 0.5 }, message: /invalid audio metadata/i },
      { changes: { sampleRate: '48000' }, message: /invalid audio metadata/i },
      { changes: { channels: 0 }, message: /invalid audio metadata/i },
      { changes: { channels: 65 }, message: /invalid audio metadata/i },
      { changes: { channels: 0.5 }, message: /invalid audio metadata/i },
      { changes: { durationSamples: -1 }, message: /invalid audio metadata/i },
      { changes: { durationSamples: 0.5 }, message: /invalid audio metadata/i },
      { changes: { source: 'capture' }, message: /invalid source/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.assets[existing.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);

      const candidate = { ...asset(), ...changes } as unknown as MediaAsset;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'asset.add', asset: candidate }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    expect(project).toEqual(original);
  });
});
