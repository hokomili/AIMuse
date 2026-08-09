import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Patch } from 'immer';
import {
  HUMAN_ACTOR,
  TransactionConflictError,
  applyHistoryPatches,
  applyProjectTransaction,
  createId,
  createProject,
  migrateProject,
  nowIso,
  validateTransaction,
  validateProjectIntegrity,
  type AIMuseProject,
  type Actor,
  type AsyncJob,
  type Checkpoint,
  type Id,
  type MediaAsset,
  type PluginDescriptor,
  type ProjectOperation,
  type ProjectTransaction,
  type Variant,
} from '@aimuse/core';
import type {
  AgentPresence,
  ApplyTransactionResponse,
  HumanLock,
  HumanLockRequest,
  FileSavedAuditEvent,
  McpConnectionInfo,
  NewProjectOptions,
  TimelineSelection,
  TransactionTraceEntry,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from '../common/contracts';
import { AudioEngineController } from './audio-engine';
import { RecoveryJournal } from './journal';
import { atomicWriteFile, readProjectFileAudit, readProjectFolder, saveProjectFolder } from './persistence';
import { TransactionTraceStore } from './trace-store';

interface PatchHistoryEntry {
  kind: 'patches';
  label: string;
  undo: Patch[];
  redo: Patch[];
}

interface SnapshotHistoryEntry {
  kind: 'snapshot';
  label: string;
  before: AIMuseProject;
  after: AIMuseProject;
}

type HistoryEntry = PatchHistoryEntry | SnapshotHistoryEntry;
interface HistoryState { undo: HistoryEntry[]; redo: HistoryEntry[] }

interface ChangeEntry { revision: number; transaction: ProjectTransaction }
interface BranchState { base: AIMuseProject; current: AIMuseProject; operationIds: Map<string, number> }

const ENTITY_MAPS = ['tempoEvents', 'timeSignatureEvents', 'markers', 'sections', 'tracks', 'clips', 'takeLanes', 'compSegments', 'devices', 'sends', 'sidechains', 'automationLanes', 'sfxDeliverables'] as const;
const ORDER_FIELDS = ['tempoOrder', 'timeSignatureOrder', 'markerOrder', 'sectionOrder', 'trackOrder'] as const;
function comparable(value: unknown): string { return JSON.stringify(value, (key, item) => ['revision', 'updatedAt', 'updatedBy'].includes(key) ? undefined : item); }
function sameContent(left: unknown, right: unknown): boolean { return comparable(left) === comparable(right); }

export interface ProjectServiceOptions {
  appVersion: string;
  checkpointRoot: string;
  journal: RecoveryJournal;
  trace: TransactionTraceStore;
  audio: AudioEngineController;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class ProjectService extends EventEmitter {
  private readonly projects = new Map<Id, AIMuseProject>();
  private readonly histories = new Map<Id, Map<Id, HistoryState>>();
  private readonly operationIds = new Map<Id, Map<string, number>>();
  private readonly changes = new Map<Id, ChangeEntry[]>();
  private readonly jobs = new Map<Id, AsyncJob>();
  private readonly locks = new Map<Id, HumanLock>();
  private readonly presence = new Map<Id, AgentPresence>();
  private readonly plugins = new Map<string, PluginDescriptor>();
  private readonly assetSources = new Map<Id, string>();
  private readonly branches = new Map<Id, BranchState>();
  private readonly fileAudit = new Map<Id, FileSavedAuditEvent[]>();
  private readonly mutationTails = new Map<Id, Promise<void>>();
  private activeProjectId?: Id;
  private selection?: TimelineSelection;
  private mcpInfo: Omit<McpConnectionInfo, 'sessions'> = { running: false };

  constructor(private readonly options: ProjectServiceOptions) {
    super();
    options.audio.on('transport', (state) => { this.emitEvent({ type: 'transport', state }); this.publish(); });
    options.audio.on('meter', (event) => this.emitEvent({ type: 'meter', ...event }));
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.checkpointRoot, { recursive: true });
    const recovered = await this.options.journal.recover();
    for (const project of recovered) this.addProject(project, false, project.projectPath ? await readProjectFileAudit(project.projectPath, project.id) : []);
    if (!this.projects.size) { await this.create({ kind: 'song', name: 'New Song' }); return; }
    const active = this.getActiveProject(); if (active) await this.options.audio.synchronizeProject(active);
  }

  getProject(projectId: Id): AIMuseProject | undefined { const value = this.projects.get(projectId); return value ? clone(value) : undefined; }
  getActiveProjectId(): Id | undefined { return this.activeProjectId; }
  getActiveProject(): AIMuseProject | undefined { return this.activeProjectId ? this.getProject(this.activeProjectId) : undefined; }
  getProjects(): AIMuseProject[] { return [...this.projects.values()].map(clone); }
  listPlugins(): PluginDescriptor[] { return [...this.plugins.values()].map(clone); }
  setPlugins(values: PluginDescriptor[]): void { this.plugins.clear(); for (const value of values) this.plugins.set(value.id, clone(value)); this.publish(); }
  setMcpInfo(info: Omit<McpConnectionInfo, 'sessions'>): void { this.mcpInfo = clone(info); this.publish(); }
  getMcpInfo(): McpConnectionInfo { this.expireLocks(); return { ...clone(this.mcpInfo), sessions: [...this.presence.values()].map(clone) }; }

  snapshot(actorId = HUMAN_ACTOR.id): WorkspaceSnapshot {
    this.expireLocks();
    const active = this.activeProjectId ? this.projects.get(this.activeProjectId) : undefined;
    const history = active ? this.getHistory(active.id, actorId) : undefined;
    return {
      projects: [...this.projects.values()].map((project) => ({ id: project.id, name: project.name, kind: project.kind, dirty: project.dirty, revision: project.revision, projectPath: project.projectPath, activityState: Object.values(project.devices).some((device) => device.degraded) ? 'degraded' : undefined, activityActor: project.activity.at(-1)?.actor })),
      activeProjectId: this.activeProjectId, activeProject: active ? clone(active) : undefined,
      jobs: [...this.jobs.values()].filter((job) => actorId === HUMAN_ACTOR.id || job.ownerActorId === actorId).map(clone), plugins: this.listPlugins(), locks: [...this.locks.values()].map(clone), mcp: this.getMcpInfo(),
      transport: this.options.audio.snapshot(), selection: this.selection ? clone(this.selection) : undefined,
      canUndo: Boolean(history?.undo.length), canRedo: Boolean(history?.redo.length),
    };
  }

  async create(options: NewProjectOptions, actor: Actor = HUMAN_ACTOR): Promise<WorkspaceSnapshot> {
    const project = createProject(options.kind, options.name, actor);
    if (options.sampleRate) project.settings.sampleRate = options.sampleRate;
    if (options.bpm) project.tempoEvents[project.tempoOrder[0]].bpm = Math.max(20, Math.min(400, options.bpm));
    if (options.timeSignature) { const meter = project.timeSignatureEvents[project.timeSignatureOrder[0]]; meter.numerator = options.timeSignature.numerator; meter.denominator = options.timeSignature.denominator; }
    await this.options.audio.prepareProject(project);
    try { await this.options.journal.compact(project); }
    catch (error) { await this.options.audio.abortPreparedProject(project); throw error; }
    await this.options.audio.commitPreparedProject(project);
    this.addProject(project, true);
    return this.snapshot(actor.id);
  }

  private addProject(project: AIMuseProject, publish: boolean, fileAudit: FileSavedAuditEvent[] = []): void {
    const value = migrateProject(project);
    this.projects.set(value.id, value); this.activeProjectId = value.id;
    if (!this.histories.has(value.id)) this.histories.set(value.id, new Map());
    if (!this.operationIds.has(value.id)) this.operationIds.set(value.id, new Map());
    if (!this.changes.has(value.id)) this.changes.set(value.id, []);
    this.fileAudit.set(value.id, fileAudit.map(clone));
    if (publish) this.publish();
  }

  async activate(projectId: Id, actorId = HUMAN_ACTOR.id): Promise<WorkspaceSnapshot> {
    const project = this.projects.get(projectId); if (!project) throw new Error('Project is not open.');
    await this.options.audio.synchronizeProject(project); this.activeProjectId = projectId; this.publish(); return this.snapshot(actorId);
  }

  async apply(rawTransaction: ProjectTransaction, authenticatedActor?: Actor, skipCheckpoint = false): Promise<ApplyTransactionResponse> {
    return this.mutateProject(rawTransaction.projectId, () => this.applyUnlocked(rawTransaction, authenticatedActor, skipCheckpoint));
  }

  private async applyUnlocked(rawTransaction: ProjectTransaction, authenticatedActor?: Actor, skipCheckpoint = false): Promise<ApplyTransactionResponse> {
    let transaction: ProjectTransaction;
    try { transaction = validateTransaction(rawTransaction); } catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : String(error), conflict: { retryable: false } }; }
    const project = this.projects.get(transaction.projectId); if (!project) return { status: 'conflict', message: 'Project is not open.', conflict: { retryable: false } };
    const actor = authenticatedActor ? clone(authenticatedActor) : clone(transaction.actor);
    const known = this.operationIds.get(project.id)!;
    if (known.has(transaction.clientOperationId)) return { status: 'duplicate', revision: known.get(transaction.clientOperationId), message: 'This client operation was already committed.' };
    const lock = actor.kind === 'agent' ? this.findLockCollision(project, transaction.operations) : undefined;
    if (lock) return { status: 'locked', message: 'A human is actively editing this entity or timeline range.', conflict: { entityId: lock.entityIds[0], retryable: true } };
    let checkpointId: Id | undefined;
    if (!skipCheckpoint && !transaction.operations.some((operation) => operation.kind.startsWith('checkpoint.')) && this.needsCheckpoint(transaction)) {
      checkpointId = (await this.createCheckpointUnlocked(project.id, `Before ${transaction.label}`, actor, true)).checkpointId;
    }
    const current = this.projects.get(project.id)!;
    try {
      const result = applyProjectTransaction(current, transaction, { authenticatedActor: actor, maxOperations: 512 });
      await this.options.audio.prepareProject(result.project);
      try { await this.options.journal.appendTransaction(project.id, result.transaction); }
      catch (error) { await this.options.audio.abortPreparedProject(result.project); throw error; }
      let traceWarning: string | undefined;
      try { await this.options.trace.append({ version: 1, projectId: project.id, revision: result.project.revision, recordedAt: nowIso(), outcome: 'committed', transaction: result.transaction, actor, label: result.transaction.label }); }
      catch (error) { traceWarning = `The recovery journal committed the edit, but the trace mirror could not be written: ${error instanceof Error ? error.message : String(error)}`; }
      await this.options.audio.commitPreparedProject(result.project);
      this.projects.set(project.id, result.project); known.set(transaction.clientOperationId, result.project.revision);
      if (known.size > 20_000) known.delete(known.keys().next().value!);
      const history = this.getHistory(project.id, actor.id); history.undo.push({ kind: 'patches', label: result.transaction.label, undo: result.inversePatches, redo: result.patches }); history.redo.length = 0;
      if (history.undo.length > 1_000) history.undo.shift();
      const list = this.changes.get(project.id)!; list.push({ revision: result.project.revision, transaction: result.transaction }); if (list.length > 2_000) list.shift();
      this.publish();
      return { status: 'committed', revision: result.project.revision, transactionId: result.transaction.id, checkpointId, message: traceWarning };
    } catch (error) {
      if (error instanceof TransactionConflictError) return { status: 'conflict', message: error.message, conflict: { operationIndex: error.conflict.operationIndex, entityId: error.conflict.entityId, expectedRevision: error.conflict.expectedRevision, actualRevision: error.conflict.actualRevision, retryable: error.conflict.retryable } };
      return { status: 'engine-error', message: error instanceof Error ? error.message : String(error), conflict: { retryable: true } };
    }
  }

  private needsCheckpoint(transaction: ProjectTransaction): boolean {
    if (transaction.checkpointPolicy === 'required') return true;
    if (transaction.checkpointPolicy === 'none') return false;
    const tracks = new Set<Id>();
    for (const operation of transaction.operations) {
      const record = operation as unknown as Record<string, unknown>;
      for (const key of ['trackId', 'sourceTrackId', 'destinationTrackId']) if (typeof record[key] === 'string') tracks.add(String(record[key]));
      if (operation.kind === 'track.delete' || operation.kind === 'asset.delete') return true;
    }
    return transaction.operations.length >= 16 || tracks.size >= 4;
  }

  async undo(projectId = this.activeProjectId, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> { return projectId ? this.mutateProject(projectId, () => this.historyAction('undo', projectId, actor)) : this.historyAction('undo', projectId, actor); }
  async redo(projectId = this.activeProjectId, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> { return projectId ? this.mutateProject(projectId, () => this.historyAction('redo', projectId, actor)) : this.historyAction('redo', projectId, actor); }

  private async historyAction(action: 'undo' | 'redo', projectId: Id | undefined, actor: Actor): Promise<ApplyTransactionResponse> {
    if (!projectId) return { status: 'conflict', message: 'No active project.', conflict: { retryable: false } };
    const current = this.projects.get(projectId); if (!current) return { status: 'conflict', message: 'Project is not open.', conflict: { retryable: false } };
    const history = this.getHistory(projectId, actor.id); const source = action === 'undo' ? history.undo : history.redo; const target = action === 'undo' ? history.redo : history.undo; const entry = source.pop();
    if (!entry) return { status: 'conflict', message: `Nothing to ${action}.`, conflict: { retryable: false } };
    try {
      let next: AIMuseProject;
      if (entry.kind === 'patches') next = applyHistoryPatches(
        current,
        action === 'undo' ? entry.undo : entry.redo,
        actor,
        `${action === 'undo' ? 'Undo' : 'Redo'} ${entry.label}`,
        action,
        action === 'undo' ? entry.redo : entry.undo,
      );
      else { next = clone(action === 'undo' ? entry.before : entry.after); next.revision = current.revision + 1; next.updatedAt = nowIso(); next.dirty = true; next.activity.push({ id: createId('activity'), actor: clone(actor), label: `${action === 'undo' ? 'Undo' : 'Redo'} ${entry.label}`, status: action, createdAt: nowIso(), revision: next.revision }); }
      await this.options.audio.prepareProject(next); try { await this.options.journal.appendSnapshot(next); } catch (error) { await this.options.audio.abortPreparedProject(next); throw error; } await this.options.audio.commitPreparedProject(next); this.projects.set(projectId, next); target.push(entry);
      await this.options.trace.append({ version: 1, projectId, revision: next.revision, recordedAt: nowIso(), outcome: action, actor: clone(actor), label: `${action === 'undo' ? 'Undo' : 'Redo'} ${entry.label}` }).catch(() => undefined);
      this.publish(); return { status: 'committed', revision: next.revision };
    } catch (error) { source.push(entry); return { status: 'conflict', message: error instanceof Error ? error.message : String(error), conflict: { retryable: true } }; }
  }

  async createCheckpoint(projectId: Id, name: string, actor: Actor = HUMAN_ACTOR, automatic = false): Promise<{ checkpointId: Id }> {
    return this.mutateProject(projectId, () => this.createCheckpointUnlocked(projectId, name, actor, automatic));
  }

  private async createCheckpointUnlocked(projectId: Id, name: string, actor: Actor = HUMAN_ACTOR, automatic = false): Promise<{ checkpointId: Id }> {
    const project = this.projects.get(projectId); if (!project) throw new Error('Project is not open.');
    const snapshot = clone(project); snapshot.projectPath = undefined; snapshot.dirty = false;
    const data = Buffer.from(`${JSON.stringify(snapshot)}\n`); const sha256 = createHash('sha256').update(data).digest('hex'); const path = join(this.options.checkpointRoot, `${sha256}.json`);
    await atomicWriteFile(path, data, (bytes) => { migrateProject(JSON.parse(bytes.toString('utf8'))); });
    const base = { revision: 0, createdAt: nowIso(), updatedAt: nowIso(), createdBy: actor.id, updatedBy: actor.id };
    const asset: MediaAsset = { ...base, id: createId('asset'), kind: 'checkpoint', name: `${name}.json`, mimeType: 'application/vnd.aimuse.checkpoint+json', sha256, byteLength: data.byteLength, storage: 'managed-cache', externalPath: path, source: 'system' };
    const checkpoint: Checkpoint = { ...base, id: createId('checkpoint'), name, projectRevision: project.revision, snapshotAssetId: asset.id, automatic, reason: automatic ? 'Automatic safety checkpoint before broad agent changes.' : undefined };
    this.assetSources.set(asset.id, path);
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('checkpoint-op'), projectId, actor, label: `Checkpoint: ${name}`, createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }, { kind: 'checkpoint.register', checkpoint }], checkpointPolicy: 'none' };
    const result = await this.applyUnlocked(tx, actor, true); if (result.status !== 'committed') throw new Error(result.message ?? 'Checkpoint could not be committed.');
    await this.options.trace.append({ version: 1, projectId, revision: result.revision!, recordedAt: nowIso(), outcome: 'checkpoint', transaction: tx, actor, label: tx.label, details: { checkpointId: checkpoint.id, automatic } }).catch(() => undefined);
    return { checkpointId: checkpoint.id };
  }

  async restoreCheckpoint(projectId: Id, checkpointId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    return this.mutateProject(projectId, () => this.restoreCheckpointUnlocked(projectId, checkpointId, actor));
  }

  private async restoreCheckpointUnlocked(projectId: Id, checkpointId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    const current = this.projects.get(projectId); if (!current) return { status: 'conflict', message: 'Project is not open.', conflict: { retryable: false } };
    const checkpoint = current.checkpoints[checkpointId]; if (!checkpoint) return { status: 'conflict', message: 'Checkpoint does not exist.', conflict: { retryable: false } };
    const asset = current.assets[checkpoint.snapshotAssetId]; const path = asset ? this.resolveAssetSource(current, asset) : undefined; if (!path) return { status: 'conflict', message: 'Checkpoint snapshot is unavailable.', conflict: { retryable: false } };
    try {
      const before = clone(current); const restored = migrateProject(JSON.parse(await readFile(path, 'utf8'))); restored.projectPath = current.projectPath; restored.revision = current.revision + 1; restored.updatedAt = nowIso(); restored.dirty = true;
      restored.checkpoints = clone(current.checkpoints); restored.assets = { ...restored.assets, ...clone(current.assets) };
      restored.activity.push({ id: createId('activity'), actor: clone(actor), label: `Restore ${checkpoint.name}`, status: 'checkpoint', createdAt: nowIso(), revision: restored.revision });
      await this.options.audio.prepareProject(restored); try { await this.options.journal.appendSnapshot(restored); } catch (error) { await this.options.audio.abortPreparedProject(restored); throw error; } await this.options.audio.commitPreparedProject(restored); this.projects.set(projectId, restored); const history = this.getHistory(projectId, actor.id); history.undo.push({ kind: 'snapshot', label: `Restore ${checkpoint.name}`, before, after: clone(restored) }); history.redo.length = 0;
      await this.options.trace.append({ version: 1, projectId, revision: restored.revision, recordedAt: nowIso(), outcome: 'checkpoint', actor, label: `Restore ${checkpoint.name}`, details: { checkpointId } }).catch(() => undefined); this.publish();
      return { status: 'committed', revision: restored.revision, checkpointId };
    } catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : String(error), conflict: { retryable: false } }; }
  }

  async createBranch(projectId: Id, name: string, actor: Actor = HUMAN_ACTOR): Promise<{ variantId: Id; checkpointId: Id }> {
    if (!name.trim() || name.length > 200) throw new Error('Branch name must contain 1–200 characters.');
    const { checkpointId } = await this.createCheckpoint(projectId, `Branch base: ${name.trim()}`, actor, false); const main = this.projects.get(projectId)!; const checkpoint = main.checkpoints[checkpointId]; const snapshotPath = this.getAssetSource(projectId, checkpoint.snapshotAssetId); if (!snapshotPath) throw new Error('Branch checkpoint snapshot is unavailable.'); const base = migrateProject(JSON.parse(await readFile(snapshotPath, 'utf8')));
    const variant: Variant = { ...({ revision: 0, createdAt: nowIso(), updatedAt: nowIso(), createdBy: actor.id, updatedBy: actor.id }), id: createId('variant'), name: name.trim(), baseCheckpointId: checkpointId, snapshotAssetId: checkpoint.snapshotAssetId, status: 'active', projectRevision: base.revision };
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('branch-create'), projectId, actor, label: `Create branch: ${variant.name}`, createdAt: nowIso(), operations: [{ kind: 'variant.register', variant }], checkpointPolicy: 'none' }; const result = await this.apply(tx, actor, true); if (result.status !== 'committed') throw new Error(result.message ?? 'Branch could not be registered.'); this.branches.set(variant.id, { base: clone(base), current: clone(base), operationIds: new Map() }); return { variantId: variant.id, checkpointId };
  }

  async getBranch(variantId: Id): Promise<AIMuseProject | undefined> { const value = await this.loadBranch(variantId); return value ? clone(value.current) : undefined; }

  async applyBranch(variantId: Id, rawTransaction: ProjectTransaction, actor: Actor): Promise<ApplyTransactionResponse> {
    return this.mutateProject(`branch:${variantId}`, () => this.applyBranchUnlocked(variantId, rawTransaction, actor));
  }

  private async applyBranchUnlocked(variantId: Id, rawTransaction: ProjectTransaction, actor: Actor): Promise<ApplyTransactionResponse> {
    const branch = await this.loadBranch(variantId); if (!branch) return { status: 'conflict', message: 'Branch is unavailable.', conflict: { retryable: false } }; const main = this.projects.get(rawTransaction.projectId); const variant = main?.variants[variantId]; if (!main || !variant || variant.status !== 'active') return { status: 'conflict', message: 'Branch is not active.', conflict: { retryable: false } };
    let transaction: ProjectTransaction; try { transaction = validateTransaction(rawTransaction); } catch (error) { return { status: 'conflict', message: error instanceof Error ? error.message : String(error), conflict: { retryable: false } }; }
    if (branch.operationIds.has(transaction.clientOperationId)) return { status: 'duplicate', revision: branch.operationIds.get(transaction.clientOperationId), message: 'This branch operation was already committed.' };
    try {
      const reduced = applyProjectTransaction(branch.current, transaction, { authenticatedActor: actor, maxOperations: 512 }); const data = Buffer.from(`${JSON.stringify(reduced.project)}\n`); const sha256 = createHash('sha256').update(data).digest('hex'); const path = join(this.options.checkpointRoot, `${sha256}.json`); await atomicWriteFile(path, data, (bytes) => { migrateProject(JSON.parse(bytes.toString('utf8'))); }); const asset: MediaAsset = { revision: 0, createdAt: nowIso(), updatedAt: nowIso(), createdBy: actor.id, updatedBy: actor.id, id: createId('asset'), kind: 'checkpoint', name: `${variant.name} r${reduced.project.revision}.json`, mimeType: 'application/vnd.aimuse.branch+json', sha256, byteLength: data.byteLength, storage: 'managed-cache', externalPath: path, source: 'system' };
      const metadataTx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('branch-snapshot'), projectId: main.id, actor, label: `Update branch: ${variant.name}`, createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }, { kind: 'variant.update', variantId, changes: { snapshotAssetId: asset.id, projectRevision: reduced.project.revision }, expectedRevision: variant.revision }], checkpointPolicy: 'none' }; const committed = await this.apply(metadataTx, actor, true); if (committed.status !== 'committed') return committed;
      this.assetSources.set(asset.id, path); branch.current = reduced.project; branch.operationIds.set(transaction.clientOperationId, reduced.project.revision); if (branch.operationIds.size > 20_000) branch.operationIds.delete(branch.operationIds.keys().next().value!); return { status: 'committed', revision: reduced.project.revision, transactionId: reduced.transaction.id };
    } catch (error) { if (error instanceof TransactionConflictError) return { status: 'conflict', message: error.message, conflict: { operationIndex: error.conflict.operationIndex, entityId: error.conflict.entityId, expectedRevision: error.conflict.expectedRevision, actualRevision: error.conflict.actualRevision, retryable: error.conflict.retryable } }; return { status: 'engine-error', message: error instanceof Error ? error.message : String(error), conflict: { retryable: true } }; }
  }

  async compareBranch(variantId: Id): Promise<{ variantId: Id; changes: Record<string, { added: number; removed: number; changed: number }>; conflicts: string[] }> {
    const branch = await this.loadBranch(variantId); if (!branch) throw new Error('Branch is unavailable.'); const main = this.projects.get(branch.current.id); if (!main) throw new Error('Project is not open.'); const changes: Record<string, { added: number; removed: number; changed: number }> = {}; const conflicts: string[] = [];
    for (const field of ENTITY_MAPS) { const base = branch.base[field] as Record<string, unknown>; const current = main[field] as Record<string, unknown>; const proposed = branch.current[field] as Record<string, unknown>; let added = 0; let removed = 0; let changed = 0; for (const id of new Set([...Object.keys(base), ...Object.keys(proposed)])) { if (!(id in base)) added += 1; else if (!(id in proposed)) removed += 1; else if (!sameContent(base[id], proposed[id])) changed += 1; if (!sameContent(current[id], base[id]) && !sameContent(proposed[id], base[id]) && !sameContent(current[id], proposed[id])) conflicts.push(`${field}.${id}`); } changes[field] = { added, removed, changed }; }
    return { variantId, changes, conflicts };
  }

  async mergeBranch(variantId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse & { conflicts?: string[] }> {
    const main = [...this.projects.values()].find((project) => project.variants[variantId]);
    if (!main) return { status: 'conflict', message: 'Branch is unavailable.', conflict: { retryable: false } };
    return this.mutateProject(main.id, () => this.mergeBranchUnlocked(variantId, actor));
  }

  private async mergeBranchUnlocked(variantId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse & { conflicts?: string[] }> {
    const branch = await this.loadBranch(variantId); if (!branch) return { status: 'conflict', message: 'Branch is unavailable.', conflict: { retryable: false } }; const current = this.projects.get(branch.current.id); const variant = current?.variants[variantId]; if (!current || !variant || variant.status !== 'active') return { status: 'conflict', message: 'Branch is not active.', conflict: { retryable: false } }; const next = clone(current); const conflicts: string[] = [];
    const mergeRoot = (field: string, base: unknown, human: unknown, proposed: unknown): unknown => { if (sameContent(human, base)) return clone(proposed); if (sameContent(proposed, base) || sameContent(human, proposed)) return clone(human); conflicts.push(field); return clone(human); };
    next.name = mergeRoot('name', branch.base.name, current.name, branch.current.name) as string; next.settings = mergeRoot('settings', branch.base.settings, current.settings, branch.current.settings) as AIMuseProject['settings']; next.lyrics = mergeRoot('lyrics', branch.base.lyrics, current.lyrics, branch.current.lyrics) as string;
    for (const field of ORDER_FIELDS) (next as unknown as Record<string, unknown>)[field] = mergeRoot(field, branch.base[field], current[field], branch.current[field]);
    for (const field of ENTITY_MAPS) { const destination = (next as unknown as Record<string, Record<string, unknown>>)[field]; const base = branch.base[field] as Record<string, unknown>; const human = current[field] as Record<string, unknown>; const proposed = branch.current[field] as Record<string, unknown>; for (const id of new Set([...Object.keys(base), ...Object.keys(human), ...Object.keys(proposed)])) { if (sameContent(human[id], base[id])) { if (proposed[id] === undefined) delete destination[id]; else { const value = clone(proposed[id]) as Record<string, unknown>; if (base[id] !== undefined) { value.revision = Number((human[id] as { revision?: number } | undefined)?.revision ?? (base[id] as { revision?: number }).revision ?? 0) + 1; value.updatedAt = nowIso(); value.updatedBy = actor.id; } destination[id] = value; } } else if (!sameContent(proposed[id], base[id]) && !sameContent(human[id], proposed[id])) conflicts.push(`${field}.${id}`); } }
    if (conflicts.length) return { status: 'conflict', message: 'Branch and main both changed the same project fields.', conflict: { retryable: false }, conflicts: [...new Set(conflicts)] };
    const before = clone(current); next.revision = current.revision + 1; next.updatedAt = nowIso(); next.dirty = true; next.projectPath = current.projectPath; next.variants[variantId] = { ...next.variants[variantId], status: 'merged', revision: next.variants[variantId].revision + 1, updatedAt: nowIso(), updatedBy: actor.id }; next.activity.push({ id: createId('activity'), actor: clone(actor), label: `Merge branch: ${variant.name}`, status: 'committed', createdAt: nowIso(), revision: next.revision });
    try { validateProjectIntegrity(next); await this.options.audio.prepareProject(next); try { await this.options.journal.appendSnapshot(next); } catch (error) { await this.options.audio.abortPreparedProject(next); throw error; } await this.options.audio.commitPreparedProject(next); this.projects.set(next.id, next); const history = this.getHistory(next.id, actor.id); history.undo.push({ kind: 'snapshot', label: `Merge branch: ${variant.name}`, before, after: clone(next) }); history.redo.length = 0; await this.options.trace.append({ version: 1, projectId: next.id, revision: next.revision, recordedAt: nowIso(), outcome: 'merge', actor, label: `Merge branch: ${variant.name}`, details: { variantId } }).catch(() => undefined); this.branches.delete(variantId); this.publish(); return { status: 'committed', revision: next.revision }; } catch (error) { return { status: 'engine-error', message: error instanceof Error ? error.message : String(error), conflict: { retryable: true } }; }
  }

  async discardBranch(variantId: Id, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> { const main = [...this.projects.values()].find((project) => project.variants[variantId]); const variant = main?.variants[variantId]; if (!main || !variant) return { status: 'conflict', message: 'Branch does not exist.', conflict: { retryable: false } }; const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('branch-discard'), projectId: main.id, actor, label: `Discard branch: ${variant.name}`, createdAt: nowIso(), operations: [{ kind: 'variant.update', variantId, changes: { status: 'discarded' }, expectedRevision: variant.revision }], checkpointPolicy: 'none' }; const result = await this.apply(tx, actor, true); if (result.status === 'committed') this.branches.delete(variantId); return result; }

  private async loadBranch(variantId: Id): Promise<BranchState | undefined> {
    const cached = this.branches.get(variantId); if (cached) return cached; const main = [...this.projects.values()].find((project) => project.variants[variantId]); const variant = main?.variants[variantId]; const checkpoint = variant && main?.checkpoints[variant.baseCheckpointId]; if (!main || !variant || !checkpoint || variant.status !== 'active') return undefined; const basePath = this.getAssetSource(main.id, checkpoint.snapshotAssetId); const currentPath = this.getAssetSource(main.id, variant.snapshotAssetId ?? checkpoint.snapshotAssetId); if (!basePath || !currentPath) return undefined; const value = { base: migrateProject(JSON.parse(await readFile(basePath, 'utf8'))), current: migrateProject(JSON.parse(await readFile(currentPath, 'utf8'))), operationIds: new Map<string, number>() }; this.branches.set(variantId, value); return value;
  }

  async open(paths: Array<string | undefined>): Promise<{ opened: Id[]; warnings: string[] }> {
    const opened: Id[] = []; const warnings: string[] = [];
    for (const path of paths) {
      if (!path) { warnings.push('A requested project path was empty.'); continue; }
      try { const loaded = await readProjectFolder(path); this.addProject(loaded.project, false, loaded.fileAudit); opened.push(loaded.project.id); warnings.push(...loaded.warnings); await this.options.journal.compact(loaded.project); }
      catch (error) { warnings.push(`${basename(path)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (opened.length) { const project = this.projects.get(opened.at(-1)!); if (project) await this.options.audio.synchronizeProject(project); }
    this.publish(); return { opened, warnings };
  }

  async save(projectId: Id, path?: string, actor: Actor = HUMAN_ACTOR): Promise<{ projectPath: string; warnings: string[]; audit: FileSavedAuditEvent }> {
    return this.mutateProject(projectId, () => this.saveUnlocked(projectId, path, actor));
  }

  private async saveUnlocked(projectId: Id, path: string | undefined, actor: Actor): Promise<{ projectPath: string; warnings: string[]; audit: FileSavedAuditEvent }> {
    const project = this.projects.get(projectId); if (!project) throw new Error('Project is not open.'); const destination = path ?? project.projectPath; if (!destination) throw new Error('A project folder has not been selected.');
    const known = new Map((this.fileAudit.get(projectId) ?? []).map((entry) => [entry.id, entry]));
    for (const source of new Set([project.projectPath, destination].filter((value): value is string => Boolean(value)))) {
      for (const entry of await readProjectFileAudit(source, projectId)) known.set(entry.id, entry);
    }
    const audit: FileSavedAuditEvent = { version: 1, id: createId('file-audit'), type: 'file.saved', projectId, actor: clone(actor), recordedAt: nowIso(), outcome: 'succeeded' };
    const entries = [...known.values(), audit];
    const result = await saveProjectFolder(project, destination, { appVersion: this.options.appVersion, resolveAssetSource: async (asset) => this.resolveAssetSource(project, asset), traceNdjson: await this.options.trace.ndjson(projectId), fileAuditNdjson: `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` });
    const saved = clone(project); saved.projectPath = result.projectPath; saved.dirty = false;
    try { await this.options.journal.compact(saved); } catch (error) { result.warnings.push(`Project files were saved, but recovery compaction failed: ${error instanceof Error ? error.message : String(error)}`); }
    this.projects.set(projectId, saved); this.fileAudit.set(projectId, entries.map(clone)); this.publish(); return { ...result, audit: clone(audit) };
  }

  async close(projectId: Id, force = false): Promise<{ closed: boolean; reason?: string }> {
    return this.mutateProject(projectId, () => this.closeUnlocked(projectId, force));
  }

  private async closeUnlocked(projectId: Id, force = false): Promise<{ closed: boolean; reason?: string }> {
    const project = this.projects.get(projectId); if (!project) return { closed: true }; if (project.dirty && !force) return { closed: false, reason: 'Project has unsaved changes.' };
    this.projects.delete(projectId); this.histories.delete(projectId); this.operationIds.delete(projectId); this.changes.delete(projectId); this.fileAudit.delete(projectId); for (const [id, lock] of this.locks) if (lock.projectId === projectId) this.locks.delete(id);
    if (!project.dirty) await this.options.journal.remove(projectId); this.activeProjectId = this.projects.keys().next().value; const active = this.activeProjectId ? this.projects.get(this.activeProjectId) : undefined; if (active) await this.options.audio.synchronizeProject(active); this.publish(); return { closed: true };
  }

  acquireLock(request: HumanLockRequest): { acquired: boolean; lockId?: Id; reason?: string } {
    this.expireLocks(); const candidate: HumanLock = { id: createId('lock'), projectId: request.projectId, actorId: HUMAN_ACTOR.id, entityIds: [...(request.entityIds ?? [])], range: request.range ? clone(request.range) : undefined, parameter: request.parameter ? clone(request.parameter) : undefined, acquiredAt: nowIso(), expiresAt: new Date(Date.now() + 10_000).toISOString() };
    if (this.locksCollide(candidate, [...this.locks.values()])) return { acquired: false, reason: 'The region is already locked.' }; this.locks.set(candidate.id, candidate); this.publish(); return { acquired: true, lockId: candidate.id };
  }
  refreshLock(lockId: Id): { refreshed: boolean } { const lock = this.locks.get(lockId); if (!lock) return { refreshed: false }; lock.expiresAt = new Date(Date.now() + 10_000).toISOString(); this.publish(); return { refreshed: true }; }
  releaseLock(lockId: Id): void { if (this.locks.delete(lockId)) this.publish(); }
  setSelection(selection?: TimelineSelection): void { this.selection = selection ? clone(selection) : undefined; this.publish(); }

  updatePresence(presence: AgentPresence): void { this.presence.set(presence.actor.id, clone(presence)); this.emitEvent({ type: 'presence', presence: clone(presence) }); this.publish(); }
  removePresence(actorId: Id): void { this.presence.delete(actorId); this.publish(); }
  stopAgents(projectId?: Id): number { const stopped = new Set<Id>(); let count = 0; for (const [id, presence] of this.presence) if (!projectId || presence.projectId === projectId) { this.presence.delete(id); stopped.add(id); count += 1; } for (const job of this.jobs.values()) if ((!projectId || job.projectId === projectId) && !['completed', 'failed', 'cancelled'].includes(job.status) && stopped.has(job.ownerActorId)) this.upsertJob({ ...job, status: 'cancelled', message: 'Cancelled by Stop Agents.', updatedAt: nowIso() }); this.publish(); return count; }

  upsertJob(job: AsyncJob): void { this.jobs.set(job.id, clone(job)); this.emitEvent({ type: 'job', job: clone(job) }); this.publish(); }
  getJob<T = unknown>(jobId: Id): AsyncJob<T> | undefined { const job = this.jobs.get(jobId); return job ? clone(job) as AsyncJob<T> : undefined; }
  listJobs(ownerActorId?: Id): AsyncJob[] { return [...this.jobs.values()].filter((job) => !ownerActorId || job.ownerActorId === ownerActorId).map(clone); }
  cancelJob(jobId: Id): AsyncJob | undefined { const job = this.jobs.get(jobId); if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job ? clone(job) : undefined; const next = { ...job, status: 'cancelled' as const, updatedAt: nowIso(), message: 'Cancelled.' }; this.upsertJob(next); return clone(next); }
  resolveJob(jobId: Id, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): AsyncJob | undefined { const job = this.jobs.get(jobId); if (!job || job.status !== 'waiting-for-user') return job ? clone(job) : undefined; const next: AsyncJob = decision === 'deny' ? { ...job, status: 'cancelled', message: 'Denied by user.', updatedAt: nowIso(), approval: undefined } : { ...job, status: 'queued', message: `Approved (${decision}).`, updatedAt: nowIso(), approval: undefined, result: { ...(typeof job.result === 'object' && job.result ? job.result : {}), approvalDecision: decision } }; this.upsertJob(next); this.emit('approval-resolved', clone(next), decision); return clone(next); }

  getChanges(projectId: Id, afterRevision: number): ChangeEntry[] { return (this.changes.get(projectId) ?? []).filter((entry) => entry.revision > afterRevision).map(clone); }
  listTrace(projectId: Id, limit?: number): Promise<TransactionTraceEntry[]> { return this.options.trace.list(projectId, limit); }
  findTrace(projectId: Id, transactionId: Id): Promise<TransactionTraceEntry | undefined> { return this.options.trace.find(projectId, transactionId); }
  listFileAudit(projectId: Id, limit = Number.POSITIVE_INFINITY): FileSavedAuditEvent[] { return (this.fileAudit.get(projectId) ?? []).slice(-limit).map(clone); }
  async compactRecovery(): Promise<void> { for (const project of this.projects.values()) await this.options.journal.compact(project); }
  async replayTrace(projectId: Id, transactionId: Id): Promise<{ replaying: boolean; reason?: string }> { const entry = await this.findTrace(projectId, transactionId); if (!entry?.transaction) return { replaying: false, reason: 'Transaction trace entry is unavailable.' }; const operations = entry.transaction.operations.length; for (let index = 0; index <= operations; index += 1) { this.emitEvent({ type: 'trace-replay', projectId, transactionId, progress: operations ? index / operations : 1, status: index === operations ? 'completed' : 'playing' }); if (index < operations) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(120, Math.max(20, 800 / Math.max(1, operations))))); } return { replaying: true }; }
  registerAssetSource(assetId: Id, path: string): void { this.assetSources.set(assetId, resolve(path)); }

  getAssetSource(projectId: Id, assetId: Id): string | undefined {
    const project = this.projects.get(projectId); const asset = project?.assets[assetId];
    return project && asset ? this.resolveAssetSource(project, asset) : undefined;
  }

  private resolveAssetSource(project: AIMuseProject, asset: MediaAsset): string | undefined {
    const registered = this.assetSources.get(asset.id); if (registered) return registered;
    if (asset.externalPath) return resolve(asset.externalPath);
    if (project.projectPath && asset.relativePath) return resolve(project.projectPath, asset.relativePath);
    return undefined;
  }

  private getHistory(projectId: Id, actorId: Id): HistoryState { const actors = this.histories.get(projectId) ?? new Map<Id, HistoryState>(); this.histories.set(projectId, actors); let value = actors.get(actorId); if (!value) { value = { undo: [], redo: [] }; actors.set(actorId, value); } return value; }
  private async mutateProject<T>(projectId: Id, work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current);
    this.mutationTails.set(projectId, tail);
    await previous;
    try { return await work(); }
    finally { release(); if (this.mutationTails.get(projectId) === tail) this.mutationTails.delete(projectId); }
  }
  private expireLocks(): void { const now = Date.now(); for (const [id, lock] of this.locks) if (new Date(lock.expiresAt).getTime() <= now) this.locks.delete(id); }

  private findLockCollision(project: AIMuseProject, operations: ProjectOperation[]): HumanLock | undefined {
    this.expireLocks(); const locks = [...this.locks.values()].filter((lock) => lock.projectId === project.id);
    for (const operation of operations) {
      const record = operation as unknown as Record<string, unknown>; const ids = new Set<string>();
      for (const key of ['trackId', 'clipId', 'deviceId', 'laneId', 'markerId', 'sectionId', 'assetId', 'deliverableId']) if (typeof record[key] === 'string') ids.add(String(record[key]));
      if ('clip' in record && record.clip && typeof record.clip === 'object' && 'id' in record.clip) ids.add(String((record.clip as { id: unknown }).id));
      let range: { trackId?: Id; startTick: number; endTick: number } | undefined;
      const clipId = typeof record.clipId === 'string' ? record.clipId : undefined; const clip = clipId ? project.clips[clipId] : undefined;
      if (clip) range = { trackId: clip.trackId, startTick: operation.kind === 'clip.move' || operation.kind === 'clip.trim' ? Number(record.startTick ?? clip.startTick) : clip.startTick, endTick: (operation.kind === 'clip.move' || operation.kind === 'clip.trim' ? Number(record.startTick ?? clip.startTick) + Number(record.durationTicks ?? clip.durationTicks) : clip.startTick + clip.durationTicks) };
      const candidate: HumanLock = { id: 'candidate', projectId: project.id, actorId: 'agent', entityIds: [...ids], range, parameter: operation.kind === 'device.parameter.set' ? { deviceId: operation.deviceId, parameterId: operation.parameterId } : undefined, acquiredAt: '', expiresAt: '' };
      const collision = locks.find((lock) => this.locksCollide(candidate, [lock])); if (collision) return collision;
    }
    return undefined;
  }

  private locksCollide(candidate: HumanLock, locks: HumanLock[]): boolean {
    return locks.some((lock) => {
      if (candidate.entityIds.some((id) => lock.entityIds.includes(id))) return true;
      if (candidate.parameter && lock.parameter && candidate.parameter.deviceId === lock.parameter.deviceId && candidate.parameter.parameterId === lock.parameter.parameterId) return true;
      if (candidate.range && lock.range && (!candidate.range.trackId || !lock.range.trackId || candidate.range.trackId === lock.range.trackId)) return candidate.range.startTick < lock.range.endTick && candidate.range.endTick > lock.range.startTick;
      return false;
    });
  }

  private publish(): void { this.emitEvent({ type: 'workspace', snapshot: this.snapshot() }); }
  private emitEvent(event: WorkspaceEvent): void { this.emit('event', event); }
}
