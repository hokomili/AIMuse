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
  type ProjectSettings,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-settings-round-trip', kind: 'agent', name: 'Settings Property Agent', color: '#22d3ee' };
const REVIEWER: Actor = { id: 'reviewer-settings-round-trip', kind: 'human', name: 'Settings Property Reviewer', color: '#a78bfa' };

function transaction(projectId: string, changes: Partial<ProjectSettings>, label: string): ProjectTransaction {
  const operation: ProjectOperation = { kind: 'project.settings.update', changes };
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor: AGENT, label, createdAt: nowIso(), operations: [operation] };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commit(project: AIMuseProject, changes: Partial<ProjectSettings>, label: string) {
  return applyProjectTransaction(project, transaction(project.id, changes, label), { authenticatedActor: AGENT });
}

function verifyTwoWayRoundTrip(project: AIMuseProject, changes: Partial<ProjectSettings>, label: string): void {
  const expectedSettings = { ...project.settings, ...changes };
  const committed = commit(project, changes, label);
  expect(committed.project.settings).toEqual(expectedSettings);
  for (const key of Object.keys(project.settings) as Array<keyof ProjectSettings>) {
    if (!(key in changes)) expect(committed.project.settings[key]).toBe(project.settings[key]);
  }
  validateProjectIntegrity(committed.project);

  const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, `Undo ${label}`, 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(undone);

  const redone = applyHistoryPatches(undone, committed.patches, AGENT, `Redo ${label}`, 'redo');
  expect(semanticProject(redone)).toEqual(semanticProject(committed.project));
  validateProjectIntegrity(redone);
}

describe('project settings operation semantic round trips', () => {
  it('preserves every untouched field and replays each declared partial-setting value in both directions', () => {
    const cases: Array<{ label: string; before?: Partial<ProjectSettings>; changes: Partial<ProjectSettings> }> = [
      { label: 'sample rate 44.1 kHz', changes: { sampleRate: 44_100 } },
      { label: 'sample rate 48 kHz', before: { sampleRate: 96_000 }, changes: { sampleRate: 48_000 } },
      { label: 'sample rate 96 kHz', changes: { sampleRate: 96_000 } },
      { label: 'mono layout', changes: { channelLayout: 'mono' } },
      { label: 'stereo layout', before: { channelLayout: 'mono' }, changes: { channelLayout: 'stereo' } },
      { label: 'fixed PPQ', changes: { ppq: 960 } },
      { label: '24-bit recording', before: { recordBitDepth: 32 }, changes: { recordBitDepth: 24 } },
      { label: '32-bit recording', changes: { recordBitDepth: 32 } },
      { label: 'zero count-in', changes: { countInBars: 0 } },
      { label: 'maximum count-in', changes: { countInBars: 8 } },
      { label: 'metronome disabled', changes: { metronomeEnabled: false } },
      { label: 'metronome enabled', before: { metronomeEnabled: false }, changes: { metronomeEnabled: true } },
      { label: 'zero crossfade', changes: { defaultCrossfadeTicks: 0 } },
      { label: 'maximum editable crossfade', changes: { defaultCrossfadeTicks: 960 * 16 } },
      { label: 'minimum LUFS target', changes: { masterLufsTarget: -36 } },
      { label: 'maximum LUFS target', changes: { masterLufsTarget: -5 } },
    ];

    for (const value of cases) {
      const project = createProject('song', `Settings property: ${value.label}`, AGENT);
      if (value.before) Object.assign(project.settings, value.before);
      validateProjectIntegrity(project);
      verifyTwoWayRoundTrip(project, value.changes, value.label);
    }
  });

  it('restores and reapplies stacked partial updates in strict transaction order', () => {
    const base = createProject('song', 'Stacked settings round trip', AGENT);
    const first = commit(base, { sampleRate: 96_000, countInBars: 8, metronomeEnabled: false }, 'first settings layer');
    const second = commit(first.project, {
      channelLayout: 'mono', recordBitDepth: 32, defaultCrossfadeTicks: 480, masterLufsTarget: -18,
    }, 'second settings layer');
    validateProjectIntegrity(first.project);
    validateProjectIntegrity(second.project);

    const undoSecond = applyHistoryPatches(second.project, second.inversePatches, REVIEWER, 'Undo second settings layer', 'undo');
    expect(semanticProject(undoSecond)).toEqual(semanticProject(first.project));
    const undoFirst = applyHistoryPatches(undoSecond, first.inversePatches, REVIEWER, 'Undo first settings layer', 'undo');
    expect(semanticProject(undoFirst)).toEqual(semanticProject(base));

    const redoFirst = applyHistoryPatches(undoFirst, first.patches, AGENT, 'Redo first settings layer', 'redo');
    expect(semanticProject(redoFirst)).toEqual(semanticProject(first.project));
    const redoSecond = applyHistoryPatches(redoFirst, second.patches, AGENT, 'Redo second settings layer', 'redo');
    expect(semanticProject(redoSecond)).toEqual(semanticProject(second.project));
    validateProjectIntegrity(undoSecond);
    validateProjectIntegrity(undoFirst);
    validateProjectIntegrity(redoFirst);
    validateProjectIntegrity(redoSecond);
  });
});
