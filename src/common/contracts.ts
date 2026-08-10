import type {
  AIMuseProject,
  Actor,
  AsyncJob,
  AuthorityPolicy,
  Id,
  PluginDescriptor,
  ProjectKind,
  ProjectTransaction,
  TransportState,
} from '@aimuse/core';
import type { GenerationJobResult, GenerationRequest, ProviderCapabilities } from './generation';
import type { AgentClientId, AgentClientSetupResult } from './agent-clients';

export interface NewProjectOptions {
  kind: ProjectKind;
  name?: string;
  sampleRate?: 44_100 | 48_000 | 96_000;
  bpm?: number;
  timeSignature?: { numerator: number; denominator: 1 | 2 | 4 | 8 | 16 | 32 };
}

export interface ProjectTab {
  id: Id;
  name: string;
  kind: ProjectKind;
  dirty: boolean;
  revision: number;
  projectPath?: string;
  activityState?: 'active' | 'complete' | 'conflict' | 'approval' | 'degraded';
  activityActor?: Actor;
}

export interface TimelineSelection {
  trackIds: Id[];
  clipIds: Id[];
  startTick?: number;
  endTick?: number;
}

export interface HumanLock {
  id: Id;
  projectId: Id;
  actorId: Id;
  entityIds: Id[];
  range?: { trackId?: Id; startTick: number; endTick: number };
  parameter?: { deviceId: Id; parameterId: string };
  phase: 'gesture' | 'grace';
  acquiredAt: string;
  expiresAt: string;
}

export interface HumanLockRequest {
  projectId: Id;
  entityIds?: Id[];
  range?: { trackId?: Id; startTick: number; endTick: number };
  parameter?: { deviceId: Id; parameterId: string };
}

export interface AgentPresence {
  actor: Actor;
  projectId?: Id;
  cursor?: { tick: number; trackId?: Id; tool?: string };
  range?: { startTick: number; endTick: number; trackIds?: Id[] };
  queueDepth: number;
  status: 'idle' | 'working' | 'waiting' | 'disconnected';
  joinedAt: string;
}

export interface McpConnectionInfo {
  running: boolean;
  url?: string;
  port?: number;
  tokenHint?: string;
  instanceId?: string;
  profileId?: string;
  sessions: AgentPresence[];
}

export interface EngineStatus {
  running: boolean;
  uiAttached: boolean;
  startsAtLogin: boolean;
  startAtLoginSupported: boolean;
  mode: 'headless' | 'interactive';
  audio: { mode: 'native' | 'fallback'; connected: boolean; driver: 'wasapi' | 'coreaudio' | 'asio-bridge' | 'offline'; message?: string };
}

