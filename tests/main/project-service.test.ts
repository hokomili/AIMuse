import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_ACTOR, createId, nowIso, type Actor, type AsyncJob, type ProjectOperation, type ProjectTransaction } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { RecoveryJournal } from '../../src/main/journal';
import { readProjectFolder } from '../../src/main/persistence';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';
import type { WorkspaceEvent } from '../../src/common/contracts';

const AGENT_A: Actor = { id: 'agent-a', kind: 'agent', name: 'Muse A', color: '#22c55e', client: { product: 'test' } };
const AGENT_B: Actor = { id: 'agent-b', kind: 'agent', name: 'Muse B', color: '#f97316', client: { product: 'test' } };

class FailingTransactionJournal extends RecoveryJournal {
  override async appendTransaction(): Promise<void> { throw new Error('simulated journal failure'); }
}

class FailingTraceStore extends TransactionTraceStore {
  override async append(): Promise<void> { throw new Error('simulated trace mirror failure'); }
}

class FailingRemovalJournal extends RecoveryJournal {
  override async remove(): Promise<void> { throw new Error('simulated recovery removal failure'); }
}

class PausingCompactJournal extends RecoveryJournal {
  private armed = false;
  private startedResolve?: () => void;
  private releaseResolve?: () => void;
  private started?: Promise<void>;
  private release?: Promise<void>;

  armNextCompact(): void {
    this.armed = true;
    this.started = new Promise((resolvePromise) => { this.startedResolve = resolvePromise; });
    this.release = new Promise((resolvePromise) => { this.releaseResolve = resolvePromise; });
  }

  async waitForCompact(): Promise<void> { await this.started; }
  resumeCompact(): void { this.releaseResolve?.(); }

  override async compact(project: Parameters<RecoveryJournal['compact']>[0]): Promise<void> {
    if (this.armed) {
      this.armed = false;
      this.startedResolve?.();
      await this.release;
    }
    await super.compact(project);
  }
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
    vi.restoreAllMocks();
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
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const project = projects.getActiveProject()!;
    const track = project.tracks[project.trackOrder[0]];
    const lock = projects.acquireLock({ projectId: project.id, entityIds: [track.id] });
    expect(lock).toMatchObject({ acquired: true, lockId: expect.any(String), lock: { phase: 'gesture', entityIds: [track.id] } });
    expect(projects.refreshLock(lock.lockId!)).toMatchObject({ refreshed: true, expiresAt: expect.any(String) });
    expect(projects.holdLock(lock.lockId!)).toMatchObject({ held: true, expiresAt: new Date(now + 15_000).toISOString() });
    expect(projects.refreshLock(lock.lockId!)).toEqual({ refreshed: false });
    expect(projects.snapshot().locks).toMatchObject([{ id: lock.lockId, phase: 'grace', entityIds: [track.id] }]);

    const blocked = transaction(AGENT_A, [{ kind: 'track.update', trackId: track.id, changes: { pan: 0.25 }, expectedRevision: 0 }], 'Agent pan');
    expect(await projects.apply(blocked, AGENT_A)).toMatchObject({ status: 'locked', conflict: { entityId: track.id, retryable: true } });
    expect(await projects.apply(transaction(HUMAN_ACTOR, [{ kind: 'track.update', trackId: track.id, changes: { pan: -0.25 }, expectedRevision: 0 }], 'Human pan'), HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    vi.mocked(Date.now).mockReturnValue(now + 15_001);
    expect(projects.snapshot().locks).toEqual([]);

    expect(await projects.apply(blocked, AGENT_A)).toMatchObject({ status: 'conflict', conflict: { expectedRevision: 0, actualRevision: 1 } });

    const broad = transaction(AGENT_A, Array.from({ length: 16 }, (_, index) => ({ kind: 'project.rename' as const, name: `Autonomous pass ${index + 1}` })), 'Broad autonomous pass');
    broad.checkpointPolicy = 'auto';
    const result = await projects.apply(broad, AGENT_A);
    expect(result).toMatchObject({ status: 'committed' });
    expect(result.checkpointId).toBeTruthy();
    const committed = projects.getActiveProject()!;
    expect(committed.checkpoints[result.checkpointId!]).toMatchObject({ automatic: true });
  });

