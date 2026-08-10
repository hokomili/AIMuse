import { describe, expect, it } from 'vitest';
import { createProject, HUMAN_ACTOR, type ProjectTransaction } from '@aimuse/core';
import type { TransactionTraceEntry } from '../../src/common/contracts';
import { buildTraceReplayAudit, sha256Json, type ReplayableTraceEntry } from '../../src/main/trace-replay-audit';

describe('trace replay audit receipt', () => {
  it('is deterministic, omits operation bodies, and proves canonical state was unchanged', () => {
    const project = createProject('song', 'Replay fixture', HUMAN_ACTOR);
    project.revision = 7;
    const transaction: ProjectTransaction = {
      id: 'tx_replay_fixture',
      clientOperationId: 'trace-replay-fixture',
      projectId: project.id,
      actor: HUMAN_ACTOR,
      label: 'Replay two operations',
      createdAt: '2026-08-10T00:00:00.000Z',
      operations: [
        { kind: 'project.rename', name: 'operation-body-sentinel' },
        { kind: 'project.settings.update', changes: { sampleRate: 48_000 } },
      ],
      checkpointPolicy: 'none',
    };
    const entry: TransactionTraceEntry = {
      version: 1,
      projectId: project.id,
      revision: project.revision,
      recordedAt: '2026-08-10T00:00:01.000Z',
      outcome: 'committed',
      transaction,
      actor: HUMAN_ACTOR,
      label: transaction.label,
    };

    const first = buildTraceReplayAudit(entry as ReplayableTraceEntry, project, structuredClone(project));
    const second = buildTraceReplayAudit(entry as ReplayableTraceEntry, project, structuredClone(project));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      status: 'completed',
      projectId: project.id,
      transactionId: transaction.id,
      source: {
        resource: `aimuse://projects/${project.id}/trace`,
        revision: 7,
        outcome: 'committed',
        operationCount: 2,
        operationKinds: ['project.rename', 'project.settings.update'],
        entrySha256: sha256Json(entry),
        transactionSha256: sha256Json(transaction),
      },
      replay: {
        mode: 'non-mutating-visualization',
        appliedOperations: 0,
        progressEventCount: 3,
        steps: [
          { index: 0, kind: 'project.rename', progressStart: 0, progressEnd: 0.5 },
          { index: 1, kind: 'project.settings.update', progressStart: 0.5, progressEnd: 1 },
        ],
      },
      canonical: { beforeRevision: 7, afterRevision: 7, unchanged: true },
    });
    const { auditSha256, ...audit } = first;
    expect(auditSha256).toBe(sha256Json(audit));
    expect(first.canonical.beforeSha256).toBe(first.canonical.afterSha256);
    expect(JSON.stringify(first)).not.toContain('operation-body-sentinel');
  });

  it('reports a concurrent canonical change instead of claiming an unchanged replay', () => {
    const before = createProject('song', 'Before replay', HUMAN_ACTOR);
    const after = structuredClone(before);
    after.name = 'Changed by another actor';
    after.revision += 1;
    const transaction: ProjectTransaction = {
      id: 'tx_concurrent_fixture', clientOperationId: 'trace-replay-concurrent', projectId: before.id,
      actor: HUMAN_ACTOR, label: 'Replay fixture', createdAt: '2026-08-10T00:00:00.000Z',
      operations: [{ kind: 'project.rename', name: 'Historical name' }], checkpointPolicy: 'none',
    };
    const entry: ReplayableTraceEntry = {
      version: 1, projectId: before.id, revision: 1, recordedAt: '2026-08-10T00:00:01.000Z',
      outcome: 'committed', transaction, actor: HUMAN_ACTOR, label: transaction.label,
    };

    const audit = buildTraceReplayAudit(entry, before, after);
    expect(audit.status).toBe('concurrent-change-observed');
    expect(audit.replay.appliedOperations).toBe(0);
    expect(audit.canonical).toMatchObject({ beforeRevision: 0, afterRevision: 1, unchanged: false });
    expect(audit.canonical.beforeSha256).not.toBe(audit.canonical.afterSha256);
  });
});
