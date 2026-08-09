import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type EntityBase,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
  type Track,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-track-clip-entity-base', kind: 'agent', name: 'Track Clip Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-track-clip-entity-base', kind: 'human', name: 'Track Clip Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Track and clip entity metadata integrity', createdAt: nowIso(), operations };
}

function midiClip(trackId: string, name = 'MIDI fixture', startTick = 0, durationTicks = 1_920): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name, color: '#8b5cf6', startTick, durationTicks,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' },
    loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo track/clip entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; sourceTrackId: string; target: Track; clip: MidiClip } {
  const base = createProject('song', 'Track and clip EntityBase values', AGENT);
  const sourceTrackId = base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!;
  const target = createTrack('midi', 'MIDI target', '#14b8a6', AGENT);
  const clip = midiClip(sourceTrackId);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'track.add', track: target },
    { kind: 'clip.add', clip },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, sourceTrackId, target, clip };
}

function assignStoredBoundary(project: AIMuseProject, family: 'track' | 'clip', entityId: string, changes: Partial<EntityBase>): void {
  if (family === 'track') {
    const track = project.tracks[entityId];
    if (changes.id !== undefined && changes.id !== entityId) {
      delete project.tracks[entityId];
      project.tracks[changes.id] = track;
      project.trackOrder = project.trackOrder.map((id) => id === entityId ? changes.id! : id);
    }
    Object.assign(track, changes);
    return;
  }
  const clip = project.clips[entityId];
  if (changes.id !== undefined && changes.id !== entityId) {
    delete project.clips[entityId];
    project.clips[changes.id] = clip;
    project.tracks[clip.trackId].clipIds = project.tracks[clip.trackId].clipIds.map((id) => id === entityId ? changes.id! : id);
  }
  Object.assign(clip, changes);
}

describe('top-level track and clip EntityBase declared metadata integrity', () => {
  it('preserves creation/update attribution, membership and semantic operation inverses', () => {
    let project = createProject('song', 'Track and clip EntityBase lifecycles', AGENT);
    const sourceTrackId = project.trackOrder.find((id) => project.tracks[id].kind === 'instrument')!;
    const folder = createTrack('folder', 'Folder', '#14b8a6', AGENT);
    const target = createTrack('midi', 'MIDI target', '#a78bfa', AGENT);
    const clip = midiClip(sourceTrackId);

    project = commitAndVerifyInverse(project, [
      { kind: 'track.add', track: folder, index: 0 },
      { kind: 'track.add', track: target, index: 1 },
      { kind: 'clip.add', clip },
    ]);
    expect(project.tracks[target.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    expect(project.clips[clip.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'track.update', trackId: target.id, changes: { name: 'Reviewed target' }, expectedRevision: project.tracks[target.id].revision,
    }], REVIEWER);
    expect(project.tracks[target.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id });

    project = commitAndVerifyInverse(project, [{
      kind: 'track.move', trackId: target.id, parentId: folder.id, index: 0, expectedRevision: project.tracks[target.id].revision,
    }], REVIEWER);
    expect(project.tracks[target.id]).toMatchObject({ parentId: folder.id, revision: 2, createdBy: AGENT.id, updatedBy: REVIEWER.id });
    expect(project.tracks[folder.id].childTrackIds).toEqual([target.id]);

    project = commitAndVerifyInverse(project, [{
      kind: 'clip.update', clipId: clip.id, changes: { name: 'Reviewed clip', muted: true }, expectedRevision: project.clips[clip.id].revision,
    }], REVIEWER);
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.move', clipId: clip.id, trackId: target.id, startTick: 480, index: 0, expectedRevision: project.clips[clip.id].revision,
    }], REVIEWER);
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.trim', clipId: clip.id, startTick: 600, durationTicks: 1_200, expectedRevision: project.clips[clip.id].revision,
    }], REVIEWER);
    expect(project.clips[clip.id]).toMatchObject({ revision: 3, createdBy: AGENT.id, updatedBy: REVIEWER.id, trackId: target.id, startTick: 600, durationTicks: 1_200 });

    const right = midiClip(target.id, 'Right split');
    project = commitAndVerifyInverse(project, [{
      kind: 'clip.split', clipId: clip.id, tick: 1_200, rightClip: right, expectedRevision: project.clips[clip.id].revision,
    }], REVIEWER);
    expect(project.clips[clip.id]).toMatchObject({ revision: 4, createdBy: AGENT.id, updatedBy: REVIEWER.id, durationTicks: 600 });
    expect(project.clips[right.id]).toMatchObject({ revision: 0, createdBy: REVIEWER.id, updatedBy: REVIEWER.id, startTick: 1_200, durationTicks: 600 });
    expect(project.tracks[target.id].clipIds).toEqual([clip.id, right.id]);

    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: right.id, expectedRevision: project.clips[right.id].revision }], REVIEWER);
    expect(project.clips[right.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'track.delete', trackId: target.id, cascade: true, expectedRevision: project.tracks[target.id].revision }], REVIEWER);
    expect(project.tracks[target.id]).toBeUndefined();
    expect(project.clips[clip.id]).toBeUndefined();
    expect(project.tracks[folder.id].childTrackIds).toEqual([]);
  });

  it('accepts exact independent boundaries and rejects malformed stored, incoming and existing-target metadata', () => {
    const { project, sourceTrackId, target, clip } = populatedProject();
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
    for (const family of ['track', 'clip'] as const) for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      assignStoredBoundary(accepted, family, family === 'track' ? target.id : clip.id, changes);
      validateProjectIntegrity(accepted);
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
      const invalidTrack = structuredClone(project);
      Object.assign(invalidTrack.tracks[target.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidTrack)).toThrow(message);
      const invalidClip = structuredClone(project);
      Object.assign(invalidClip.clips[clip.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidClip)).toThrow(message);

      const addedTrack = { ...createTrack('midi', 'Added track', '#22d3ee', AGENT), ...changes } as unknown as Track;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'track.add', track: addedTrack }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      const addedClip = { ...midiClip(sourceTrackId, 'Added clip'), ...changes } as unknown as MidiClip;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.add', clip: addedClip }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      const rightClip = { ...midiClip(sourceTrackId, 'Right split'), ...changes } as unknown as MidiClip;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'clip.split', clipId: clip.id, tick: 960, rightClip }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    const invalidTrackOperations: ProjectOperation[] = [
      { kind: 'track.update', trackId: target.id, changes: { name: 'Rejected update' } },
      { kind: 'track.move', trackId: target.id, index: 0 },
      { kind: 'track.delete', trackId: target.id, cascade: false },
    ];
    for (const operation of invalidTrackOperations) {
      const invalid = structuredClone(project);
      invalid.tracks[target.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidClipOperations: ProjectOperation[] = [
      { kind: 'clip.update', clipId: clip.id, changes: { name: 'Rejected update' } },
      { kind: 'clip.move', clipId: clip.id, trackId: target.id, startTick: 240 },
      { kind: 'clip.trim', clipId: clip.id, startTick: 120, durationTicks: 960 },
      { kind: 'clip.split', clipId: clip.id, tick: 960, rightClip: midiClip(sourceTrackId, 'Right split') },
      { kind: 'clip.delete', clipId: clip.id },
    ];
    for (const operation of invalidClipOperations) {
      const invalid = structuredClone(project);
      invalid.clips[clip.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidCascade = structuredClone(project);
    invalidCascade.clips[clip.id].revision = -1;
    expect(() => applyProjectTransaction(invalidCascade, transaction(invalidCascade.id, [{ kind: 'track.delete', trackId: sourceTrackId, cascade: true }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    expect(project).toEqual(original);
  });
});
