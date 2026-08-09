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
  type EntityBase,
  type Marker,
  type ProjectOperation,
  type ProjectTransaction,
  type SongSection,
  type TempoEvent,
  type TimeSignatureEvent,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-timeline-entity-base', kind: 'agent', name: 'Timeline Entity Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-timeline-entity-base', kind: 'human', name: 'Timeline Entity Reviewer', color: '#a78bfa' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Timeline entity metadata integrity', createdAt: nowIso(), operations };
}

function tempo(tick = 960): TempoEvent {
  return { ...entityBase('tempo', AGENT), tick, bpm: 128, curve: 'step' };
}

function meter(tick = 960): TimeSignatureEvent {
  return { ...entityBase('meter', AGENT), tick, numerator: 3, denominator: 4 };
}

function marker(tick = 480): Marker {
  return { ...entityBase('marker', AGENT), tick, name: 'Marker', color: '#14b8a6', kind: 'marker' };
}

function section(startTick = 0): SongSection {
  return { ...entityBase('section', AGENT), startTick, endTick: startTick + 960, name: 'Section', color: '#f59e0b' };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo timeline entity operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const base = createProject('song', 'Timeline EntityBase values');
  const addedTempo = tempo();
  const addedMeter = meter();
  const point = marker();
  const region = section();
  const project = applyProjectTransaction(base, transaction(base.id, [
    { kind: 'tempo.upsert', event: addedTempo },
    { kind: 'meter.upsert', event: addedMeter },
    { kind: 'marker.add', marker: point },
    { kind: 'section.add', section: region },
  ], AGENT), { authenticatedActor: AGENT }).project;
  return { project, addedTempo, addedMeter, point, region };
}

describe('timeline EntityBase declared metadata integrity', () => {
  it('preserves creation/update attribution, order and semantic add/update/delete inverses', () => {
    let project = createProject('song', 'Timeline EntityBase lifecycles');
    const addedTempo = tempo();
    const addedMeter = meter();
    const point = marker();
    const region = section();
    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.upsert', event: addedTempo },
      { kind: 'meter.upsert', event: addedMeter },
      { kind: 'marker.add', marker: point },
      { kind: 'section.add', section: region },
    ]);
    for (const value of [project.tempoEvents[addedTempo.id], project.timeSignatureEvents[addedMeter.id], project.markers[point.id], project.sections[region.id]]) {
      expect(value).toMatchObject({ revision: 0, createdBy: AGENT.id, updatedBy: AGENT.id });
    }
    const tempoOrder = [...project.tempoOrder]; const meterOrder = [...project.timeSignatureOrder];
    const markerOrder = [...project.markerOrder]; const sectionOrder = [...project.sectionOrder];

    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.upsert', event: { ...project.tempoEvents[addedTempo.id], bpm: 132 }, expectedRevision: project.tempoEvents[addedTempo.id].revision },
      { kind: 'meter.upsert', event: { ...project.timeSignatureEvents[addedMeter.id], numerator: 5 }, expectedRevision: project.timeSignatureEvents[addedMeter.id].revision },
      { kind: 'marker.update', markerId: point.id, changes: { name: 'Reviewed marker' }, expectedRevision: project.markers[point.id].revision },
      { kind: 'section.update', sectionId: region.id, changes: { name: 'Reviewed section' }, expectedRevision: project.sections[region.id].revision },
    ], REVIEWER);
    for (const value of [project.tempoEvents[addedTempo.id], project.timeSignatureEvents[addedMeter.id], project.markers[point.id], project.sections[region.id]]) {
      expect(value).toMatchObject({ revision: 1, createdBy: AGENT.id, updatedBy: REVIEWER.id });
    }
    expect(project.tempoOrder).toEqual(tempoOrder); expect(project.timeSignatureOrder).toEqual(meterOrder);
    expect(project.markerOrder).toEqual(markerOrder); expect(project.sectionOrder).toEqual(sectionOrder);

    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.delete', eventId: addedTempo.id, expectedRevision: project.tempoEvents[addedTempo.id].revision },
      { kind: 'meter.delete', eventId: addedMeter.id, expectedRevision: project.timeSignatureEvents[addedMeter.id].revision },
      { kind: 'marker.delete', markerId: point.id, expectedRevision: project.markers[point.id].revision },
      { kind: 'section.delete', sectionId: region.id, expectedRevision: project.sections[region.id].revision },
    ], REVIEWER);
    expect(project.tempoEvents[addedTempo.id]).toBeUndefined();
    expect(project.timeSignatureEvents[addedMeter.id]).toBeUndefined();
    expect(project.markers[point.id]).toBeUndefined();
    expect(project.sections[region.id]).toBeUndefined();
  });

  it('accepts independent exact metadata boundaries and rejects malformed stored/add/delete entities', () => {
    const { project, addedTempo, addedMeter, point, region } = populatedProject();
    validateProjectIntegrity(project);
    const original = structuredClone(project);
    const families: Array<{
      get: (value: AIMuseProject) => EntityBase;
      add: (changes: Record<string, unknown>) => ProjectOperation;
      remove: ProjectOperation;
    }> = [
      { get: (value) => value.tempoEvents[addedTempo.id], add: (changes) => ({ kind: 'tempo.upsert', event: { ...tempo(1_920), ...changes } } as unknown as ProjectOperation), remove: { kind: 'tempo.delete', eventId: addedTempo.id } },
      { get: (value) => value.timeSignatureEvents[addedMeter.id], add: (changes) => ({ kind: 'meter.upsert', event: { ...meter(1_920), ...changes } } as unknown as ProjectOperation), remove: { kind: 'meter.delete', eventId: addedMeter.id } },
      { get: (value) => value.markers[point.id], add: (changes) => ({ kind: 'marker.add', marker: { ...marker(1_920), ...changes } } as unknown as ProjectOperation), remove: { kind: 'marker.delete', markerId: point.id } },
      { get: (value) => value.sections[region.id], add: (changes) => ({ kind: 'section.add', section: { ...section(1_920), ...changes } } as unknown as ProjectOperation), remove: { kind: 'section.delete', sectionId: region.id } },
    ];

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
    for (const family of families) for (const changes of acceptedCases) {
      const accepted = structuredClone(project);
      Object.assign(family.get(accepted), changes);
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
    for (const family of families) for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(project);
      Object.assign(family.get(invalid), changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
      expect(() => applyProjectTransaction(project, transaction(project.id, [family.add(changes)], AGENT), { authenticatedActor: AGENT })).toThrow(message);
    }

    for (const family of families) {
      const invalid = structuredClone(project);
      family.get(invalid).revision = -1;
      expect(() => applyProjectTransaction(invalid, transaction(invalid.id, [family.remove], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid entity revision/i);
    }
    expect(project).toEqual(original);
  });
});
