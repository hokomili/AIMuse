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
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-take-lane-mutable', kind: 'agent', name: 'Take Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-take-lane-reviewer', kind: 'agent', name: 'Take Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Take-lane mutable integrity', createdAt: nowIso(), operations };
}

function clip(trackId: string, name: string, takeLaneId?: string): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, takeLaneId, name, color: '#8b5cf6', startTick: 0, durationTicks: 960,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function lane(trackId: string, clipIds: string[], name = 'Take lane', active = false): TakeLane {
  return { ...entityBase('take-lane', AGENT), trackId, name, clipIds, active };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo take-lane mutable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Take-lane mutable values');
  const track = base.tracks[base.trackOrder[0]];
  const take = lane(track.id, []);
  const first = clip(track.id, 'First', take.id);
  const second = clip(track.id, 'Second', take.id);
  take.clipIds = [second.id, first.id];
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'take-lane.add', lane: take }, { kind: 'clip.add', clip: first }, { kind: 'clip.add', clip: second },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, track, take, first, second };
}

describe('take-lane mutable declared-value integrity', () => {
  it('preserves clip order, attribution and semantic inverses across add, update and delete', () => {
    let project = createProject('song', 'Take-lane mutable lifecycles');
    const track = project.tracks[project.trackOrder[0]];
    const take = lane(track.id, []);
    const first = clip(track.id, 'First', take.id);
    const second = clip(track.id, 'Second', take.id);
    take.clipIds = [second.id, first.id];
    project = commitAndVerifyInverse(project, [
      { kind: 'take-lane.add', lane: take }, { kind: 'clip.add', clip: first }, { kind: 'clip.add', clip: second },
    ]);
    expect(project.takeLanes[take.id].clipIds).toEqual([second.id, first.id]);
    const createdAt = project.takeLanes[take.id].createdAt;

    project = commitAndVerifyInverse(project, [{
      kind: 'take-lane.update', laneId: take.id,
      changes: { name: 'T'.repeat(200), active: true }, expectedRevision: project.takeLanes[take.id].revision,
    }], REVIEWER);
    expect(project.takeLanes[take.id]).toMatchObject({
      name: 'T'.repeat(200), active: true, clipIds: [second.id, first.id],
      createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });

    project = commitAndVerifyInverse(project, [{
      kind: 'take-lane.delete', laneId: take.id, expectedRevision: project.takeLanes[take.id].revision,
    }], REVIEWER);
    expect(project.takeLanes[take.id]).toBeUndefined();
    expect(project.clips[first.id].takeLaneId).toBeUndefined();
    expect(project.clips[second.id].takeLaneId).toBeUndefined();
  });

  it('accepts exact declared boundaries and rejects malformed name or active values before mutation', () => {
    const { project, track, take } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { name: '' }, message: /invalid name/i },
      { changes: { name: 'n'.repeat(201) }, message: /invalid name/i },
      { changes: { name: 42 }, message: /invalid name/i },
      { changes: { active: 'yes' }, message: /invalid active state/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(invalid.takeLanes[take.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      const operation = {
        kind: 'take-lane.update', laneId: take.id, changes, expectedRevision: project.takeLanes[take.id].revision,
      } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(message);
    }

    const invalidAdd = lane(track.id, [], '', false);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'take-lane.add', lane: invalidAdd }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid name/i);
    expect(project).toEqual(original);
  });
});
