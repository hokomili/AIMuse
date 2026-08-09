import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId, createProject, HUMAN_ACTOR, type ProjectTransaction } from '@aimuse/core';
import { RecoveryJournal } from '../../src/main/journal';

describe('RecoveryJournal', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-journal-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('replays committed transactions and ignores a torn final record', async () => {
    const journal = new RecoveryJournal(root);
    const project = createProject('song', 'Before');
    await journal.appendSnapshot(project);
    const edit: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'rename-once', projectId: project.id, actor: HUMAN_ACTOR, label: 'Rename', createdAt: new Date().toISOString(),
      operations: [{ kind: 'project.rename', name: 'After' }], checkpointPolicy: 'none',
    };
    await journal.appendTransaction(project.id, edit);
    const [file] = await readdir(root);
    await appendFile(join(root, file), '{"version":1,"type":"transaction"');
    const recovered = await journal.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].name).toBe('After');
    expect(recovered[0].revision).toBe(1);
  });

  it('compacts to one canonical snapshot', async () => {
    const journal = new RecoveryJournal(root);
    const project = createProject('sfx', 'Compact');
    await journal.appendSnapshot(project);
    await journal.compact(project);
    const recovered = await journal.recover();
    expect(recovered.map((entry) => entry.id)).toEqual([project.id]);
  });
});
