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
  type CompSegment,
  type EntityBase,
  type MidiClip,
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-take-comp-entity-base', kind: 'agent', name: 'Take Comp Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-take-comp-entity-base', kind: 'human', name: 'Take Comp Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Take and comp entity metadata integrity', createdAt: nowIso(), operations };
}

function clip(trackId: string, name: string, takeLaneId?: string): MidiClip {
  return {
    ...entityBase('clip', AGENT), kind: 'midi', trackId, takeLaneId, name, color: '#8b5cf6', startTick: 0, durationTicks: 960,
    muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
    notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function lane(trackId: string, clipIds: string[]): TakeLane {
  return { ...entityBase('take-lane', AGENT), trackId, name: 'Take lane', clipIds, active: false };
}

function segment(trackId: string, takeLaneId: string): CompSegment {
  return { ...entityBase('comp-segment', AGENT), trackId, takeLaneId, startTick: 0, endTick: 480 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo take/comp entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject(): { project: AIMuseProject; trackId: string; take: TakeLane; source: MidiClip; comp: CompSegment } {
  const base = createProject('song', 'Take and comp EntityBase values', AGENT);
  const trackId = base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!;
  const take = lane(trackId, []);
  const source = clip(trackId, 'Source take', take.id);
  take.clipIds = [source.id];
  const comp = segment(trackId, take.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'take-lane.add', lane: take },
    { kind: 'clip.add', clip: source },
    { kind: 'comp-segment.upsert', segment: comp },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, trackId, take, source, comp };
}

function assignStoredBoundary(project: AIMuseProject, family: 'lane' | 'segment', entityId: string, changes: Partial<EntityBase>): void {
  if (family === 'lane') {
    const take = project.takeLanes[entityId];
    if (changes.id !== undefined && changes.id !== entityId) {
      delete project.takeLanes[entityId];
      project.takeLanes[changes.id] = take;
      for (const clipId of take.clipIds) project.clips[clipId].takeLaneId = changes.id;
      for (const comp of Object.values(project.compSegments)) if (comp.takeLaneId === entityId) comp.takeLaneId = changes.id;
    }
    Object.assign(take, changes);
    return;
  }
  const comp = project.compSegments[entityId];
  if (changes.id !== undefined && changes.id !== entityId) {
    delete project.compSegments[entityId];
    project.compSegments[changes.id] = comp;
  }
  Object.assign(comp, changes);
}

describe('take-lane and comp-segment EntityBase declared metadata integrity', () => {
  it('preserves attribution, explicit clip order, cleanup and semantic operation inverses', () => {
    let project = createProject('song', 'Take and comp EntityBase lifecycles', AGENT);
    const trackId = project.trackOrder.find((id) => project.tracks[id].kind === 'instrument')!;
    const take = lane(trackId, []);
    const first = clip(trackId, 'First take', take.id);
    const second = clip(trackId, 'Second take', take.id);
    take.clipIds = [second.id, first.id];
    const comp = segment(trackId, take.id);

    project = commitAndVerifyInverse(project, [
      { kind: 'take-lane.add', lane: take },
      { kind: 'clip.add', clip: first },
      { kind: 'clip.add', clip: second },
    ]);
    expect(project.takeLanes[take.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id, clipIds: [second.id, first.id] });

    project = commitAndVerifyInverse(project, [{
      kind: 'take-lane.update', laneId: take.id, changes: { name: 'Reviewed takes', active: true }, expectedRevision: project.takeLanes[take.id].revision,
    }], REVIEWER);
    expect(project.takeLanes[take.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, clipIds: [second.id, first.id] });

    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.upsert', segment: comp }]);
    expect(project.compSegments[comp.id]).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    project = commitAndVerifyInverse(project, [{
      kind: 'comp-segment.upsert', segment: { ...comp, startTick: 120, endTick: 720 }, expectedRevision: project.compSegments[comp.id].revision,
    }], REVIEWER);
    expect(project.compSegments[comp.id]).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id, startTick: 120, endTick: 720 });

    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.delete', segmentId: comp.id, expectedRevision: project.compSegments[comp.id].revision }], REVIEWER);
    expect(project.compSegments[comp.id]).toBeUndefined();
    project = commitAndVerifyInverse(project, [{ kind: 'comp-segment.upsert', segment: comp }]);
    project = commitAndVerifyInverse(project, [{ kind: 'take-lane.delete', laneId: take.id, expectedRevision: project.takeLanes[take.id].revision }], REVIEWER);
    expect(project.takeLanes[take.id]).toBeUndefined();
    expect(project.compSegments[comp.id]).toBeUndefined();
    expect(project.clips[first.id].takeLaneId).toBeUndefined();
    expect(project.clips[second.id].takeLaneId).toBeUndefined();
  });

  it('accepts exact independent boundaries and rejects malformed stored, incoming, existing-target and cleanup metadata', () => {
    const { project, trackId, take, source, comp } = populatedProject();
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
    for (const family of ['lane', 'segment'] as const) for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      assignStoredBoundary(accepted, family, family === 'lane' ? take.id : comp.id, changes);
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
      const invalidLane = structuredClone(project);
      Object.assign(invalidLane.takeLanes[take.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidLane)).toThrow(message);
      const invalidSegment = structuredClone(project);
      Object.assign(invalidSegment.compSegments[comp.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProjectIntegrity(invalidSegment)).toThrow(message);

      const addedLane = { ...lane(trackId, []), ...changes } as unknown as TakeLane;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'take-lane.add', lane: addedLane }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
      const addedSegment = { ...segment(trackId, take.id), ...changes } as unknown as CompSegment;
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'comp-segment.upsert', segment: addedSegment }], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    const invalidLaneOperations: ProjectOperation[] = [
      { kind: 'take-lane.update', laneId: take.id, changes: { name: 'Rejected update' } },
      { kind: 'take-lane.delete', laneId: take.id },
    ];
    for (const operation of invalidLaneOperations) {
      const invalid = structuredClone(project);
      invalid.takeLanes[take.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidSegmentOperations: ProjectOperation[] = [
      { kind: 'comp-segment.upsert', segment: { ...comp, startTick: 120, endTick: 720 } },
      { kind: 'comp-segment.delete', segmentId: comp.id },
    ];
    for (const operation of invalidSegmentOperations) {
      const invalid = structuredClone(project);
      invalid.compSegments[comp.id].revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    }

    const invalidCleanup = structuredClone(project);
    invalidCleanup.compSegments[comp.id].revision = -1;
    const invalidCleanupOriginal = structuredClone(invalidCleanup);
    expect(() => applyProjectTransaction(invalidCleanup, transaction(invalidCleanup.id, [{ kind: 'take-lane.delete', laneId: take.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);
    expect(invalidCleanup).toEqual(invalidCleanupOriginal);
    expect(invalidCleanup.clips[source.id].takeLaneId).toBe(take.id);
    expect(project).toEqual(original);
  });
});
