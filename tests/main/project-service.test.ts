import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_ACTOR, createId, nowIso, type Actor, type ProjectOperation, type ProjectTransaction } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { RecoveryJournal } from '../../src/main/journal';
import { readProjectFolder } from '../../src/main/persistence';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

const AGENT_A: Actor = { id: 'agent-a', kind: 'agent', name: 'Muse A', color: '#22c55e', client: { product: 'test' } };
const AGENT_B: Actor = { id: 'agent-b', kind: 'agent', name: 'Muse B', color: '#f97316', client: { product: 'test' } };

class FailingTransactionJournal extends RecoveryJournal {
  override async appendTransaction(): Promise<void> { throw new Error('simulated journal failure'); }
}

class FailingTraceStore extends TransactionTraceStore {
  override async append(): Promise<void> { throw new Error('simulated trace mirror failure'); }
}

class TrackingAudioEngine extends AudioEngineController {
  prepared = 0; committed = 0; aborted = 0;
  override async prepareProject(project: Parameters<AudioEngineController['prepareProject']>[0]): Promise<{ graphRevision: number }> { this.prepared += 1; return super.prepareProject(project); }
  override async commitPreparedProject(project?: Parameters<AudioEngineController['prepareProject']>[0]): Promise<{ graphRevision: number }> { this.committed += 1; return super.commitPreparedProject(project); }
  override async abortPreparedProject(project?: Parameters<AudioEngineController['prepareProject']>[0]): Promise<void> { this.aborted += 1; return super.abortPreparedProject(project); }
}

