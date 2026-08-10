import { createHash } from 'node:crypto';
import type { AIMuseProject, ProjectTransaction } from '@aimuse/core';
import type { TransactionTraceEntry } from '../common/contracts';

export type ReplayableTraceEntry = TransactionTraceEntry & { transaction: ProjectTransaction };

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Builds the stable, credential-free receipt returned after a trace visualization.
 * The receipt deliberately describes operation kinds rather than operation bodies;
 * clients can read the authenticated durable trace resource for full content.
 */
export function buildTraceReplayAudit(entry: ReplayableTraceEntry, before: AIMuseProject, after: AIMuseProject) {
  const beforeSha256 = sha256Json(before);
  const afterSha256 = sha256Json(after);
  const operationCount = entry.transaction.operations.length;
  const canonicalUnchanged = before.revision === after.revision && beforeSha256 === afterSha256;
  const audit = {
    version: 1 as const,
    status: canonicalUnchanged ? 'completed' as const : 'concurrent-change-observed' as const,
    projectId: entry.projectId,
    transactionId: entry.transaction.id,
    source: {
      resource: `aimuse://projects/${entry.projectId}/trace`,
      revision: entry.revision,
      recordedAt: entry.recordedAt,
      outcome: entry.outcome,
      label: entry.label,
      actor: { id: entry.actor.id, kind: entry.actor.kind, name: entry.actor.name },
      entrySha256: sha256Json(entry),
      transactionSha256: sha256Json(entry.transaction),
      operationCount,
      operationKinds: entry.transaction.operations.map((operation) => operation.kind),
    },
    replay: {
      mode: 'non-mutating-visualization' as const,
      appliedOperations: 0 as const,
      progressEventCount: operationCount + 1,
      steps: entry.transaction.operations.map((operation, index) => ({
        index,
        kind: operation.kind,
        progressStart: operationCount === 0 ? 1 : index / operationCount,
        progressEnd: operationCount === 0 ? 1 : (index + 1) / operationCount,
      })),
    },
    canonical: {
      beforeRevision: before.revision,
      afterRevision: after.revision,
      beforeSha256,
      afterSha256,
      unchanged: canonicalUnchanged,
    },
  };
  return { ...audit, auditSha256: sha256Json(audit) };
}