export interface WorkspaceSnapshot {
  projects: ProjectTab[];
  activeProjectId?: Id;
  activeProject?: AIMuseProject;
  jobs: AsyncJob[];
  plugins: PluginDescriptor[];
  locks: HumanLock[];
  mcp: McpConnectionInfo;
  transport: TransportState;
  selection?: TimelineSelection;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ApplyTransactionResponse {
  status: 'committed' | 'duplicate' | 'conflict' | 'busy' | 'locked' | 'cancelled' | 'engine-error';
  revision?: number;
  transactionId?: Id;
  checkpointId?: Id;
  message?: string;
  conflict?: { operationIndex?: number; entityId?: Id; expectedRevision?: number; actualRevision?: number; retryable: boolean };
}

export interface TransactionTraceEntry {
  version: 1;
  projectId: Id;
  revision: number;
  recordedAt: string;
  outcome: 'committed' | 'partial' | 'undo' | 'redo' | 'checkpoint' | 'merge';
  transaction?: ProjectTransaction;
  actor: Actor;
  label: string;
  details?: Record<string, unknown>;
}

/** Durable, non-undoable file-I/O audit. It intentionally excludes destination and approval details. */
export interface FileSavedAuditEvent {
  version: 1;
  id: Id;
  type: 'file.saved';
  projectId: Id;
  actor: Actor;
  recordedAt: string;
  outcome: 'succeeded';
}

export type WorkspaceEvent =
  | { type: 'workspace'; snapshot: WorkspaceSnapshot }
  | { type: 'transport'; state: TransportState }
  | { type: 'presence'; presence: AgentPresence }
  | { type: 'job'; job: AsyncJob }
  | { type: 'meter'; projectId: Id; trackId: Id; peakL: number; peakR: number; rmsL: number; rmsR: number }
  | { type: 'trace-replay'; projectId: Id; transactionId: Id; progress: number; status: 'playing' | 'completed' | 'cancelled' };

export interface SaveResult { saved: boolean; projectPath?: string; cancelled?: boolean; warnings: string[] }
export interface OpenResult { opened: Id[]; warnings: string[] }
export interface ExportRequest { projectId: Id; kind: 'master' | 'stems' | 'midi' | 'dawproject' | 'sfx-batch' | 'pack'; destination: string; format?: 'wav' | 'flac' | 'mp3'; startTick?: number; endTick?: number; trackIds?: Id[]; overwrite?: boolean }

export interface AIMuseDesktopAPI {
  bootstrap(): Promise<WorkspaceSnapshot>;
  newProject(options: NewProjectOptions): Promise<WorkspaceSnapshot>;
  activateProject(projectId: Id): Promise<WorkspaceSnapshot>;
  applyTransaction(transaction: ProjectTransaction): Promise<ApplyTransactionResponse>;
  undo(projectId?: Id): Promise<ApplyTransactionResponse>;
  redo(projectId?: Id): Promise<ApplyTransactionResponse>;
  openProjects(): Promise<OpenResult>;
  saveProject(projectId?: Id): Promise<SaveResult>;
  saveProjectAs(projectId?: Id): Promise<SaveResult>;
  closeProject(projectId: Id, force?: boolean): Promise<{ closed: boolean; reason?: string }>;
  acquireHumanLock(request: HumanLockRequest): Promise<{ acquired: boolean; lockId?: Id; lock?: HumanLock; reason?: string }>;
  refreshHumanLock(lockId: Id): Promise<{ refreshed: boolean; expiresAt?: string }>;
  holdHumanLock(lockId: Id): Promise<{ held: boolean; expiresAt?: string }>;
  releaseHumanLock(lockId: Id): Promise<void>;
  updateSelection(selection?: TimelineSelection): Promise<void>;
  transport(action: 'play' | 'record' | 'pause' | 'stop' | 'seek' | 'loop', options?: { tick?: number; loopEnabled?: boolean; loopStartTick?: number; loopEndTick?: number }): Promise<TransportState>;
  stopAgents(projectId?: Id): Promise<number>;
  getEngineStatus(): Promise<EngineStatus>;
  setEngineStartAtLogin(enabled: boolean): Promise<EngineStatus>;
  getMcpCredentials(): Promise<{ url?: string; token: string; instanceId: string; profileId: string }>;
  configureAgentClient(clientId: AgentClientId): Promise<AgentClientSetupResult>;
  configureCodex(): Promise<AgentClientSetupResult>;
  showApplicationMenu(): Promise<void>;
  mediaUrl(projectId: Id, assetId: Id): string;
  candidateMediaUrl(jobId: Id, candidateId: Id): string;
  resolveJob(jobId: Id, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): Promise<AsyncJob | undefined>;
  cancelJob(jobId: Id): Promise<AsyncJob | undefined>;
  importMedia(projectId?: Id): Promise<{ imported: number; warnings: string[] }>;
  exportProject(request: Omit<ExportRequest, 'destination'>): Promise<{ jobId?: Id; exported: boolean; destination?: string; warnings: string[]; cancelled?: boolean }>;
  createCheckpoint(projectId: Id, name: string): Promise<{ checkpointId: Id }>;
  restoreCheckpoint(projectId: Id, checkpointId: Id): Promise<ApplyTransactionResponse>;
  scanPlugins(): Promise<{ jobId: Id }>;
  generationStart(request: GenerationRequest): Promise<{ jobId: Id }>;
  generationAccept(jobId: Id, candidateId: Id, trackId?: Id, startTick?: number): Promise<ApplyTransactionResponse>;
  generationReject(jobId: Id, candidateId: Id): Promise<AsyncJob<GenerationJobResult> | undefined>;
  setProviderCredential(provider: GenerationRequest['provider'], value: string): Promise<{ saved: boolean }>;
  getProviderCapabilities(): Promise<ProviderCapabilities[]>;
  installAuthorityPolicy(policy: AuthorityPolicy): Promise<{ installed: boolean; reason?: string }>;
  replayTrace(projectId: Id, transactionId: Id): Promise<{ replaying: boolean; reason?: string }>;
  onEvent(callback: (event: WorkspaceEvent) => void): () => void;
  onNewProjectRequested(callback: (kind?: ProjectKind) => void): () => void;
}

export const IPC = {
  bootstrap: 'aimuse:bootstrap', newProject: 'aimuse:projects:new', activateProject: 'aimuse:projects:activate', applyTransaction: 'aimuse:project:apply',
  undo: 'aimuse:history:undo', redo: 'aimuse:history:redo', openProjects: 'aimuse:projects:open', saveProject: 'aimuse:projects:save', saveProjectAs: 'aimuse:projects:save-as', closeProject: 'aimuse:projects:close',
  acquireHumanLock: 'aimuse:locks:acquire', refreshHumanLock: 'aimuse:locks:refresh', holdHumanLock: 'aimuse:locks:hold', releaseHumanLock: 'aimuse:locks:release', updateSelection: 'aimuse:selection:update', transport: 'aimuse:transport', stopAgents: 'aimuse:agents:stop',
  engineStatus: 'aimuse:engine:status', engineStartAtLogin: 'aimuse:engine:start-at-login', mcpCredentials: 'aimuse:mcp:credentials', configureAgentClient: 'aimuse:mcp:configure-agent-client', configureCodex: 'aimuse:mcp:configure-codex',
  showApplicationMenu: 'aimuse:menu:show',
  resolveJob: 'aimuse:jobs:resolve', cancelJob: 'aimuse:jobs:cancel', importMedia: 'aimuse:media:import', exportProject: 'aimuse:projects:export', checkpointCreate: 'aimuse:checkpoints:create', checkpointRestore: 'aimuse:checkpoints:restore',
  scanPlugins: 'aimuse:plugins:scan', generationStart: 'aimuse:generation:start', generationAccept: 'aimuse:generation:accept', generationReject: 'aimuse:generation:reject', setProviderCredential: 'aimuse:generation:set-credential', providerCapabilities: 'aimuse:generation:capabilities',
  installAuthorityPolicy: 'aimuse:authority:install', replayTrace: 'aimuse:trace:replay', event: 'aimuse:event', newProjectRequested: 'aimuse:projects:new-requested',
} as const;

declare global {
  interface Window { aimuse: AIMuseDesktopAPI }
}
