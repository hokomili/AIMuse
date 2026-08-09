import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransactionTraceEntry } from '../common/contracts';

export class TransactionTraceStore {
  constructor(private readonly root: string) {}

  private path(projectId: string): string { return join(this.root, `${createHash('sha256').update(projectId).digest('hex')}.jsonl`); }

  async append(entry: TransactionTraceEntry): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const handle = await import('node:fs/promises').then(({ open }) => open(this.path(entry.projectId), 'a', 0o600));
    try { await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  }

  async list(projectId: string, limit = Number.POSITIVE_INFINITY): Promise<TransactionTraceEntry[]> {
    let source = '';
    try { source = await readFile(this.path(projectId), 'utf8'); } catch { return []; }
    const result: TransactionTraceEntry[] = [];
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as TransactionTraceEntry;
        if (value.version === 1 && value.projectId === projectId && value.actor && value.label) result.push(value);
      } catch { /* A partial final write never hides preceding valid entries. */ }
    }
    return Number.isFinite(limit) ? result.slice(-limit) : result;
  }

  async find(projectId: string, transactionId: string): Promise<TransactionTraceEntry | undefined> {
    return (await this.list(projectId)).find((entry) => entry.transaction?.id === transactionId);
  }

  async ndjson(projectId: string): Promise<string> {
    const entries = await this.list(projectId);
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
  }
}
