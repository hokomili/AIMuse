import { describe, expect, it } from 'vitest';
import { createId, createProject, entityBase, migrateProject, nowIso, validateProject, validateTransaction } from '@aimuse/core';

describe('wire schemas', () => {
  it('round-trips a valid project and rejects unknown project fields', () => {
    const project = createProject('sfx');
    expect(validateProject(project).kind).toBe('sfx');
    expect(() => validateProject({ ...project, injected: true })).toThrow();
  });

  it('rejects unknown operation kinds and excess fields on strict operations', () => {
    const project = createProject('song');
    const base = { id: createId('tx'), clientOperationId: 'schema-test', projectId: project.id, actor: project.createdBy, label: 'Schema', createdAt: nowIso() };
    expect(() => validateTransaction({ ...base, operations: [{ kind: 'filesystem.execute', command: 'oops' }] })).toThrow();
    expect(() => validateTransaction({ ...base, operations: [{ kind: 'project.rename', name: 'Safe', command: 'oops' }] })).toThrow();
  });

  it('migrates early schema-1 MIDI clips with no pitch-bend collections', () => {
    const project = createProject('song');
    const track = project.tracks[project.trackOrder[0]];
    const timestamp = nowIso();
    const legacy = structuredClone(project) as unknown as Record<string, any>;
    legacy.clips.legacy = {
      id: 'legacy', revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: 'human-local', updatedBy: 'human-local', kind: 'midi', trackId: track.id,
      name: 'Legacy', color: '#8b5cf6', startTick: 0, durationTicks: 960, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' }, loopEnabled: false,
      notes: {}, noteOrder: [], controls: {}, controlOrder: [],
    };
    legacy.tracks[track.id].clipIds.push('legacy');
    expect(migrateProject(legacy).clips.legacy).toMatchObject({ pitchBends: {}, pitchBendOrder: [] });
  });

  it('backfills deterministic SFX variation settings in early schema-1 projects', () => {
    const legacy = structuredClone(createProject('sfx')) as unknown as Record<string, any>;
    legacy.sfxDeliverables.legacy = {
      ...entityBase('sfx'), name: 'Legacy one-shot', startTick: 0, endTick: 960, variantCount: 2, tags: [], seamlessLoop: false,
      targetLufs: -16, namingTemplate: '{name}_{index}', exportFormat: 'wav',
    };
    expect(migrateProject(legacy).sfxDeliverables.legacy).toMatchObject({
      tailMilliseconds: 0,
      variation: { seed: 1, pitchRangeSemitones: 0, gainRangeDb: 0, timingRangeMilliseconds: 0 },
    });
  });
});