  it('scopes identical timeline ranges per project and clears closed-project lock timers', async () => {
    const firstProject = projects.getActiveProject()!;
    const first = projects.acquireLock({ projectId: firstProject.id, range: { startTick: 0, endTick: 960 } });
    expect(first).toMatchObject({ acquired: true, lock: { phase: 'gesture' } });
    const secondWorkspace = await projects.create({ kind: 'song', name: 'Second lock domain' });
    const secondProject = secondWorkspace.activeProject!;
    const second = projects.acquireLock({ projectId: secondProject.id, range: { startTick: 0, endTick: 960 } });
    expect(second).toMatchObject({ acquired: true, lock: { phase: 'gesture' } });

    await expect(projects.close(firstProject.id, true)).resolves.toEqual({ closed: true });
    expect(projects.snapshot().locks).toMatchObject([{ id: second.lockId, projectId: secondProject.id }]);
    projects.releaseLock(second.lockId!);
    expect(projects.snapshot().locks).toEqual([]);
  });

  it('publishes bounded grace expiry without requiring a later snapshot or mutation', () => {
    vi.useFakeTimers();
    let latestLocks = projects.snapshot().locks;
    const listener = (event: WorkspaceEvent) => { if (event.type === 'workspace') latestLocks = event.snapshot.locks; };
    projects.on('event', listener);
    try {
      const project = projects.getActiveProject()!;
      const lock = projects.acquireLock({ projectId: project.id, range: { startTick: 0, endTick: 960 } });
      expect(projects.holdLock(lock.lockId!)).toMatchObject({ held: true });
      expect(latestLocks).toMatchObject([{ id: lock.lockId, phase: 'grace' }]);
      vi.advanceTimersByTime(15_001);
      expect(latestLocks).toEqual([]);
    } finally {
      projects.off('event', listener);
      vi.useRealTimers();
    }
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
    const journal = new RecoveryJournal(join(root, 'recovery'));

    await expect(projects.close(project.id)).resolves.toEqual({ closed: false, reason: 'Project has unsaved changes.' });
    expect(projects.getProject(project.id)).toBeTruthy();
    expect((await journal.recover()).map((entry) => entry.id)).toContain(project.id);

    await expect(projects.close(project.id, true)).resolves.toEqual({ closed: true });
    expect(projects.getProject(project.id)).toBeUndefined();
    expect((await journal.recover()).map((entry) => entry.id)).not.toContain(project.id);
  });

