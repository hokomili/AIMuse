import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_ACTIVITY_ENTRIES,
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  nowIso,
  validateProjectIntegrity,
  type ActivityEntry,
  type Actor,
  type ProjectOperation,
  type ProjectTransaction,
} from '@aimuse/core';

const AGENT: Actor = {
  id: 'a'.repeat(240), kind: 'agent', name: 'n'.repeat(100), color: 'c'.repeat(40),
  client: { product: 'p'.repeat(100), model: 'm'.repeat(160), effort: 'e'.repeat(80), taskId: 't'.repeat(240), version: 'v'.repeat(80) },
};
const REVIEWER: Actor = { id: 'activity-reviewer', kind: 'human', name: 'Activity Reviewer', color: '#a78bfa' };
const SYSTEM: Actor = { id: 'activity-system', kind: 'system', name: 'Activity System', color: '#94a3b8' };
const SPOOFED: Actor = { id: 'spoofed-actor', kind: 'agent', name: 'Spoofed Actor', color: '#ef4444' };

function transaction(projectId: string, operations: ProjectOperation[], actor: Actor = SPOOFED): ProjectTransaction {
  return { id: 't'.repeat(240), clientOperationId: createId('op'), projectId, actor, label: 'l'.repeat(500), createdAt: nowIso(), operations };
}

function activity(index: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: `activity-${index}`,
    actor: REVIEWER,
    transactionId: `transaction-${index}`,
    label: `Activity ${index}`,
    status: 'committed',
    createdAt: '2026-08-07T00:00:00Z',
    revision: index,
    details: { nested: { values: [1, null, true, 'opaque'] } },
    ...overrides,
  };
}

