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
  type Marker,
  type ProjectOperation,
  type ProjectTransaction,
  type SongSection,
  type TempoEvent,
  type TimeSignatureEvent,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-timeline', kind: 'agent', name: 'Timeline Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-timeline-reviewer', kind: 'agent', name: 'Timeline Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Timeline integrity', createdAt: nowIso(), operations };
}

function tempo(tick: number, bpm: number): TempoEvent {
  return { ...entityBase('tempo', AGENT), tick, bpm, curve: 'step' };
}

function meter(tick: number, numerator = 4): TimeSignatureEvent {
  return { ...entityBase('meter', AGENT), tick, numerator, denominator: 4 };
}

function marker(tick: number, name: string, endTick?: number): Marker {
  return { ...entityBase('marker', AGENT), tick, endTick, name, color: '#14b8a6', kind: endTick === undefined ? 'marker' : 'region' };
}

function section(startTick: number, endTick: number, name: string): SongSection {
  return { ...entityBase('section', AGENT), startTick, endTick, name, color: '#f59e0b', energy: 0.5 };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo timeline operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

function populatedProject() {
  const project = createProject('song', 'Timeline integrity');
  const addedTempo = tempo(960, 128);
  const addedMeter = meter(960, 3);
  const point = marker(480, 'Point');
  const region = marker(960, 'Region', 1440);
  const intro = section(0, 960, 'Intro');
  const verse = section(960, 1920, 'Verse');
  return {
    project: applyProjectTransaction(project, transaction(project.id, [
      { kind: 'tempo.upsert', event: addedTempo },
      { kind: 'meter.upsert', event: addedMeter },
      { kind: 'marker.add', marker: point },
      { kind: 'marker.add', marker: region, index: 0 },
      { kind: 'section.add', section: intro },
      { kind: 'section.add', section: verse, index: 0 },
    ], AGENT), { authenticatedActor: AGENT }).project,
    addedTempo,
    addedMeter,
    point,
    region,
    intro,
    verse,
  };
}

describe('tempo, meter, marker and section integrity', () => {
  it('keeps declared ordering and lifecycles semantically invertible', () => {
    let project = createProject('song', 'Timeline inverses');
    const earlyTempo = tempo(960, 124);
    const lateTempo = tempo(1920, 132);
    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.upsert', event: lateTempo },
      { kind: 'tempo.upsert', event: earlyTempo },
    ]);
    expect(project.tempoOrder.map((id) => project.tempoEvents[id].tick)).toEqual([0, 960, 1920]);
    const tempoCreatedAt = project.tempoEvents[lateTempo.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'tempo.upsert', event: { ...lateTempo, tick: 480, bpm: 136, curve: 'linear' }, expectedRevision: project.tempoEvents[lateTempo.id].revision,
    }], REVIEWER);
    expect(project.tempoOrder.map((id) => project.tempoEvents[id].tick)).toEqual([0, 480, 960]);
    expect(project.tempoEvents[lateTempo.id]).toMatchObject({ createdAt: tempoCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, bpm: 136 });
    project = commitAndVerifyInverse(project, [{ kind: 'tempo.delete', eventId: earlyTempo.id }]);
    expect(project.tempoEvents[earlyTempo.id]).toBeUndefined();

    const earlyMeter = meter(960, 3);
    const lateMeter = meter(1920, 7);
    project = commitAndVerifyInverse(project, [
      { kind: 'meter.upsert', event: lateMeter },
      { kind: 'meter.upsert', event: earlyMeter },
    ]);
    expect(project.timeSignatureOrder.map((id) => project.timeSignatureEvents[id].tick)).toEqual([0, 960, 1920]);
    const meterCreatedAt = project.timeSignatureEvents[lateMeter.id].createdAt;
    project = commitAndVerifyInverse(project, [{
      kind: 'meter.upsert', event: { ...lateMeter, tick: 240, numerator: 5 }, expectedRevision: project.timeSignatureEvents[lateMeter.id].revision,
    }], REVIEWER);
    expect(project.timeSignatureOrder.map((id) => project.timeSignatureEvents[id].tick)).toEqual([0, 240, 960]);
    expect(project.timeSignatureEvents[lateMeter.id]).toMatchObject({ createdAt: meterCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, numerator: 5 });
    project = commitAndVerifyInverse(project, [{ kind: 'meter.delete', eventId: earlyMeter.id }]);
    expect(project.timeSignatureEvents[earlyMeter.id]).toBeUndefined();

    const firstMarker = marker(120, 'Early marker');
    const laterMarker = marker(960, 'Later marker');
    project = commitAndVerifyInverse(project, [
      { kind: 'marker.add', marker: firstMarker },
      { kind: 'marker.add', marker: laterMarker, index: 0 },
    ]);
    expect(project.markerOrder).toEqual([laterMarker.id, firstMarker.id]);
    project = commitAndVerifyInverse(project, [{
      kind: 'marker.update', markerId: laterMarker.id, changes: { tick: 1080, endTick: 1320, name: 'Reviewed region', kind: 'region' }, expectedRevision: project.markers[laterMarker.id].revision,
    }], REVIEWER);
    expect(project.markerOrder).toEqual([laterMarker.id, firstMarker.id]);
    expect(project.markers[laterMarker.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, endTick: 1320 });
    project = commitAndVerifyInverse(project, [{ kind: 'marker.delete', markerId: firstMarker.id }]);
    expect(project.markers[firstMarker.id]).toBeUndefined();

    const intro = section(0, 960, 'Intro');
    const outro = section(1920, 2880, 'Outro');
    project = commitAndVerifyInverse(project, [
      { kind: 'section.add', section: intro },
      { kind: 'section.add', section: outro, index: 0 },
    ]);
    expect(project.sectionOrder).toEqual([outro.id, intro.id]);
    project = commitAndVerifyInverse(project, [{
      kind: 'section.update', sectionId: outro.id, changes: { startTick: 2160, endTick: 3360, energy: 0.75, prompt: 'Reviewed' }, expectedRevision: project.sections[outro.id].revision,
    }], REVIEWER);
    expect(project.sectionOrder).toEqual([outro.id, intro.id]);
    expect(project.sections[outro.id]).toMatchObject({ createdBy: AGENT.id, updatedBy: REVIEWER.id, startTick: 2160, endTick: 3360 });
    project = commitAndVerifyInverse(project, [{ kind: 'section.delete', sectionId: intro.id }]);
    expect(project.sections[intro.id]).toBeUndefined();

    const zeroTempoId = project.tempoOrder.find((id) => project.tempoEvents[id].tick === 0)!;
    const zeroMeterId = project.timeSignatureOrder.find((id) => project.timeSignatureEvents[id].tick === 0)!;
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'tempo.delete', eventId: zeroTempoId }], AGENT), { authenticatedActor: AGENT })).toThrow(/keep a tempo event at tick zero/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{ kind: 'meter.delete', eventId: zeroMeterId }], AGENT), { authenticatedActor: AGENT })).toThrow(/keep a meter event at tick zero/i);
  });

  it('rejects incomplete orders and invalid declared ranges without imposing overlap policy', () => {
    const { project, addedTempo, addedMeter, point, region, intro, verse } = populatedProject();
    validateProjectIntegrity(project);
    expect(project.markerOrder).toEqual([region.id, point.id]);
    expect(project.sectionOrder).toEqual([verse.id, intro.id]);

    const duplicateTempo = structuredClone(project);
    duplicateTempo.tempoOrder.push(addedTempo.id);
    expect(() => validateProjectIntegrity(duplicateTempo)).toThrow(/tempo order is incomplete or contains duplicates/i);

    const orphanTempo = structuredClone(project);
    orphanTempo.tempoOrder = orphanTempo.tempoOrder.filter((id) => id !== addedTempo.id);
    expect(() => validateProjectIntegrity(orphanTempo)).toThrow(/tempo order is incomplete or contains duplicates/i);

    const unsortedTempo = structuredClone(project);
    unsortedTempo.tempoOrder.reverse();
    expect(() => validateProjectIntegrity(unsortedTempo)).toThrow(/tempo order is not chronological/i);

    const noZeroTempo = structuredClone(project);
    noZeroTempo.tempoEvents[noZeroTempo.tempoOrder[0]].tick = 1;
    expect(() => validateProjectIntegrity(noZeroTempo)).toThrow(/tempo at tick zero/i);

    const invalidTempo = structuredClone(project);
    invalidTempo.tempoEvents[addedTempo.id].bpm = 401;
    expect(() => validateProjectIntegrity(invalidTempo)).toThrow(/invalid tick or BPM/i);

    const duplicateMeter = structuredClone(project);
    duplicateMeter.timeSignatureOrder.push(addedMeter.id);
    expect(() => validateProjectIntegrity(duplicateMeter)).toThrow(/meter order is incomplete or contains duplicates/i);

    const unsortedMeter = structuredClone(project);
    unsortedMeter.timeSignatureOrder.reverse();
    expect(() => validateProjectIntegrity(unsortedMeter)).toThrow(/meter order is not chronological/i);

    const invalidMeter = structuredClone(project);
    invalidMeter.timeSignatureEvents[addedMeter.id].numerator = 0;
    expect(() => validateProjectIntegrity(invalidMeter)).toThrow(/invalid tick or signature/i);

    const duplicateMarker = structuredClone(project);
    duplicateMarker.markerOrder.push(point.id);
    expect(() => validateProjectIntegrity(duplicateMarker)).toThrow(/marker order is incomplete or contains duplicates/i);

    const invalidMarker = structuredClone(project);
    invalidMarker.markers[region.id].endTick = invalidMarker.markers[region.id].tick;
    expect(() => validateProjectIntegrity(invalidMarker)).toThrow(/marker .* invalid range/i);

    const incompleteSections = structuredClone(project);
    incompleteSections.sectionOrder = incompleteSections.sectionOrder.filter((id) => id !== intro.id);
    expect(() => validateProjectIntegrity(incompleteSections)).toThrow(/section order is incomplete or contains duplicates/i);

    const invalidSection = structuredClone(project);
    invalidSection.sections[verse.id].endTick = invalidSection.sections[verse.id].startTick;
    expect(() => validateProjectIntegrity(invalidSection)).toThrow(/section .* invalid range or energy/i);

    const invalidEnergy = structuredClone(project);
    invalidEnergy.sections[intro.id].energy = 1.1;
    expect(() => validateProjectIntegrity(invalidEnergy)).toThrow(/section .* invalid range or energy/i);

    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'marker.update', markerId: region.id, changes: { endTick: region.tick }, expectedRevision: project.markers[region.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/marker .* invalid range/i);
    expect(() => applyProjectTransaction(project, transaction(project.id, [{
      kind: 'section.update', sectionId: verse.id, changes: { endTick: verse.startTick }, expectedRevision: project.sections[verse.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/section .* invalid range or energy/i);
  });
});
