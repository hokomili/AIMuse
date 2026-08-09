import { describe, expect, it } from 'vitest';
import {
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  nowIso,
  validateProjectIntegrity,
  type Actor,
  type AIMuseProject,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-project-settings', kind: 'agent', name: 'Settings Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-project-settings-reviewer', kind: 'agent', name: 'Settings Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'Project metadata and settings integrity', createdAt: nowIso(), operations };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: AIMuseProject, operation: ProjectOperation, actor: Actor): AIMuseProject {
  const committed = applyProjectTransaction(project, transaction(project.id, [operation], actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo project metadata/settings operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  expect(committed.project.activity.at(-1)?.actor.id).toBe(actor.id);
  return committed.project;
}

describe('project metadata and settings integrity', () => {
  it('keeps declared rename and settings-update lifecycles semantically invertible', () => {
    let project = createProject('song', 'Original project');
    project = commitAndVerifyInverse(project, { kind: 'project.rename', name: '  Renamed project  ' }, AGENT);
    expect(project.name).toBe('Renamed project');

    const beforeSettings = structuredClone(project.settings);
    project = commitAndVerifyInverse(project, {
      kind: 'project.settings.update',
      changes: {
        sampleRate: 96_000,
        channelLayout: 'mono',
        ppq: 960,
        recordBitDepth: 32,
        countInBars: 4,
        metronomeEnabled: false,
        defaultCrossfadeTicks: 480,
        masterLufsTarget: -18,
      },
    }, REVIEWER);
    expect(project.settings).toEqual({
      sampleRate: 96_000,
      channelLayout: 'mono',
      ppq: 960,
      recordBitDepth: 32,
      countInBars: 4,
      metronomeEnabled: false,
      defaultCrossfadeTicks: 480,
      masterLufsTarget: -18,
    });
    expect(project.settings).not.toEqual(beforeSettings);
  });

  it('rejects undeclared metadata and settings values without inventing product policy', () => {
    const project = createProject('song', 'Project integrity');
    const invalidMetadata: Array<(value: AIMuseProject) => void> = [
      (value) => { value.name = ''; },
      (value) => { value.name = 'x'.repeat(201); },
      (value) => { value.kind = 'podcast' as AIMuseProject['kind']; },
    ];
    for (const mutate of invalidMetadata) {
      const invalid = structuredClone(project);
      mutate(invalid);
      expect(() => validateProjectIntegrity(invalid)).toThrow();
    }

    const invalidSettings: Array<[keyof AIMuseProject['settings'], unknown]> = [
      ['sampleRate', 88_200],
      ['channelLayout', 'surround'],
      ['ppq', 480],
      ['recordBitDepth', 16],
      ['countInBars', 1.5],
      ['countInBars', 9],
      ['metronomeEnabled', 'yes'],
      ['defaultCrossfadeTicks', 0.5],
      ['defaultCrossfadeTicks', -1],
      ['masterLufsTarget', Number.POSITIVE_INFINITY],
      ['masterLufsTarget', -37],
    ];
    for (const [key, invalidValue] of invalidSettings) {
      const invalid = structuredClone(project);
      (invalid.settings as unknown as Record<string, unknown>)[key] = invalidValue;
      expect(() => validateProjectIntegrity(invalid)).toThrow();
      const operation = { kind: 'project.settings.update', changes: { [key]: invalidValue } } as unknown as ProjectOperation;
      expect(() => applyProjectTransaction(project, transaction(project.id, [operation], AGENT), { authenticatedActor: AGENT })).toThrow();
      expect(project.settings).toEqual(createProject('song', 'Comparison').settings);
    }

    const oversizedEdit = { kind: 'project.settings.update', changes: { defaultCrossfadeTicks: 960 * 16 + 1 } } as ProjectOperation;
    expect(() => applyProjectTransaction(project, transaction(project.id, [oversizedEdit], AGENT), { authenticatedActor: AGENT })).toThrow(/Crossfade/i);
    const schemaValidStoredValue = structuredClone(project);
    schemaValidStoredValue.settings.defaultCrossfadeTicks = 960 * 16 + 1;
    expect(() => validateProjectIntegrity(schemaValidStoredValue)).not.toThrow();
  });
});
