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
  type Marker,
  type ProjectOperation,
  type ProjectTransaction,
  type SongSection,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-marker-section-text', kind: 'agent', name: 'Arrangement Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-marker-section-reviewer', kind: 'agent', name: 'Arrangement Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Marker/section text integrity', createdAt: nowIso(), operations };
}

function marker(tick: number, name: string): Marker {
  return { ...entityBase('marker', AGENT), tick, name, color: '#14b8a6', kind: 'marker' };
}

function section(startTick: number, endTick: number, name: string): SongSection {
  return { ...entityBase('section', AGENT), startTick, endTick, name, color: '#f59e0b', prompt: 'Initial prompt' };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo marker/section operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('marker and section textual integrity', () => {
  it('preserves explicit order, attribution and semantic inverses across add, update and delete', () => {
    let project = createProject('song', 'Marker and section text');
    const firstMarker = marker(120, 'First marker');
    const reviewedMarker = marker(960, 'Review marker');
    const firstSection = section(0, 960, 'Intro');
    const reviewedSection = section(960, 1_920, 'Verse');
    project = commitAndVerifyInverse(project, [
      { kind: 'marker.add', marker: firstMarker }, { kind: 'marker.add', marker: reviewedMarker, index: 0 },
      { kind: 'section.add', section: firstSection }, { kind: 'section.add', section: reviewedSection, index: 0 },
    ]);
    expect(project.markerOrder).toEqual([reviewedMarker.id, firstMarker.id]);
    expect(project.sectionOrder).toEqual([reviewedSection.id, firstSection.id]);
    const markerCreatedAt = project.markers[reviewedMarker.id].createdAt;
    const sectionCreatedAt = project.sections[reviewedSection.id].createdAt;

    project = commitAndVerifyInverse(project, [
      {
        kind: 'marker.update', markerId: reviewedMarker.id,
        changes: { name: 'Reviewed marker', color: '#0f766e', kind: 'region' },
        expectedRevision: project.markers[reviewedMarker.id].revision,
      },
      {
        kind: 'section.update', sectionId: reviewedSection.id,
        changes: { name: 'Reviewed verse', color: '#d97706', prompt: 'Reviewed prompt' },
        expectedRevision: project.sections[reviewedSection.id].revision,
      },
    ], REVIEWER);
    expect(project.markerOrder).toEqual([reviewedMarker.id, firstMarker.id]);
    expect(project.sectionOrder).toEqual([reviewedSection.id, firstSection.id]);
    expect(project.markers[reviewedMarker.id]).toMatchObject({
      createdAt: markerCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
      name: 'Reviewed marker', color: '#0f766e', kind: 'region',
    });
    expect(project.markers[reviewedMarker.id].endTick).toBeUndefined();
    expect(project.sections[reviewedSection.id]).toMatchObject({
      createdAt: sectionCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
      name: 'Reviewed verse', color: '#d97706', prompt: 'Reviewed prompt',
    });

    project = commitAndVerifyInverse(project, [
      { kind: 'marker.delete', markerId: firstMarker.id },
      { kind: 'section.delete', sectionId: firstSection.id },
    ], REVIEWER);
    expect(project.markers[firstMarker.id]).toBeUndefined();
    expect(project.sections[firstSection.id]).toBeUndefined();
  });

  it('accepts declared boundaries and rejects invalid text/kind values without inferred semantics', () => {
    const base = createProject('song', 'Marker/section limits');
    const valueMarker = marker(480, 'Boundary marker');
    const valueSection = section(0, 960, 'Boundary section');
    const project = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'marker.add', marker: valueMarker }, { kind: 'section.add', section: valueSection },
    ], AGENT), { authenticatedActor: AGENT }).project;
    const boundary = applyProjectTransaction(project, transaction(project.id, [
      {
        kind: 'marker.update', markerId: valueMarker.id,
        changes: { name: 'm'.repeat(200), color: 'c'.repeat(40), kind: 'cue' },
      },
      {
        kind: 'section.update', sectionId: valueSection.id,
        changes: { name: 's'.repeat(200), color: 'c'.repeat(40), prompt: 'p'.repeat(10_000) },
      },
    ], AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(boundary);

    const invalidMarkerChanges: Array<Record<string, unknown>> = [
      { name: '' }, { name: 'm'.repeat(201) }, { name: 42 },
      { color: 'c'.repeat(41) }, { color: 42 }, { kind: 'chapter' },
    ];
    for (const changes of invalidMarkerChanges) {
      const invalid = structuredClone(project);
      Object.assign(invalid.markers[valueMarker.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/Marker .* invalid text values/i);
      const operation = { kind: 'marker.update', markerId: valueMarker.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], AGENT), { authenticatedActor: AGENT })).toThrow(/Marker .* invalid text values/i);
    }

    const invalidSectionChanges: Array<Record<string, unknown>> = [
      { name: '' }, { name: 's'.repeat(201) }, { name: 42 },
      { color: 'c'.repeat(41) }, { color: 42 },
      { prompt: 'p'.repeat(10_001) }, { prompt: 42 },
    ];
    for (const changes of invalidSectionChanges) {
      const invalid = structuredClone(project);
      Object.assign(invalid.sections[valueSection.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/Section .* invalid text values/i);
      const operation = { kind: 'section.update', sectionId: valueSection.id, changes } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], AGENT), { authenticatedActor: AGENT })).toThrow(/Section .* invalid text values/i);
    }
    expect(project.markerOrder).toEqual([valueMarker.id]);
    expect(project.sectionOrder).toEqual([valueSection.id]);
  });
});
