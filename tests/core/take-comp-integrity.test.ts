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
  type CompSegment,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-comp', kind: 'agent', name: 'Comp Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-comp-reviewer', kind: 'agent', name: 'Comp Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Take and comp integrity', createdAt: nowIso(), operations };
}

function clip(trackId: string, name: string): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, name, color: '#8b5cf6', startTick: 0, durationTicks: 960,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function lane(trackId: string, clipIds: string[]): TakeLane {
  return { ...entityBase('take-lane', AGENT), trackId, name: 'Take lane', clipIds, active: true };
}

function segment(trackId: string, takeLaneId: string): CompSegment {
  return { ...entityBase('comp-segment', AGENT), trackId, takeLaneId, startTick: 0, endTick: 480 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo take and comp operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const project = createProject('song', 'Take and comp integrity');
  const track = project.tracks[project.trackOrder[0]];
  const take = lane(track.id, []);
  const source = clip(track.id, 'Source take');
  take.clipIds = [source.id];
  source.takeLaneId = take.id;
  const comp = segment(track.id, take.id);
  return {
    project: applyProjectTransaction(project, transaction(project.id, [
      { kind: 'take-lane.add', lane: take },
      { kind: 'clip.add', clip: source },
      { kind: 'comp-segment.upsert', segment: comp },
    ], AGENT), { authenticatedActor: AGENT }).project,
    track,
    take,
    source,
    comp,
  };
}

describe('take-lane and comp-segment integrity', () => {
  it('keeps declared membership and cleanup lifecycles semantically invertible', () => {
    let project = createProject('song', 'Take and comp inverses');
    const track = project.tracks[project.trackOrder[0]];
    const first = clip(track.id, 'First take');
    const second = clip(track.id, 'Second take');
    const take = lane(track.id, [first.id, second.id]);
    first.takeLaneId = take.id;
    second.takeLaneId = take.id;
    const comp = segment(track.id, take.id);

    project = commitAndVerifyInverse(project, [
      { kind: 'take-lane.add', lane: take },
      { kind: 'clip.add', clip: first },
      { kind: 'clip.add', clip: second },
    ]);
    expect(project.takeLanes[take.id].clipIds).toEqual([first.id, second.id]);

    project = commitAndVerifyInverse(project, [{ kind: 'take-lane.update', laneId: take.id, changes: { name: 'Reviewed takes', active: false } }], REVIEWER);
    expect(project.takeLanes[take.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, name: 'Reviewed takes', active: false });

    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.upsert', segment: comp }]);
    const compCreatedAt = project.compSegments[comp.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'comp-segment.upsert',
      segment: { ...comp, startTick: 120, endTick: 720 },
      expectedRevision: project.compSegments[comp.id].revision,
    }], REVIEWER);
    expect(project.compSegments[comp.id]).toMatchObject({ createdAt: compCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, startTick: 120, endTick: 720 });

    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.delete', segmentId: comp.id }]);
    expect(project.compSegments[comp.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.upsert', segment: comp }]);

    project = commitAndVerifyInverse(project, [{ kind: 'clip.delete', clipId: second.id }]);
    expect(project.takeLanes[take.id].clipIds).toEqual([first.id]);

    project = commitAndVerifyInverse(project, [{ kind: 'take-lane.delete', laneId: take.id }], REVIEWER);
    expect(project.takeLanes[take.id]).toBeUndefined();
    expect(project.clips[first.id].takeLaneId).toBeUndefined();
    expect(project.compSegments[comp.id]).toBeUndefined();
  });

  it('rejects broken membership, ownership, segment references, and ranges', () => {
    const { project, track, take, source, comp } = populatedProject();
    validateProjectIntegrity(project);

    const duplicate = structuredClone(project);
    duplicate.takeLanes[take.id].clipIds.push(source.id);
    expect(() => validateProjectIntegrity(duplicate)).toThrow(/duplicate clip references/i);

    const missingLaneClip = structuredClone(project);
    missingLaneClip.takeLanes[take.id].clipIds = ['missing-clip'];
    missingLaneClip.clips[source.id].takeLaneId = undefined;
    expect(() => validateProjectIntegrity(missingLaneClip)).toThrow(/references missing clip missing-clip/i);

    const missingReciprocalLane = structuredClone(project);
    missingReciprocalLane.takeLanes[take.id].clipIds = [];
    expect(() => validateProjectIntegrity(missingReciprocalLane)).toThrow(/missing from reciprocal take lane/i);

    const missingReciprocalClip = structuredClone(project);
    missingReciprocalClip.clips[source.id].takeLaneId = undefined;
    expect(() => validateProjectIntegrity(missingReciprocalClip)).toThrow(/not reciprocal with clip/i);

    const wrongTrack = structuredClone(project);
    wrongTrack.takeLanes[take.id].trackId = wrongTrack.trackOrder.find((id) => id !== track.id)!;
    expect(() => validateProjectIntegrity(wrongTrack)).toThrow(/must reference the same track/i);

    const missingTakeLane = structuredClone(project);
    delete missingTakeLane.takeLanes[take.id];
    expect(() => validateProjectIntegrity(missingTakeLane)).toThrow(/references missing take lane/i);

    const laneWithMissingTrack = structuredClone(project);
    const orphan = lane('missing-track', []);
    laneWithMissingTrack.takeLanes[orphan.id] = orphan;
    expect(() => validateProjectIntegrity(laneWithMissingTrack)).toThrow(/references missing track/i);

    const invalidSegmentLane = structuredClone(project);
    invalidSegmentLane.compSegments[comp.id].takeLaneId = 'missing-lane';
    expect(() => validateProjectIntegrity(invalidSegmentLane)).toThrow(/invalid track or take lane/i);

    const invalidSegmentTrack = structuredClone(project);
    invalidSegmentTrack.compSegments[comp.id].trackId = invalidSegmentTrack.trackOrder.find((id) => id !== track.id)!;
    expect(() => validateProjectIntegrity(invalidSegmentTrack)).toThrow(/invalid track or take lane/i);

    const invalidSegmentRange = structuredClone(project);
    invalidSegmentRange.compSegments[comp.id].endTick = 0;
    expect(() => validateProjectIntegrity(invalidSegmentRange)).toThrow(/non-empty forward range/i);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'comp-segment.upsert', segment: { ...comp, endTick: 0 }, expectedRevision: project.compSegments[comp.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid track, take lane, or range/i);
  });
});
