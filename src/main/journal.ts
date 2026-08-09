import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { applyProjectTransaction, migrateProject, validateTransaction, type AIMuseProject, type ProjectTransaction } from '@aimuse/core';
import { atomicWriteFile } from './persistence';

type JournalRecord =
  | { version: 1; type: 'snapshot'; recordedAt: string; project: AIMuseProject }
  | { version: 1; type: 'transaction'; recordedAt: string; transaction: ProjectTransaction };

export class RecoveryJournal {
  constructor(private readonly root: string) {}

  private path(projectId: string): string {
    return join(this.root, `${createHash('sha256').update(projectId).digest('hex')}.jsonl`);
  }

  async appendTransaction(projectId: string, transaction: ProjectTransaction): Promise<void> {
    await this.append(projectId, { version: 1, type: 'transaction', recordedAt: new Date().toISOString(), transaction });
  }

  async appendSnapshot(project: AIMuseProject): Promise<void> {
    await this.append(project.id, { version: 1, type: 'snapshot', recordedAt: new Date().toISOString(), project: structuredClone(project) });
  }

  private async append(projectId: string, record: JournalRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const handle = await import('node:fs/promises').then(({ open }) => open(this.path(projectId), 'a', 0o600));
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  }

  async compact(project: AIMuseProject): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const record: JournalRecord = { version: 1, type: 'snapshot', recordedAt: new Date().toISOString(), project: structuredClone(project) };
    await atomicWriteFile(this.path(project.id), `${JSON.stringify(record)}\n`);
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.path(projectId), { force: true });
  }

  async recover(): Promise<AIMuseProject[]> {
    await mkdir(this.root, { recursive: true });
    const files = (await readdir(this.root)).filter((name) => name.endsWith('.jsonl'));
    const recovered: AIMuseProject[] = [];
    for (const file of files) {
      let project: AIMuseProject | undefined;
      const lines = (await readFile(join(this.root, file), 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as JournalRecord;
          if (record.version !== 1) continue;
          if (record.type === 'snapshot') project = migrateProject(record.project);
          else if (project) project = applyProjectTransaction(project, validateTransaction(record.transaction), { authenticatedActor: record.transaction.actor }).project;
        } catch {
          break;
        }
      }
      if (project) recovered.push(project);
    }
    return recovered;
  }
}