  it('does not resurrect a force-discarded dirty project after a same-profile graceful restart', async () => {
    const recoveryRoot = join(root, 'recovery');
    const crashRecoveryProject = projects.getActiveProject()!;
    expect(await projects.apply(transaction(HUMAN_ACTOR, [{ kind: 'project.rename', name: 'Legitimate crash recovery' }], 'Retained dirty work'), HUMAN_ACTOR)).toMatchObject({ status: 'committed' });

    const disposableWorkspace = await projects.create({ kind: 'song', name: 'Disposable dirty project' });
    const disposable = disposableWorkspace.activeProject!;
    expect(await projects.apply(transaction(HUMAN_ACTOR, [{ kind: 'lyrics.set', lyrics: 'Discard this work' }], 'Dirty disposable'), HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    await expect(projects.close(disposable.id, true)).resolves.toEqual({ closed: true });
    expect(projects.getProjects().map((project) => project.id)).toEqual([crashRecoveryProject.id]);

    await projects.compactRecovery();
    await audio.stop();
    audio = new AudioEngineController();
    await audio.start();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(recoveryRoot),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    await projects.initialize();

    expect(projects.getProjects()).toHaveLength(1);
    expect(projects.getProjects()[0]).toMatchObject({ id: crashRecoveryProject.id, name: 'Legitimate crash recovery', revision: 1, dirty: true });
    expect(projects.getProject(disposable.id)).toBeUndefined();
  });

  it('keeps periodic recovery compaction ordered before durable force-discard removal', async () => {
    const isolatedRoot = join(root, 'compaction-close-race');
    const journal = new PausingCompactJournal(join(isolatedRoot, 'recovery'));
    const isolatedAudio = new AudioEngineController();
    const isolated = new ProjectService({ appVersion: 'test', checkpointRoot: join(isolatedRoot, 'checkpoints'), journal, trace: new TransactionTraceStore(join(isolatedRoot, 'traces')), audio: isolatedAudio });
    await isolatedAudio.start();
    try {
      await isolated.initialize();
      const project = isolated.getActiveProject()!;
      journal.armNextCompact();
      const maintenance = isolated.compactRecovery();
      await journal.waitForCompact();
      const closing = isolated.close(project.id, true);

      journal.resumeCompact();
      await expect(maintenance).resolves.toBeUndefined();
      await expect(closing).resolves.toEqual({ closed: true });
      expect((await journal.recover()).map((entry) => entry.id)).not.toContain(project.id);
    } finally {
      journal.resumeCompact();
      await isolatedAudio.stop();
    }
  });

  it('removes cleanly saved projects from recovery on close', async () => {
    const project = projects.getActiveProject()!;
    await projects.save(project.id, join(root, 'clean-close'));
    expect(projects.getProject(project.id)).toMatchObject({ dirty: false });
    await expect(projects.close(project.id)).resolves.toEqual({ closed: true });
    expect((await new RecoveryJournal(join(root, 'recovery')).recover()).map((entry) => entry.id)).not.toContain(project.id);
  });

  it('keeps a project open when its recovery record cannot be durably removed', async () => {
    const isolatedRoot = join(root, 'removal-failure');
    const recoveryRoot = join(isolatedRoot, 'recovery');
    const isolatedAudio = new AudioEngineController();
    const isolated = new ProjectService({ appVersion: 'test', checkpointRoot: join(isolatedRoot, 'checkpoints'), journal: new FailingRemovalJournal(recoveryRoot), trace: new TransactionTraceStore(join(isolatedRoot, 'traces')), audio: isolatedAudio });
    await isolatedAudio.start();
    try {
      await isolated.initialize();
      const project = isolated.getActiveProject()!;
      await expect(isolated.close(project.id, true)).rejects.toThrow('simulated recovery removal failure');
      expect(isolated.getProject(project.id)).toMatchObject({ id: project.id, dirty: true });
      expect((await new RecoveryJournal(recoveryRoot).recover()).map((entry) => entry.id)).toContain(project.id);
    } finally {
      await isolatedAudio.stop();
    }
  });

  it('admits only one exact approval reservation and never publishes a second waiting request', () => {
    let maxWaiting = 0;
    projects.on('event', (event: WorkspaceEvent) => { if (event.type === 'job') maxWaiting = Math.max(maxWaiting, projects.listJobs().filter((job) => job.status === 'waiting-for-user').length); });
    const reservation = projects.reserveApproval(AGENT_A.id);
    expect(reservation).toEqual({ reservationId: expect.stringMatching(/^approval-reservation_/) });
    expect(projects.reserveApproval(AGENT_A.id)).toBeUndefined();
    expect(projects.reserveApproval(AGENT_B.id)).toBeUndefined();

    const timestamp = nowIso();
    const rogue: AsyncJob = { id: 'approval-same-owner-rogue', ownerActorId: AGENT_A.id, kind: 'render', status: 'waiting-for-user', progress: 0, message: 'Unbound approval.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, approval: { kind: 'file-write', summary: 'Unbound approval', request: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    projects.upsertJob(rogue);
    expect(projects.getJob(rogue.id)).toMatchObject({ status: 'failed', approval: undefined, error: { code: 'approval_pending' } });

    const first: AsyncJob = { id: 'approval-first', ownerActorId: AGENT_A.id, kind: 'render', status: 'waiting-for-user', progress: 0, message: 'First approval.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, approval: { kind: 'file-write', summary: 'First approval', request: { privatePath: '/owner-a/first' }, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    expect(projects.bindApprovalReservation(reservation!.reservationId, first.id, AGENT_B.id)).toBe(false);
    expect(projects.bindApprovalReservation(reservation!.reservationId, first.id, AGENT_A.id)).toBe(true);
    expect(projects.bindApprovalReservation(reservation!.reservationId, 'approval-rebind-attempt', AGENT_A.id)).toBe(false);
    projects.upsertJob(first);
    expect(projects.getJob(first.id)).toMatchObject({ status: 'waiting-for-user', approval: expect.any(Object) });
    expect(projects.reserveApproval(AGENT_B.id)).toBeUndefined();

    const second: AsyncJob = { ...first, id: 'approval-second', ownerActorId: AGENT_A.id, message: 'Second approval.', approval: { ...first.approval!, request: { privatePath: '/owner-a/second' } } };
    projects.upsertJob(second);
    expect(projects.getJob(second.id)).toMatchObject({ status: 'failed', approval: undefined, error: { code: 'approval_pending', retryable: true } });
    expect(maxWaiting).toBe(1);

    expect(projects.resolveJob(first.id, 'deny')).toMatchObject({ status: 'cancelled' });
    const released = projects.reserveApproval(AGENT_B.id);
    expect(released).toEqual({ reservationId: expect.stringMatching(/^approval-reservation_/) });
    expect(projects.bindApprovalReservation(released!.reservationId, second.id, AGENT_B.id)).toBe(true);
    projects.releaseApprovalReservation(released!.reservationId);
    const finalReservation = projects.reserveApproval(AGENT_A.id);
    expect(finalReservation).toEqual({ reservationId: expect.stringMatching(/^approval-reservation_/) });
    projects.releaseApprovalReservation(finalReservation!.reservationId);
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
