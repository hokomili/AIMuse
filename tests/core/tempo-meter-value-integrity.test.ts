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
  type ProjectOperation,
  type ProjectTransaction,
  type TempoEvent,
  type TimeSignatureEvent,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-tempo-meter-values', kind: 'agent', name: 'Tempo Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-tempo-meter-reviewer', kind: 'agent', name: 'Tempo Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Tempo/meter value integrity', createdAt: nowIso(), operations };
}

function tempo(tick: number, bpm: number, curve: TempoEvent['curve'] = 'step'): TempoEvent {
  return { ...entityBase('tempo', AGENT), tick, bpm, curve };
}

function meter(tick: number, numerator: number, denominator: TimeSignatureEvent['denominator'] = 4): TimeSignatureEvent {
  return { ...entityBase('meter', AGENT), tick, numerator, denominator };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operations: ProjectOperation[], actor: Actor = AGENT): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo tempo/meter operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('tempo and meter declared-value integrity', () => {
  it('preserves chronological anchors, attribution and semantic inverses across upsert lifecycles', () => {
    let project = createProject('song', 'Tempo/meter lifecycles');
    const valueTempo = tempo(960, 120);
    const valueMeter = meter(960, 4);
    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.upsert', event: valueTempo }, { kind: 'meter.upsert', event: valueMeter },
    ]);
    expect(project.tempoOrder.map((id) => project.tempoEvents[id].tick)).toEqual([0, 960]);
    expect(project.timeSignatureOrder.map((id) => project.timeSignatureEvents[id].tick)).toEqual([0, 960]);
    const tempoCreatedAt = project.tempoEvents[valueTempo.id].createdAt;
    const meterCreatedAt = project.timeSignatureEvents[valueMeter.id].createdAt;

    project = commitAndVerifyInverse(project, [
      {
        kind: 'tempo.upsert', event: { ...valueTempo, tick: 480, bpm: 400, curve: 'linear' },
        expectedRevision: project.tempoEvents[valueTempo.id].revision,
      },
      {
        kind: 'meter.upsert', event: { ...valueMeter, tick: 480, numerator: 32, denominator: 32 },
        expectedRevision: project.timeSignatureEvents[valueMeter.id].revision,
      },
    ], REVIEWER);
    expect(project.tempoEvents[valueTempo.id]).toMatchObject({
      tick: 480, bpm: 400, curve: 'linear', createdAt: tempoCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.timeSignatureEvents[valueMeter.id]).toMatchObject({
      tick: 480, numerator: 32, denominator: 32, createdAt: meterCreatedAt, createdBy: AGENT.id, updatedBy: REVIEWER.id,
    });
    expect(project.tempoEvents[project.tempoOrder[0]].tick).toBe(0);
    expect(project.timeSignatureEvents[project.timeSignatureOrder[0]].tick).toBe(0);

    project = commitAndVerifyInverse(project, [
      { kind: 'tempo.delete', eventId: valueTempo.id }, { kind: 'meter.delete', eventId: valueMeter.id },
    ], REVIEWER);
    expect(project.tempoEvents[valueTempo.id]).toBeUndefined();
    expect(project.timeSignatureEvents[valueMeter.id]).toBeUndefined();
  });

  it('accepts exact declared boundaries and rejects fractional or unsupported values', () => {
    const base = createProject('song', 'Tempo/meter limits');
    const minimumTempo = tempo(480, 20, 'step');
    const maximumTempo = tempo(960, 400, 'linear');
    const minimumMeter = meter(480, 1, 1);
    const maximumMeter = meter(960, 32, 32);
    const project = applyProjectTransaction(base, transaction(base.id, [
      { kind: 'tempo.upsert', event: minimumTempo }, { kind: 'tempo.upsert', event: maximumTempo },
      { kind: 'meter.upsert', event: minimumMeter }, { kind: 'meter.upsert', event: maximumMeter },
    ], AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(project);

    const invalidTempoChanges: Array<Record<string, unknown>> = [
      { tick: -1 }, { tick: 0.5 }, { bpm: 19 }, { bpm: 401 }, { bpm: Number.NaN }, { curve: 'bezier' },
    ];
    for (const changes of invalidTempoChanges) {
      const invalid = structuredClone(project);
      Object.assign(invalid.tempoEvents[minimumTempo.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/Tempo event .* invalid/i);
      const event = { ...project.tempoEvents[minimumTempo.id], ...changes } as unknown as TempoEvent;
      const operation = { kind: 'tempo.upsert', event, expectedRevision: project.tempoEvents[minimumTempo.id].revision } as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], AGENT), { authenticatedActor: AGENT })).toThrow(/Tempo event .* invalid/i);
    }

    const invalidMeterChanges: Array<Record<string, unknown>> = [
      { tick: -1 }, { tick: 0.5 }, { numerator: 0 }, { numerator: 33 }, { numerator: 1.5 }, { denominator: 3 },
    ];
    for (const changes of invalidMeterChanges) {
      const invalid = structuredClone(project);
      Object.assign(invalid.timeSignatureEvents[minimumMeter.id], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/Meter event .* invalid/i);
      const event = { ...project.timeSignatureEvents[minimumMeter.id], ...changes } as unknown as TimeSignatureEvent;
      const operation = { kind: 'meter.upsert', event, expectedRevision: project.timeSignatureEvents[minimumMeter.id].revision } as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], AGENT), { authenticatedActor: AGENT })).toThrow(/Meter event .* invalid/i);
    }
    expect(project.tempoOrder.map((id) => project.tempoEvents[id].tick)).toEqual([0, 480, 960]);
    expect(project.timeSignatureOrder.map((id) => project.timeSignatureEvents[id].tick)).toEqual([0, 480, 960]);
  });
});