describe('ProjectService collaboration invariants', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-project-service-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    await audio.start();
    await projects.initialize();
  });

  afterEach(async () => {
    await audio.stop();
    await rm(root, { recursive: true, force: true });
  });

  function transaction(actor: Actor, operations: ProjectOperation[], label = 'Test edit', clientOperationId = createId('client-op')): ProjectTransaction {
    const project = projects.getActiveProject()!;
    return { id: createId('tx'), clientOperationId, projectId: project.id, actor, label, createdAt: nowIso(), operations, checkpointPolicy: 'none' };
  }

  it('authenticates attribution, deduplicates commits, and keeps undo isolated per actor', async () => {
    const initial = projects.getActiveProject()!;
    const track = initial.tracks[initial.trackOrder[0]];
    const operationId = createId('idempotency');
    const spoofed = transaction(AGENT_B, [{ kind: 'track.update', trackId: track.id, changes: { name: 'Alpha' }, expectedRevision: track.revision }], 'Agent A rename', operationId);

    expect(await projects.apply(spoofed, AGENT_A)).toMatchObject({ status: 'committed', revision: 1 });
    expect(await projects.apply(spoofed, AGENT_A)).toMatchObject({ status: 'duplicate', revision: 1 });
    let current = projects.getActiveProject()!;
    expect(current.tracks[track.id]).toMatchObject({ name: 'Alpha', revision: 1, updatedBy: AGENT_A.id });
    expect(current.activity.at(-1)?.actor.id).toBe(AGENT_A.id);

    expect(await projects.apply(transaction(AGENT_B, [{ kind: 'track.update', trackId: track.id, changes: { gainDb: -3 }, expectedRevision: 1 }], 'Agent B gain'), AGENT_B)).toMatchObject({ status: 'committed', revision: 2 });
    expect(await projects.undo(current.id, AGENT_A)).toMatchObject({ status: 'committed', revision: 3 });
    current = projects.getActiveProject()!;
    expect(current.tracks[track.id]).toMatchObject({ name: track.name, gainDb: -3, revision: 3, updatedBy: AGENT_A.id });

    expect(await projects.undo(current.id, AGENT_B)).toMatchObject({ status: 'committed', revision: 4 });
    current = projects.getActiveProject()!;
    expect(current.tracks[track.id]).toMatchObject({ name: track.name, gainDb: 0, revision: 4, updatedBy: AGENT_B.id });

    expect(await projects.redo(current.id, AGENT_A)).toMatchObject({ status: 'committed', revision: 5 });
    current = projects.getActiveProject()!;
    expect(current.tracks[track.id]).toMatchObject({ name: 'Alpha', gainDb: 0, revision: 5, updatedBy: AGENT_A.id });
  });

  it('gives human locks priority, reports revision conflicts, and checkpoints broad agent edits', async () => {
    const project = projects.getActiveProject()!;
    const track = project.tracks[project.trackOrder[0]];
    const lock = projects.acquireLock({ projectId: project.id, entityIds: [track.id] });
    expect(lock.acquired).toBe(true);

    const blocked = transaction(AGENT_A, [{ kind: 'track.update', trackId: track.id, changes: { pan: 0.25 }, expectedRevision: 0 }], 'Agent pan');
    expect(await projects.apply(blocked, AGENT_A)).toMatchObject({ status: 'locked', conflict: { entityId: track.id, retryable: true } });
    expect(await projects.apply(transaction(HUMAN_ACTOR, [{ kind: 'track.update', trackId: track.id, changes: { pan: -0.25 }, expectedRevision: 0 }], 'Human pan'), HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    projects.releaseLock(lock.lockId!);

    expect(await projects.apply(transaction(AGENT_A, [{ kind: 'track.update', trackId: track.id, changes: { gainDb: -2 }, expectedRevision: 0 }], 'Stale edit'), AGENT_A)).toMatchObject({ status: 'conflict', conflict: { expectedRevision: 0, actualRevision: 1 } });

    const broad = transaction(AGENT_A, Array.from({ length: 16 }, (_, index) => ({ kind: 'project.rename' as const, name: `Autonomous pass ${index + 1}` })), 'Broad autonomous pass');
    broad.checkpointPolicy = 'auto';
    const result = await projects.apply(broad, AGENT_A);
    expect(result).toMatchObject({ status: 'committed' });
    expect(result.checkpointId).toBeTruthy();
    const committed = projects.getActiveProject()!;
    expect(committed.checkpoints[result.checkpointId!]).toMatchObject({ automatic: true });
  });

  it('auditions branch edits independently and merges a conflict-free three-way change', async () => {
    const project = projects.getActiveProject()!;
    const track = project.tracks[project.trackOrder[0]];
    const { variantId } = await projects.createBranch(project.id, 'Brighter chorus', AGENT_A);
    const branchTransaction = transaction(AGENT_A, [{ kind: 'track.update', trackId: track.id, changes: { color: '#ec4899' }, expectedRevision: track.revision }], 'Color branch');

    expect(await projects.applyBranch(variantId, branchTransaction, AGENT_A)).toMatchObject({ status: 'committed' });
    expect(projects.getActiveProject()!.tracks[track.id].color).toBe(track.color);
    await expect(projects.compareBranch(variantId)).resolves.toMatchObject({ changes: { tracks: { changed: 1 } }, conflicts: [] });
    expect(await projects.mergeBranch(variantId, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    expect(projects.getActiveProject()!.tracks[track.id].color).toBe('#ec4899');
  });

  it('serializes simultaneous sessions without losing either committed revision', async () => {
    const project = projects.getActiveProject()!;
    const first = transaction(AGENT_A, [{ kind: 'project.rename', name: 'First concurrent edit' }], 'First concurrent edit');
    const second = transaction(AGENT_B, [{ kind: 'lyrics.set', lyrics: 'Second concurrent edit' }], 'Second concurrent edit');
    const [left, right] = await Promise.all([projects.apply(first, AGENT_A), projects.apply(second, AGENT_B)]);

    expect([left.revision, right.revision].sort()).toEqual([1, 2]);
    expect(projects.getActiveProject()).toMatchObject({ revision: 2, name: 'First concurrent edit', lyrics: 'Second concurrent edit' });
    expect(projects.getChanges(project.id, 0).map((change) => change.revision)).toEqual([1, 2]);
    expect(await projects.listTrace(project.id)).toHaveLength(2);
  });

  it('persists actor-attributed file.saved audit without changing revision or undoable content history', async () => {
    const initial = projects.getActiveProject()!;
    const activityLength = initial.activity.length;
    expect(await projects.apply(transaction(AGENT_A, [{ kind: 'project.rename', name: 'Audited save' }], 'Auditable content edit'), AGENT_A)).toMatchObject({ status: 'committed', revision: 1 });
    const beforeSave = projects.getActiveProject()!;
    expect(projects.snapshot(AGENT_A.id).canUndo).toBe(true);

    const requestedPath = join(root, 'actor-save');
    const saved = await projects.save(beforeSave.id, requestedPath, AGENT_A);
    expect(saved).toMatchObject({ projectPath: expect.stringMatching(/actor-save\.aimuse$/i), warnings: [], audit: { version: 1, type: 'file.saved', projectId: beforeSave.id, actor: AGENT_A, outcome: 'succeeded', recordedAt: expect.any(String) } });
    expect(projects.getActiveProject()).toMatchObject({ revision: 1, name: 'Audited save', dirty: false, activity: expect.arrayContaining([]) });
    expect(projects.getActiveProject()!.activity).toHaveLength(activityLength + 1);
    expect(projects.snapshot(AGENT_A.id).canUndo).toBe(true);
    expect(projects.listFileAudit(beforeSave.id)).toEqual([saved.audit]);

    const humanSaved = await projects.save(beforeSave.id, saved.projectPath, HUMAN_ACTOR);
    expect(humanSaved.audit).toMatchObject({ type: 'file.saved', projectId: beforeSave.id, actor: HUMAN_ACTOR, outcome: 'succeeded' });
    expect(projects.getActiveProject()).toMatchObject({ revision: 1, name: 'Audited save', dirty: false });
    expect(projects.getActiveProject()!.activity).toHaveLength(activityLength + 1);
    expect(projects.snapshot(AGENT_A.id).canUndo).toBe(true);
    expect(projects.listFileAudit(beforeSave.id)).toEqual([saved.audit, humanSaved.audit]);

    const auditText = await readFile(join(saved.projectPath, 'activity', 'file-audit.jsonl'), 'utf8');
    expect(auditText).not.toContain(saved.projectPath);
    expect(auditText).not.toContain(requestedPath);
    expect(auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line))).toEqual([saved.audit, humanSaved.audit]);
    await expect(readProjectFolder(saved.projectPath)).resolves.toMatchObject({ fileAudit: [saved.audit, humanSaved.audit] });

    expect(await projects.undo(beforeSave.id, AGENT_A)).toMatchObject({ status: 'committed', revision: 2 });
    expect(projects.getActiveProject()).toMatchObject({ name: initial.name, revision: 2 });
    expect(projects.listFileAudit(beforeSave.id)).toEqual([saved.audit, humanSaved.audit]);
  });

  it('keeps a dirty project open until the caller explicitly chooses the discard branch', async () => {
    const project = projects.getActiveProject()!;

    await expect(projects.close(project.id)).resolves.toEqual({ closed: false, reason: 'Project has unsaved changes.' });
    expect(projects.getProject(project.id)).toBeTruthy();

    await expect(projects.close(project.id, true)).resolves.toEqual({ closed: true });
    expect(projects.getProject(project.id)).toBeUndefined();
  });

  it('aborts a prepared native graph when the write-ahead recovery journal fails', async () => {
    const isolatedRoot = join(root, 'journal-failure'); const tracking = new TrackingAudioEngine();
    const isolated = new ProjectService({ appVersion: 'test', checkpointRoot: join(isolatedRoot, 'checkpoints'), journal: new FailingTransactionJournal(join(isolatedRoot, 'recovery')), trace: new TransactionTraceStore(join(isolatedRoot, 'traces')), audio: tracking });
    await tracking.start(); await isolated.initialize(); const project = isolated.getActiveProject()!;
    const result = await isolated.apply({ id: createId('tx'), clientOperationId: 'journal-failure', projectId: project.id, actor: AGENT_A, label: 'Must not commit', createdAt: nowIso(), operations: [{ kind: 'project.rename', name: 'Lost edit' }] }, AGENT_A);
    expect(result).toMatchObject({ status: 'engine-error', message: 'simulated journal failure' });
    expect(isolated.getActiveProject()).toMatchObject({ revision: 0, name: 'New Song' });
    expect(tracking.aborted).toBe(1);
    expect(tracking.committed).toBe(1);
    await tracking.stop();
  });

  it('commits from the durable journal even when the secondary trace mirror fails', async () => {
    const isolatedRoot = join(root, 'trace-failure'); const recoveryRoot = join(isolatedRoot, 'recovery'); const tracking = new TrackingAudioEngine();
    const isolated = new ProjectService({ appVersion: 'test', checkpointRoot: join(isolatedRoot, 'checkpoints'), journal: new RecoveryJournal(recoveryRoot), trace: new FailingTraceStore(join(isolatedRoot, 'traces')), audio: tracking });
    await tracking.start(); await isolated.initialize(); const project = isolated.getActiveProject()!;
    const result = await isolated.apply({ id: createId('tx'), clientOperationId: 'trace-failure', projectId: project.id, actor: AGENT_A, label: 'Journal is canonical', createdAt: nowIso(), operations: [{ kind: 'project.rename', name: 'Durably committed' }] }, AGENT_A);
    expect(result).toMatchObject({ status: 'committed', revision: 1 });
    expect(result.message).toContain('trace mirror could not be written');
    expect(isolated.getActiveProject()).toMatchObject({ revision: 1, name: 'Durably committed' });
    expect((await new RecoveryJournal(recoveryRoot).recover())[0]).toMatchObject({ revision: 1, name: 'Durably committed' });
    expect(tracking.committed).toBe(2);
    expect(tracking.aborted).toBe(0);
    await tracking.stop();
  });
});
