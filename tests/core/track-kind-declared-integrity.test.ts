import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-track-kind', kind: 'agent', name: 'Track Kind Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-track-kind', kind: 'human', name: 'Track Kind Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Track kind declared integrity', createdAt: nowIso(), operations };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function populatedProject(): { project: AIMuseProject; folder: Track; target: Track } {
  const base = createProject('song', 'Track kind declared values', AGENT);
  const folder = createTrack('folder', 'Kind parent', '#14b8a6', AGENT);
  const target = createTrack('aux', 'Kind target', '#a78bfa', AGENT);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: folder },
    { kind: 'track.add', track: target, parentId: folder.id },
  ]), { authenticatedActor: AGENT }).project;
  return { project, folder, target };
}

describe('track kind declared-value integrity', () => {
  it('preserves all six declared kinds, authenticated attribution and semantic inverses', () => {
    const base = createProject('song', 'Track kind boundaries', AGENT);
    const additions = (['audio', 'instrument', 'midi', 'folder', 'aux'] as const).map((kind) => createTrack(kind, `${kind} kind`, '#14b8a6', AGENT));
    const committed = applyProjectTransaction(base, transaction(base.id, additions.map((track) => ({ kind: 'track.add', track })), REVIEWER), { authenticatedActor: REVIEWER });

    expect(additions.map((track) => committed.project.tracks[track.id].kind)).toEqual(['audio', 'instrument', 'midi', 'folder', 'aux']);
    expect(Object.values(committed.project.tracks).some((track) => track.kind === 'master')).toBe(true);
    for (const track of additions) expect(committed.project.tracks[track.id]).toMatchObject({ revision: 0, createdBy: REVIEWER.id, updatedBy: REVIEWER.id });
    expect(() => validateProject(committed.project)).not.toThrow();
    validateProjectIntegrity(committed.project);

    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo track kind additions', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(base));
  });

  it('rejects malformed stored, incoming, mutation-target and cascade-cleanup kinds', () => {
    const { project, folder, target } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidKinds: unknown[] = ['video', '', 42, null, undefined];

    for (const kind of invalidKinds) {
      const stored = structuredClone(project);
      (stored.tracks[target.id] as unknown as { kind: unknown }).kind = kind;
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(/Track .* invalid kind/i);

      const incoming = { ...createTrack('aux', 'Invalid incoming kind', '#f59e0b', AGENT), kind } as unknown as Track;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: incoming }]), { authenticatedActor: AGENT })).toThrow(/Track .* invalid kind/i);
    }

    const duplicate = { ...createTrack('aux', 'Duplicate invalid kind', '#f59e0b', AGENT), id: target.id, kind: 'video' } as unknown as Track;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: duplicate }]), { authenticatedActor: AGENT })).toThrow(/Track ID already exists/i);
    const invalidParent = { ...createTrack('aux', 'Invalid parent and kind', '#f59e0b', AGENT), kind: 'video' } as unknown as Track;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: invalidParent, parentId: 'missing-parent' }]), { authenticatedActor: AGENT })).toThrow(/Parent track must be a folder/i);
    const invalidMutable = { ...createTrack('aux', 'Invalid mutable and kind', '#f59e0b', AGENT), name: '', kind: 'video' } as unknown as Track;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: invalidMutable }]), { authenticatedActor: AGENT })).toThrow(/invalid name/i);

    const invalidHierarchy = structuredClone(project);
    (invalidHierarchy.tracks[folder.id] as unknown as { kind: unknown }).kind = 'video';
    expect(() => validateProjectIntegrity(invalidHierarchy)).toThrow(/Non-folder track .* cannot contain child tracks/i);

    const invalidSelfMove = structuredClone(project);
    (invalidSelfMove.tracks[target.id] as unknown as { kind: unknown }).kind = 'video';
    expect(() => applyProjectTransaction(invalidSelfMove, transaction(invalidSelfMove.id, [{ kind: 'track.move', trackId: target.id, parentId: target.id, index: 0 }]), { authenticatedActor: AGENT })).toThrow(/cannot parent itself/i);
    const invalidReferencedDelete = structuredClone(project);
    (invalidReferencedDelete.tracks[target.id] as unknown as { kind: unknown }).kind = 'video';
    invalidReferencedDelete.tracks[target.id].childTrackIds.push('missing-child');
    expect(() => applyProjectTransaction(invalidReferencedDelete, transaction(invalidReferencedDelete.id, [{ kind: 'track.delete', trackId: target.id, cascade: false }]), { authenticatedActor: AGENT })).toThrow(/Track is not empty/i);

    const corruptTargetOperations: ProjectOperation[] = [
      { kind: 'track.update', trackId: target.id, changes: { name: 'Rejected update' } },
      { kind: 'track.move', trackId: target.id, index: 0 },
      { kind: 'track.delete', trackId: target.id, cascade: false },
      { kind: 'track.delete', trackId: folder.id, cascade: true },
    ];
    for (const operation of corruptTargetOperations) {
      const corrupted = structuredClone(project);
      (corrupted.tracks[target.id] as unknown as { kind: unknown }).kind = 'video';
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/Track .* invalid kind/i);
      expect(corrupted).toEqual(before);
    }
    expect(project).toEqual(original);
  });
});
