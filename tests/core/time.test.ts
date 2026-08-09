import { describe, expect, it } from 'vitest';
import { applyProjectTransaction, createId, createProject, entityBase, nowIso, samplesToTicks, ticksToSamples, ticksToSeconds, type ProjectTransaction } from '@aimuse/core';

describe('musical time conversion', () => {
  it('converts ticks across step tempo changes', () => {
    const project = createProject('song');
    const event = { ...entityBase('tempo'), tick: 3840, bpm: 60, curve: 'step' as const };
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: 'tempo-change', projectId: project.id, actor: project.createdBy, label: 'Tempo change', createdAt: nowIso(), operations: [{ kind: 'tempo.upsert', event }] };
    const changed = applyProjectTransaction(project, tx).project;
    expect(ticksToSeconds(changed, 5760)).toBeCloseTo(4, 6);
    const samples = ticksToSamples(changed, 5760);
    expect(samples).toBe(192_000);
    expect(samplesToTicks(changed, samples)).toBe(5760);
  });
});
