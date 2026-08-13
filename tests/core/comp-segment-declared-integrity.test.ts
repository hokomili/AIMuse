import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  createTrack,
  entityBase,
  nowIso,
  validateProject,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type CompSegment,
  type ProjectOperation,
  type ProjectTransaction,
  type TakeLane,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-comp-declared', kind: 'agent', name: 'Comp Declared Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-comp-declared', kind: 'human', name: 'Comp Declared Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = AGENT): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Comp segment declared integrity', createdAt: nowIso(), operations };
}

function lane(trackId: string, id = createId('take-lane')): TakeLane {
  return { ...entityBase('take-lane', AGENT), id, trackId, name: 'Comp source lane', clipIds: [], active: true };
}

function segment(trackId: string, takeLaneId: string, overrides: Record<string, unknown> = {}): CompSegment {
  return { ...entityBase('comp-segment', AGENT), trackId, takeLaneId, startTick: 0, endTick: 480, ...overrides } as CompSegment;
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function populatedProject(): { project: AIMuseProject; take: TakeLane; comp: CompSegment } {
  const base = createProject('song', 'Comp segment declared values', AGENT);
  const trackId = base.trackOrder.find((id) => base.tracks[id].kind === 'instrument')!;
  const take = lane(trackId);
  const comp = segment(trackId, take.id);
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'take-lane.add', lane: take },
    { kind: 'comp-segment.upsert', segment: comp },
  ]), { authenticatedActor: AGENT }).project;
  return { project, take, comp };
}

describe('comp-segment declared-value integrity', () => {
  it('preserves exact ID/tick boundaries, attribution and semantic inverses', () => {
    const base = createProject('song', 'Comp segment boundaries', AGENT);
    const track = { ...createTrack('instrument', 'Boundary track', '#14b8a6', AGENT), id: 't'.repeat(240) };
    const take = lane(track.id, 'l'.repeat(240));
    const prepared = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'track.add', track },
      { kind: 'take-lane.add', lane: take },
    ]), { authenticatedActor: AGENT }).project;
    const boundary = segment(track.id, take.id, { id: 's'.repeat(240), startTick: 0, endTick: Number.MAX_SAFE_INTEGER });
    const committed = applyProjectTransaction(prepared, transaction(prepared.id, [{ kind: 'comp-segment.upsert', segment: boundary }], REVIEWER), { authenticatedActor: REVIEWER });

    expect(() => validateProject(committed.project)).not.toThrow();
    validateProjectIntegrity(committed.project);
    expect(committed.project.compSegments[boundary.id]).toMatchObject({
      trackId: track.id, takeLaneId: take.id, startTick: 0, endTick: Number.MAX_SAFE_INTEGER,
      revision: 0, createdBy: REVIEWER.id, updatedBy: REVIEWER.id,
    });
    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo comp boundary', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(prepared));
  });

  it('rejects malformed stored, incoming, existing-target and cleanup values with prior diagnostics first', () => {
    const { project, take, comp } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const invalidCases: Array<{ changes: Record<string, unknown>; storedMessage: RegExp }> = [
      { changes: { startTick: 0.5 }, storedMessage: /non-empty forward range/i },
      { changes: { startTick: -1 }, storedMessage: /non-empty forward range/i },
      { changes: { startTick: Number.MAX_SAFE_INTEGER + 1 }, storedMessage: /non-empty forward range/i },
      { changes: { startTick: Number.NaN }, storedMessage: /non-empty forward range/i },
      { changes: { startTick: 'early' }, storedMessage: /non-empty forward range/i },
      { changes: { endTick: 0.5 }, storedMessage: /non-empty forward range/i },
      { changes: { endTick: Number.MAX_SAFE_INTEGER + 1 }, storedMessage: /non-empty forward range/i },
      { changes: { endTick: Number.POSITIVE_INFINITY }, storedMessage: /non-empty forward range/i },
      { changes: { endTick: 'late' }, storedMessage: /non-empty forward range/i },
      { changes: { trackId: '' }, storedMessage: /invalid track or take lane/i },
      { changes: { trackId: 't'.repeat(241) }, storedMessage: /invalid track or take lane/i },
      { changes: { trackId: 42 }, storedMessage: /invalid track or take lane/i },
      { changes: { takeLaneId: '' }, storedMessage: /invalid track or take lane/i },
      { changes: { takeLaneId: 'l'.repeat(241) }, storedMessage: /invalid track or take lane/i },
      { changes: { takeLaneId: 42 }, storedMessage: /invalid track or take lane/i },
    ];
    for (const { changes, storedMessage } of invalidCases) {
      const stored = structuredClone(project);
      Object.assign(stored.compSegments[comp.id] as unknown as Record<string, unknown>, changes);
      expect(() => validateProject(stored)).toThrow();
      expect(() => validateProjectIntegrity(stored)).toThrow(storedMessage);

      const incoming = segment(comp.trackId, comp.takeLaneId, changes);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'comp-segment.upsert', segment: incoming }]), { authenticatedActor: AGENT })).toThrow(/invalid track, take lane, or range/i);
    }

    const emptyOrReverse = [{ startTick: 0, endTick: 0 }, { startTick: 480, endTick: 120 }];
    for (const changes of emptyOrReverse) {
      const stored = structuredClone(project);
      Object.assign(stored.compSegments[comp.id], changes);
      expect(() => validateProjectIntegrity(stored)).toThrow(/non-empty forward range/i);
      expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'comp-segment.upsert', segment: segment(comp.trackId, comp.takeLaneId, changes) }]), { authenticatedActor: AGENT })).toThrow(/invalid track, take lane, or range/i);
    }

    const mixedRelationship = structuredClone(project);
    mixedRelationship.compSegments[comp.id].trackId = 'missing-track';
    mixedRelationship.compSegments[comp.id].startTick = 0.5;
    expect(() => validateProjectIntegrity(mixedRelationship)).toThrow(/invalid track or take lane/i);
    const mixedMetadata = structuredClone(project);
    mixedMetadata.compSegments[comp.id].revision = -1;
    mixedMetadata.compSegments[comp.id].startTick = 0.5;
    expect(() => applyProjectTransaction(mixedMetadata, transaction(mixedMetadata.id, [{ kind: 'comp-segment.delete', segmentId: comp.id }], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/invalid entity revision/i);

    const corruptTargetOperations: ProjectOperation[] = [
      { kind: 'comp-segment.upsert', segment: { ...comp, startTick: 120, endTick: 720 } },
      { kind: 'comp-segment.delete', segmentId: comp.id },
      { kind: 'take-lane.delete', laneId: take.id },
    ];
    for (const operation of corruptTargetOperations) {
      const corrupted = structuredClone(project);
      corrupted.compSegments[comp.id].startTick = 0.5;
      const before = structuredClone(corrupted);
      expect(() => applyProjectTransaction(corrupted, transaction(corrupted.id, [operation], REVIEWER), { authenticatedActor: REVIEWER })).toThrow(/non-empty forward range/i);
      expect(corrupted).toEqual(before);
    }
    expect(project).toEqual(original);
  });
});
