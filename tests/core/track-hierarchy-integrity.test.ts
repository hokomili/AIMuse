import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-hierarchy', kind: 'agent', name: 'Hierarchy Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-hierarchy-reviewer', kind: 'agent', name: 'Hierarchy Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Track hierarchy integrity', createdAt: nowIso(), operations };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo hierarchy operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const project = createProject('song', 'Track hierarchy integrity');
  const parent = createTrack('folder', 'Parent', '#14b8a6', AGENT);
  const nested = createTrack('folder', 'Nested', '#a78bfa', AGENT);
  const child = createTrack('audio', 'Child', '#f59e0b', AGENT);
  return {
    project: applyProjectTransaction(project, transaction(project.id, [
      { kind: 'track.add', track: parent, index: 0 },
      { kind: 'track.add', track: nested, parentId: parent.id, index: 0 },
      { kind: 'track.add', track: child, parentId: parent.id, index: 1 },
    ], AGENT), { authenticatedActor: AGENT }).project,
    parent,
    nested,
    child,
  };
}

describe('track hierarchy integrity', () => {
  it('keeps explicit root/sibling ordering and hierarchy moves semantically invertible', () => {
    let project = createProject('song', 'Track hierarchy inverses');
    const originalRootOrder = [...project.trackOrder];
    const parent = createTrack('folder', 'Parent', '#14b8a6', AGENT);
    const nested = createTrack('folder', 'Nested', '#a78bfa', AGENT);
    const child = createTrack('audio', 'Child', '#f59e0b', AGENT);
    const auxiliary = createTrack('aux', 'Auxiliary', '#06b6d4', AGENT);

    project = commitAndVerifyInverse(project, [
      { kind: 'track.add', track: parent, index: 0 },
      { kind: 'track.add', track: nested, parentId: parent.id, index: 0 },
      { kind: 'track.add', track: child, parentId: parent.id, index: 1 },
      { kind: 'track.add', track: auxiliary, index: 1 },
    ]);
    expect(project.trackOrder).toEqual([parent.id, auxiliary.id, ...originalRootOrder]);
    expect(project.tracks[parent.id].childTrackIds).toEqual([nested.id, child.id]);
    expect(project.tracks[nested.id].parentId).toBe(parent.id);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'track.move', trackId: parent.id, parentId: nested.id, index: 0, expectedRevision: project.tracks[parent.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/create a cycle/i);

    project = commitAndVerifyInverse(project, [{
      kind: 'track.move', trackId: auxiliary.id, parentId: parent.id, index: 1, expectedRevision: project.tracks[auxiliary.id].revision,
    }], REVIEWER);
    expect(project.trackOrder).toEqual([parent.id, ...originalRootOrder]);
    expect(project.tracks[parent.id].childTrackIds).toEqual([nested.id, auxiliary.id, child.id]);
    expect(project.tracks[auxiliary.id]).toMatchObject({ parentId: parent.id, createdBy: AGENT.id, updatedBy: REVIEWER.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'track.move', trackId: child.id, parentId: nested.id, index: 0, expectedRevision: project.tracks[child.id].revision,
    }], REVIEWER);
    expect(project.tracks[parent.id].childTrackIds).toEqual([nested.id, auxiliary.id]);
    expect(project.tracks[nested.id].childTrackIds).toEqual([child.id]);
    expect(project.tracks[child.id].parentId).toBe(nested.id);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'track.move', trackId: parent.id, parentId: child.id, index: 0, expectedRevision: project.tracks[parent.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/parent track must be a folder/i);

    project = commitAndVerifyInverse(project, [{
      kind: 'track.move', trackId: auxiliary.id, parentId: parent.id, index: 0, expectedRevision: project.tracks[auxiliary.id].revision,
    }]);
    expect(project.tracks[parent.id].childTrackIds).toEqual([auxiliary.id, nested.id]);

    project = commitAndVerifyInverse(project, [{
      kind: 'track.move', trackId: nested.id, index: 1, expectedRevision: project.tracks[nested.id].revision,
    }], REVIEWER);
    expect(project.trackOrder).toEqual([parent.id, nested.id, ...originalRootOrder]);
    expect(project.tracks[parent.id].childTrackIds).toEqual([auxiliary.id]);
    expect(project.tracks[nested.id].parentId).toBeUndefined();
    expect(project.tracks[nested.id].childTrackIds).toEqual([child.id]);

    const masterId = project.trackOrder.find((id) => project.tracks[id].kind === 'master')!;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'track.move', trackId: masterId, parentId: parent.id, index: 0, expectedRevision: project.tracks[masterId].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/master cannot be nested/i);
  });

  it('rejects incomplete, duplicate, non-reciprocal, non-folder, and cyclic hierarchies', () => {
    const { project, parent, nested, child } = populatedProject();
    validateProjectIntegrity(project);

    const duplicateRoot = structuredClone(project);
    duplicateRoot.trackOrder.push(parent.id);
    expect(() => validateProjectIntegrity(duplicateRoot)).toThrow(/track order contains duplicates/i);

    const missingRoot = structuredClone(project);
    missingRoot.trackOrder.push('missing-track');
    expect(() => validateProjectIntegrity(missingRoot)).toThrow(/track order references missing track/i);

    const nestedAsRoot = structuredClone(project);
    nestedAsRoot.trackOrder.push(nested.id);
    expect(() => validateProjectIntegrity(nestedAsRoot)).toThrow(/nested track .* cannot also appear in track order/i);

    const omittedRoot = structuredClone(project);
    omittedRoot.trackOrder = omittedRoot.trackOrder.filter((id) => id !== parent.id);
    expect(() => validateProjectIntegrity(omittedRoot)).toThrow(/root track .* missing from track order/i);

    const duplicateChild = structuredClone(project);
    duplicateChild.tracks[parent.id].childTrackIds.push(nested.id);
    expect(() => validateProjectIntegrity(duplicateChild)).toThrow(/duplicate child references/i);

    const missingChild = structuredClone(project);
    missingChild.tracks[parent.id].childTrackIds.push('missing-track');
    expect(() => validateProjectIntegrity(missingChild)).toThrow(/invalid child reference/i);

    const mismatchedChild = structuredClone(project);
    mismatchedChild.tracks[child.id].parentId = nested.id;
    expect(() => validateProjectIntegrity(mismatchedChild)).toThrow(/invalid child reference/i);

    const missingParentBackref = structuredClone(project);
    missingParentBackref.tracks[parent.id].childTrackIds = missingParentBackref.tracks[parent.id].childTrackIds.filter((id) => id !== nested.id);
    expect(() => validateProjectIntegrity(missingParentBackref)).toThrow(/missing from its parent's child order/i);

    const nonFolderParent = structuredClone(project);
    nonFolderParent.tracks[parent.id].kind = 'audio';
    expect(() => validateProjectIntegrity(nonFolderParent)).toThrow(/non-folder track .* cannot contain child tracks/i);

    const cyclic = structuredClone(project);
    cyclic.trackOrder = cyclic.trackOrder.filter((id) => id !== parent.id);
    cyclic.tracks[parent.id].parentId = nested.id;
    cyclic.tracks[nested.id].childTrackIds.push(parent.id);
    expect(() => validateProjectIntegrity(cyclic)).toThrow(/track hierarchy contains a cycle/i);
  });
});