function semanticProject(project: unknown): unknown {
  return JSON.parse(JSON.stringify(project, (key, value) => ['activity', 'dirty', 'revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : value));
}

describe('activity ledger declared-value integrity', () => {
  it('attributes generated commit, undo and redo entries while preserving semantic history and runtime trimming', () => {
    const base = createProject('song', 'Activity ledger history');
    const committed = applyProjectTransaction(base, transaction(base.id, [{ kind: 'project.rename', name: 'Committed activity name' }]), { authenticatedActor: AGENT });
    const commitEntry = committed.project.activity.at(-1);
    expect(committed.transaction.actor).toEqual(AGENT);
    expect(commitEntry).toMatchObject({ actor: AGENT, transactionId: 't'.repeat(240), label: 'l'.repeat(500), status: 'committed', revision: committed.project.revision });
    validateProjectIntegrity(committed.project);

    const undone = applyHistoryPatches(committed.project, committed.inversePatches, REVIEWER, 'Undo activity edit', 'undo');
    expect(semanticProject(undone)).toEqual(semanticProject(base));
    expect(undone.activity.at(-1)).toMatchObject({ actor: REVIEWER, label: 'Undo activity edit', status: 'undo', revision: undone.revision });

    const redone = applyHistoryPatches(undone, committed.patches, SYSTEM, 'Redo activity edit', 'redo');
    expect(semanticProject(redone)).toEqual(semanticProject(committed.project));
    expect(redone.activity.at(-1)).toMatchObject({ actor: SYSTEM, label: 'Redo activity edit', status: 'redo', revision: redone.revision });
    validateProjectIntegrity(redone);

    const commitAtLimit = structuredClone(base);
    commitAtLimit.activity = Array.from({ length: MAX_RECENT_ACTIVITY_ENTRIES }, (_, index) => activity(index));
    const trimmedCommit = applyProjectTransaction(commitAtLimit, transaction(commitAtLimit.id, [{ kind: 'project.rename', name: 'Trimmed commit' }]), { authenticatedActor: AGENT }).project;
    expect(trimmedCommit.activity).toHaveLength(MAX_RECENT_ACTIVITY_ENTRIES);
    expect(trimmedCommit.activity.at(-1)?.status).toBe('committed');

    const historyAtLimit = structuredClone(base);
    historyAtLimit.activity = Array.from({ length: MAX_RECENT_ACTIVITY_ENTRIES }, (_, index) => activity(index));
    const trimmedHistory = applyHistoryPatches(historyAtLimit, [{ op: 'replace', path: ['name'], value: 'Trimmed history' }], REVIEWER, 'Trimmed undo', 'undo');
    expect(trimmedHistory.activity).toHaveLength(MAX_RECENT_ACTIVITY_ENTRIES);
    expect(trimmedHistory.activity.at(-1)).toMatchObject({ actor: REVIEWER, status: 'undo' });
  });

  it('accepts the stored compatibility ceiling and rejects malformed declared activity or actor values', () => {
    const base = createProject('song', 'Activity ledger values');
    const populated = applyProjectTransaction(base, transaction(base.id, [{ kind: 'project.rename', name: 'Populated activity ledger' }]), { authenticatedActor: AGENT }).project;
    const original = structuredClone(populated);

    const exact = structuredClone(populated);
    exact.activity[0] = activity(0, {
      id: 'i'.repeat(240),
      actor: AGENT,
      transactionId: 't'.repeat(240),
      label: 'l'.repeat(500),
      createdAt: '2026-08-07T01:02:03.456789Z',
      revision: 0,
      details: { any: { nested: ['record', 42, false, null] } },
    });
    validateProjectIntegrity(exact);
    for (const status of ['committed', 'partial', 'conflict', 'failed', 'undo', 'redo', 'checkpoint'] as const) {
      const accepted = structuredClone(exact);
      accepted.activity[0].status = status;
      validateProjectIntegrity(accepted);
    }
    const optional = structuredClone(exact);
    delete optional.activity[0].transactionId;
    delete optional.activity[0].actor.client;
    delete optional.activity[0].details;
    validateProjectIntegrity(optional);

    const compatible = structuredClone(base);
    compatible.activity = Array.from({ length: 10_000 }, (_, index) => activity(index));
    validateProjectIntegrity(compatible);
    const oversized = structuredClone(compatible);
    oversized.activity.push(activity(10_000));
    expect(() => validateProjectIntegrity(oversized)).toThrow(/stored compatibility limit/i);

    const invalidCases: Array<{ changes: Record<string, unknown>; message: RegExp }> = [
      { changes: { id: '' }, message: /invalid ID/i },
      { changes: { id: 'i'.repeat(241) }, message: /invalid ID/i },
      { changes: { id: 42 }, message: /invalid ID/i },
      { changes: { actor: { ...REVIEWER, id: '' } }, message: /actor .* invalid ID/i },
      { changes: { actor: { ...REVIEWER, kind: 'service' } }, message: /invalid kind/i },
      { changes: { actor: { ...REVIEWER, name: '' } }, message: /invalid name/i },
      { changes: { actor: { ...REVIEWER, name: 'n'.repeat(101) } }, message: /invalid name/i },
      { changes: { actor: { ...REVIEWER, color: '' } }, message: /invalid color/i },
      { changes: { actor: { ...REVIEWER, color: 'c'.repeat(41) } }, message: /invalid color/i },
      { changes: { actor: { ...REVIEWER, client: null } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { product: 'p'.repeat(101) } } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { model: 'm'.repeat(161) } } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { effort: 'e'.repeat(81) } } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { taskId: 't'.repeat(241) } } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { version: 'v'.repeat(81) } } }, message: /invalid client metadata/i },
      { changes: { actor: { ...REVIEWER, client: { product: 42 } } }, message: /invalid client metadata/i },
      { changes: { transactionId: '' }, message: /invalid transaction ID/i },
      { changes: { transactionId: 't'.repeat(241) }, message: /invalid transaction ID/i },
      { changes: { transactionId: 42 }, message: /invalid transaction ID/i },
      { changes: { label: '' }, message: /invalid label/i },
      { changes: { label: 'l'.repeat(501) }, message: /invalid label/i },
      { changes: { label: 42 }, message: /invalid label/i },
      { changes: { status: 'cancelled' }, message: /invalid status/i },
      { changes: { createdAt: '2026-02-30T00:00:00Z' }, message: /invalid timestamp/i },
      { changes: { createdAt: '2026-08-07T00:00:00+00:00' }, message: /invalid timestamp/i },
      { changes: { createdAt: 42 }, message: /invalid timestamp/i },
      { changes: { revision: -1 }, message: /invalid revision/i },
      { changes: { revision: 0.5 }, message: /invalid revision/i },
      { changes: { revision: Number.NaN }, message: /invalid revision/i },
      { changes: { details: null }, message: /invalid details/i },
      { changes: { details: [] }, message: /invalid details/i },
      { changes: { details: 'opaque-but-not-a-record' }, message: /invalid details/i },
    ];
    for (const { changes, message } of invalidCases) {
      const invalid = structuredClone(populated);
      Object.assign(invalid.activity[0], changes);
      expect(() => validateProjectIntegrity(invalid)).toThrow(message);
    }

    const invalidActor = { ...AGENT, name: '' } as Actor;
    expect(() => applyProjectTransaction(base, transaction(base.id, [{ kind: 'project.rename', name: 'Rejected actor' }]), { authenticatedActor: invalidActor })).toThrow(/invalid name/i);
    expect(() => applyHistoryPatches(populated, [], invalidActor, 'Rejected undo actor', 'undo')).toThrow(/invalid name/i);
    expect(() => applyHistoryPatches(populated, [], REVIEWER, '', 'redo')).toThrow(/invalid label/i);
    expect(populated).toEqual(original);
  });
});
