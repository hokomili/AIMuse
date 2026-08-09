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
  type ProjectOperation,
  type ProjectTransaction,
  type SfxDeliverable,
} from '@aimuse/core';

const AGENT: Actor = { id: 'agent-sfx', kind: 'agent', name: 'SFX Agent', color: '#22d3ee', client: { product: 'vitest', model: 'fixture' } };
const REVIEWER: Actor = { id: 'agent-sfx-reviewer', kind: 'agent', name: 'SFX Reviewer', color: '#a78bfa', client: { product: 'vitest', model: 'fixture-review' } };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor): ProjectTransaction {
  return { id: createId('tx'), clientOperationId: createId('op'), projectId, actor, label: 'SFX deliverable integrity', createdAt: nowIso(), operations };
}

function deliverable(): SfxDeliverable {
  return {
    ...entityBase('deliverable', AGENT), name: 'Impact', startTick: 0, endTick: 960, variantCount: 2, tags: ['impact'], seamlessLoop: false,
    tailMilliseconds: 250, variation: { seed: 7, pitchRangeSemitones: 2, gainRangeDb: 3, timingRangeMilliseconds: 25 },
    targetLufs: -16, namingTemplate: '{name}_{index}', exportFormat: 'wav',
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

function commitAndVerifyInverse(project: ReturnType<typeof createProject>, operations: ProjectOperation[], actor: Actor = AGENT) {
  const committed = applyProjectTransaction(project, transaction(project.id, operations, actor), { authenticatedActor: actor });
  const undone = applyHistoryPatches(committed.project, committed.inversePatches, actor, 'Undo SFX deliverable operation', 'undo');
  expect(semanticProject(undone)).toEqual(semanticProject(project));
  validateProjectIntegrity(committed.project);
  return committed.project;
}

describe('SFX deliverable integrity', () => {
  it('keeps declared add, update and delete lifecycles semantically invertible', () => {
    let project = createProject('sfx', 'SFX deliverable inverses');
    const value = deliverable();
    project = commitAndVerifyInverse(project, [{ kind: 'sfx-deliverable.add', deliverable: value }]);
    const createdAt = project.sfxDeliverables[value.id].createdAt;

    project = commitAndVerifyInverse(project, [{
      kind: 'sfx-deliverable.update', deliverableId: value.id,
      changes: {
        name: 'Reviewed impact', startTick: 120, endTick: 1_200, variantCount: 3, tags: ['impact', 'reviewed'], seamlessLoop: true,
        loopStartSample: 100, loopEndSample: 1_000, tailMilliseconds: 500,
        variation: { seed: 11, pitchRangeSemitones: 4, gainRangeDb: 2, timingRangeMilliseconds: 40 },
        targetLufs: -14, namingTemplate: '{name}_{index}_reviewed', exportFormat: 'flac',
      },
      expectedRevision: project.sfxDeliverables[value.id].revision,
    }], REVIEWER);
    expect(project.sfxDeliverables[value.id]).toMatchObject({
      createdAt, createdBy: AGENT.id, updatedBy: REVIEWER.id, name: 'Reviewed impact', startTick: 120, endTick: 1_200,
      variantCount: 3, loopStartSample: 100, loopEndSample: 1_000, targetLufs: -14, exportFormat: 'flac',
    });

    project = commitAndVerifyInverse(project, [{
      kind: 'sfx-deliverable.delete', deliverableId: value.id, expectedRevision: project.sfxDeliverables[value.id].revision,
    }], REVIEWER);
    expect(project.sfxDeliverables[value.id]).toBeUndefined();
  });

  it('rejects every declared range/value violation without interpreting output behavior', () => {
    const project = createProject('sfx', 'SFX deliverable validation');
    const value = deliverable();
    const populated = applyProjectTransaction(project, transaction(project.id, [{ kind: 'sfx-deliverable.add', deliverable: value }], AGENT), { authenticatedActor: AGENT }).project;
    validateProjectIntegrity(populated);

    const textMutations: Array<(item: SfxDeliverable) => void> = [
      (item) => { item.name = ''; },
      (item) => { item.tags = Array.from({ length: 101 }, () => 'tag'); },
      (item) => { item.tags = ['x'.repeat(101)]; },
      (item) => { item.namingTemplate = ''; },
      (item) => { item.exportFormat = 'ogg' as SfxDeliverable['exportFormat']; },
    ];
    for (const mutate of textMutations) {
      const invalid = structuredClone(populated);
      mutate(invalid.sfxDeliverables[value.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/invalid text or format values/i);
    }

    const rangeMutations: Array<(item: SfxDeliverable) => void> = [
      (item) => { item.startTick = -1; },
      (item) => { item.endTick = item.startTick; },
      (item) => { item.variantCount = 0; },
      (item) => { item.variantCount = 1_001; },
    ];
    for (const mutate of rangeMutations) {
      const invalid = structuredClone(populated);
      mutate(invalid.sfxDeliverables[value.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/invalid range or variant count/i);
    }

    const invalidLoopValue = structuredClone(populated);
    invalidLoopValue.sfxDeliverables[value.id].loopStartSample = -1;
    invalidLoopValue.sfxDeliverables[value.id].loopEndSample = 100;
    expect(() => validateProjectIntegrity(invalidLoopValue)).toThrow(/invalid loop point values/i);

    const incompleteLoop = structuredClone(populated);
    incompleteLoop.sfxDeliverables[value.id].loopStartSample = 100;
    expect(() => validateProjectIntegrity(incompleteLoop)).toThrow(/incomplete loop points/i);

    const reversedLoop = structuredClone(populated);
    reversedLoop.sfxDeliverables[value.id].loopStartSample = 100;
    reversedLoop.sfxDeliverables[value.id].loopEndSample = 100;
    expect(() => validateProjectIntegrity(reversedLoop)).toThrow(/invalid loop points/i);

    const variationMutations: Array<(item: SfxDeliverable) => void> = [
      (item) => { item.tailMilliseconds = 60_001; },
      (item) => { item.variation.seed = 1.5; },
      (item) => { item.variation.pitchRangeSemitones = 25; },
      (item) => { item.variation.gainRangeDb = -1; },
      (item) => { item.variation.timingRangeMilliseconds = 5_001; },
    ];
    for (const mutate of variationMutations) {
      const invalid = structuredClone(populated);
      mutate(invalid.sfxDeliverables[value.id]);
      expect(() => validateProjectIntegrity(invalid)).toThrow(/invalid tail or variation values/i);
    }

    const invalidLoudness = structuredClone(populated);
    invalidLoudness.sfxDeliverables[value.id].targetLufs = -37;
    expect(() => validateProjectIntegrity(invalidLoudness)).toThrow(/invalid loudness target/i);

    expect(() => applyProjectTransaction(populated, transaction(populated.id, [{
      kind: 'sfx-deliverable.update', deliverableId: value.id, changes: { variantCount: 0 }, expectedRevision: populated.sfxDeliverables[value.id].revision,
    }], AGENT), { authenticatedActor: AGENT })).toThrow(/invalid range or variant count/i);
    expect(() => applyProjectTransaction(populated, transaction(populated.id, [{ kind: 'sfx-deliverable.add', deliverable: value }], AGENT), { authenticatedActor: AGENT })).toThrow(/deliverable ID already exists/i);
  });
});
