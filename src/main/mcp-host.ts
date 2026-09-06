import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  createId, entityBase, nowIso,
  type Actor, type AsyncJob, type Id, type MediaAsset, type ProjectOperation, type ProjectTransaction,
} from '@aimuse/core';
import type { ExportRequest } from '../common/contracts';
import { RENDER_CAPABILITIES } from '../common/render-capabilities';
import { COMPOSITION_RULES, compositionExample, OPERATION_SCHEMAS, PUBLIC_OPERATION_KINDS } from './composition-help';
import { FairAgentMutationScheduler, type AgentMutationResult } from './agent-mutation-scheduler';
import { AudioEngineController } from './audio-engine';
import { UnsupportedAudioRenderError } from './audio-render-error';
import { AuthorityManager } from './authority-manager';
import { ExportManager } from './export-manager';
import { isEphemeralMcpToken } from './mcp-ephemeral-authority';
import { MediaManager, type MediaImportFileEffect } from './media-manager';
import { sha256File, unpackProjectPack, type ProjectPackUnpackEffect, type UnpackProjectPackOptions } from './persistence';
import { PluginManager, type PluginScanJobResult } from './plugin-manager';
import { ProjectService } from './project-service';
import { buildTraceReplayAudit, sha256Json, type ReplayableTraceEntry } from './trace-replay-audit';

const PORT_START = 48300; const PORT_END = 48331; const MAX_BODY = 4 * 1024 * 1024; const MAX_MCP_SESSIONS = 32; const SHOW_ACK_LIMIT = 64; const SHOW_ACK_RETENTION_MS = 5 * 60 * 1_000; const COLORS = ['#8b5cf6', '#06b6d4', '#f97316', '#10b981', '#ec4899', '#3b82f6'];
const SHOW_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface McpSession { actor: Actor; mcp: McpServer; transport: NodeStreamableHTTPServerTransport; resourceSubscriptions: Set<string>; reservationId: string; closePromise?: Promise<void> }
interface PendingSessionReservation { id: string; generation: number; index: number; session?: McpSession; settled: Promise<void>; settle: () => void; released: boolean }
interface McpRequestAdmission { authority: string; generation: number }
interface PortFile { version: 1; preferredPort: number }
type ApprovedProjectUnpackProgress = ProjectPackUnpackEffect | { phase: 'project-open'; state: 'started' };
type PendingProgress = { producer: 'media-import'; effect: MediaImportFileEffect } | { producer: 'project-unpack'; effect: ApprovedProjectUnpackProgress };
type PendingRun = (actor: Actor, observer?: (progress: PendingProgress) => void) => Promise<unknown>;
interface GenericPendingAction { producer: 'generic'; actor: Actor; run: PendingRun }
interface PendingProjectSaveAction { producer: 'project-save'; phase: 'waiting' | 'running'; actor: Actor; run: PendingRun }
interface PendingProjectOpenAction { producer: 'project-open'; phase: 'waiting' | 'running'; actor: Actor; run: PendingRun }
interface PendingProjectUnpackAction { producer: 'project-unpack'; phase: 'waiting' | 'running'; actor: Actor; run: PendingRun; partial: ApprovedProjectUnpackPartialEffects }
interface PendingPluginInstantiateAction { producer: 'plugin-instantiate'; phase: 'waiting' | 'running'; actor: Actor; run: PendingRun }
interface PendingMediaImportAction { producer: 'media-import'; phase: 'waiting' | 'running'; actor: Actor; run: PendingRun; partial: ApprovedMediaImportPartialEffects }
type PendingAction = GenericPendingAction | PendingProjectSaveAction | PendingProjectOpenAction | PendingProjectUnpackAction | PendingPluginInstantiateAction | PendingMediaImportAction;
type PendingProducer = PendingAction['producer'];
interface ApprovedProjectSavePartialEffects {
  destination: 'unchanged' | 'may-be-partial' | 'retained';
  project: 'unchanged' | 'save-may-have-completed' | 'saved';
  audit: 'unchanged' | 'may-have-been-recorded' | 'recorded';
}
interface ApprovedProjectOpenPartialEffects {
  sourceRead: 'not-started' | 'may-have-completed' | 'completed';
  workspaceIdentity: 'unchanged' | 'may-have-changed' | 'retained';
  openedProject: 'unchanged' | 'may-have-opened' | 'retained';
  audioController: 'unchanged' | 'may-have-synchronized' | 'synchronized';
}
interface ApprovedProjectUnpackPartialEffects {
  continuation: 'not-started' | 'running' | 'fulfilled' | 'rejected';
  archiveRead: 'not-started' | 'reading' | 'completed';
  destination: 'unchanged' | 'root-created' | 'may-be-partial' | 'retained' | 'removed';
  cleanup: 'not-started' | 'running' | 'completed' | 'failed';
  entries: {
    discovered: number;
    fileWritesStarted: number;
    filesWritten: number;
    directoriesCreated: number;
    active?: { index: number; entryType: 'directory' | 'file' };
  };
  projectValidation: 'not-started' | 'reading' | 'completed';
  projectOpen: 'not-started' | 'running' | 'fulfilled' | 'rejected';
  workspaceIdentity: 'unchanged' | 'may-have-changed' | 'retained';
  openedProject: 'unchanged' | 'may-have-opened' | 'retained';
  audioController: 'unchanged' | 'may-have-synchronized' | 'synchronized';
}
interface ApprovedPluginInstantiatePartialEffects {
  projectTransaction: 'not-started' | 'may-have-committed' | 'not-committed' | 'committed';
  device: 'unchanged' | 'may-have-been-added' | 'retained';
}
interface ApprovedMediaImportPartialEffects {
  continuation: 'not-started' | 'running' | 'fulfilled' | 'rejected';
  requestedFiles: number;
  files: MediaImportFileEffect[];
}
export type ShowAcknowledgementRejection = 'duplicate-request' | 'instance-mismatch' | 'malformed-request' | 'profile-mismatch' | 'window-error';
export interface ShowAcknowledgement { requestId: string; status: 'accepted' | 'pending' | 'rejected'; pid: number; instanceId: string; profileId: string; receivedAt: string; acknowledgedAt?: string; attempts: number; reason?: ShowAcknowledgementRejection }
class McpHttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

function safeEqualAuthority(left: string, right: string): boolean {
  if (!isEphemeralMcpToken(left) || !isEphemeralMcpToken(right)) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
interface NextStep { tool?: string; arguments?: Record<string, unknown>; guidance: string; humanRequired?: boolean }
function inferredNext(value: unknown): NextStep | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const jobId = typeof record.jobId === 'string' ? record.jobId : typeof record.id === 'string' && typeof record.status === 'string' ? record.id : undefined;
  if (jobId && record.status === 'waiting-for-user') return { tool: 'job_manage', arguments: { action: 'wait', jobId, timeoutMs: 0 }, guidance: 'A human must approve or deny this request in AIMuse. Agents cannot approve jobs; poll this owned job after the human decision.', humanRequired: true };
  if (jobId && !['completed', 'failed', 'cancelled'].includes(String(record.status ?? 'queued'))) return { tool: 'job_manage', arguments: { action: 'wait', jobId, timeoutMs: 1_000 }, guidance: 'Poll this owned job with a bounded wait, then inspect its terminal result.' };
  if (record.error === 'no_open_project') return { tool: 'project_manage', arguments: { action: 'list' }, guidance: 'List projects, then activate, open, or create one before retrying.' };
  if (record.error === 'path_required') return { tool: 'project_manage', arguments: { action: 'save', path: '<approved-folder>' }, guidance: 'Supply an approved destination path, or save a project that already has a working-folder path.' };
  if (record.error === 'invalid_arguments') return { tool: 'aimuse_help', arguments: { topic: 'tool-contracts' }, guidance: 'Read the tool contract, then retry with only the fields allowed for the selected action.' };
  return undefined;
}
function jsonText(value: unknown, explicitNext?: NextStep) {
  const next = explicitNext ?? inferredNext(value);
  const payload = next && value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>), next } : value;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], structuredContent: { data: payload, ...(next ? { next } : {}) } };
}
function terminal(status: AsyncJob['status']): boolean { return ['completed', 'failed', 'cancelled'].includes(status); }
const EXPORT_KINDS = new Set<ExportRequest['kind']>(['master', 'stems', 'midi', 'dawproject', 'sfx-batch', 'pack']);
function exportJobRequest(job: AsyncJob): ExportRequest | undefined {
  const result = typeof job.result === 'object' && job.result ? job.result as { request?: unknown } : undefined;
  const request = result?.request; if (!request || typeof request !== 'object') return undefined;
  const candidate = request as Partial<ExportRequest>;
  return typeof candidate.projectId === 'string' && typeof candidate.destination === 'string' && EXPORT_KINDS.has(candidate.kind as ExportRequest['kind']) ? candidate as ExportRequest : undefined;
}
function exportJobNext(job: AsyncJob): NextStep | undefined {
  const request = exportJobRequest(job); if (!request || !['failed', 'cancelled'].includes(job.status)) return undefined;
  const result = job.result as { partial?: { output?: string; project?: string } } | undefined; const output = result?.partial?.output; const pack = request.kind === 'pack';
  if (job.status === 'cancelled' && output === 'unchanged') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The export was cancelled before destination writes or a portable-pack save started. No automatic retry was attempted; inspect this owner job before issuing a new export.' };
  return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal for this owner job but does not preempt or clean up in-flight output.' : 'The export failed and AIMuse did not retry it automatically.'} Inspect result.partial and the destination${pack ? ', then re-observe the project because an already-started portable-pack save may have completed' : ''} before deciding whether to issue another export.` };
}
function approvedProjectSaveRequest(job: AsyncJob): { action: 'save'; projectId: Id; path: string } | undefined {
  if (job.kind !== 'save' || typeof job.result !== 'object' || !job.result) return undefined;
  const request = (job.result as { request?: unknown }).request; if (!request || typeof request !== 'object') return undefined; const candidate = request as Record<string, unknown>;
  return candidate.action === 'save' && typeof candidate.projectId === 'string' && typeof candidate.path === 'string' ? { action: 'save', projectId: candidate.projectId, path: candidate.path } : undefined;
}
function approvedProjectSaveNext(job: AsyncJob): NextStep | undefined {
  if (!approvedProjectSaveRequest(job) || !['cancelled', 'failed'].includes(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const partial = (job.result as { partial?: ApprovedProjectSavePartialEffects }).partial; if (!partial) return undefined;
  if (partial.destination === 'unchanged') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The approved project save was cancelled before destination writes, project clean-state publication, or file.saved audit recording. No automatic retry was attempted; inspect this owner job before issuing another save.' };
  if (partial.destination === 'retained') return { tool: 'project_observe', arguments: { projectId: job.projectId, includeFileAudit: true }, guidance: 'Cancellation remained terminal, but the approved save completed late: destination output remains, the project clean state/path was published, and the destination-free file.saved audit was recorded. Re-observe the project and audit, and inspect the destination before deciding whether to save again.' };
  return { tool: 'project_observe', arguments: { projectId: job.projectId, includeFileAudit: true }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal but did not preempt the running approved save.' : 'The approved project save failed and was not retried automatically.'} Destination output may be partial; project state is ${partial.project === 'unchanged' ? 'unchanged' : 'uncertain'} and audit recording is ${partial.audit === 'unchanged' ? 'unchanged' : 'uncertain'}. Re-observe the project and audit, and inspect the destination before deciding whether to save again.` };
}
function approvedProjectOpenRequest(job: AsyncJob): { action: 'open'; path: string } | undefined {
  if (job.kind !== 'media' || typeof job.result !== 'object' || !job.result) return undefined;
  const request = (job.result as { request?: unknown }).request; if (!request || typeof request !== 'object') return undefined; const candidate = request as Record<string, unknown>;
  return candidate.action === 'open' && typeof candidate.path === 'string' ? { action: 'open', path: candidate.path } : undefined;
}
function approvedProjectOpenNext(job: AsyncJob): NextStep | undefined {
  if (!approvedProjectOpenRequest(job) || !['cancelled', 'failed'].includes(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const partial = (job.result as { partial?: ApprovedProjectOpenPartialEffects }).partial; if (!partial) return undefined;
  if (partial.sourceRead === 'not-started') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The approved project open was cancelled before its source read, workspace changes, or audio-controller synchronization. No automatic retry was attempted; inspect this owner job before issuing another open.' };
  if (partial.workspaceIdentity === 'retained' && partial.audioController === 'synchronized') return { tool: 'project_manage', arguments: { action: 'list' }, guidance: 'Cancellation remained terminal, but the approved open completed late: its opened project remains in the workspace and settlement-time audio-controller project/revision confirm synchronization. List projects, then observe the retained project before deciding whether to open again.' };
  if (partial.sourceRead === 'completed' && partial.workspaceIdentity === 'unchanged') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'Cancellation remained terminal after the approved open finished without opening a project. Inspect its warnings, then list the workspace before deciding whether to open again; AIMuse did not retry automatically.' };
  return { tool: 'project_manage', arguments: { action: 'list' }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal but did not preempt the running approved open.' : 'The approved project open failed and was not retried automatically.'} The source read, workspace/opened-project state, and audio-controller synchronization remain uncertain. List the workspace and observe any retained project before deciding whether to open again.` };
}
function approvedProjectUnpackRequest(job: AsyncJob): { action: 'unpack'; path: string; destination: string } | undefined {
  if (job.kind !== 'pack' || typeof job.result !== 'object' || !job.result) return undefined;
  const request = (job.result as { request?: unknown }).request; if (!request || typeof request !== 'object') return undefined; const candidate = request as Record<string, unknown>;
  return candidate.action === 'unpack' && typeof candidate.path === 'string' && typeof candidate.destination === 'string'
    ? { action: 'unpack', path: candidate.path, destination: candidate.destination }
    : undefined;
}
function initialApprovedProjectUnpackPartial(): ApprovedProjectUnpackPartialEffects {
  return {
    continuation: 'not-started', archiveRead: 'not-started', destination: 'unchanged', cleanup: 'not-started',
    entries: { discovered: 0, fileWritesStarted: 0, filesWritten: 0, directoriesCreated: 0 },
    projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged',
  };
}
function approvedProjectUnpackNext(job: AsyncJob): NextStep | undefined {
  if (!approvedProjectUnpackRequest(job) || !['cancelled', 'failed'].includes(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const partial = (job.result as { partial?: ApprovedProjectUnpackPartialEffects }).partial; if (!partial) return undefined;
  if (partial.continuation === 'not-started') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The approved project unpack was cancelled before archive access, destination creation, extraction, validation, or project open. No automatic retry was attempted.' };
  const writes = `${partial.entries.filesWritten} completed file write${partial.entries.filesWritten === 1 ? '' : 's'} after ${partial.entries.fileWritesStarted} started`;
  if (partial.destination === 'removed') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: `${job.status === 'cancelled' ? 'Cancellation remained terminal after the approved unpack rejected.' : 'The approved unpack failed and was not retried.'} This run completed its destination-removal attempt after ${writes}; no project open started. Inspect the owner job before deciding whether to retry. This result does not promise cleanup for other failures.` };
  if (partial.destination === 'unchanged') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal.' : 'The approved unpack failed and was not retried.'} Archive access may have started, but this continuation created no destination root or project-open effect. Inspect the owner job and source before deciding whether to retry.` };
  if (partial.destination === 'retained' && partial.workspaceIdentity === 'retained' && partial.audioController === 'synchronized') return { tool: 'project_manage', arguments: { action: 'list' }, guidance: `Cancellation remained terminal, but the approved unpack completed late: extracted destination output remains, the opened project remains in the workspace, and settlement-time controller state confirms synchronization. List and observe the retained project, inspect the destination, then decide whether any repetition is needed. AIMuse did not retry or roll back automatically.` };
  if (partial.destination === 'retained' && partial.projectOpen === 'fulfilled' && partial.workspaceIdentity === 'unchanged') return { tool: 'project_manage', arguments: { action: 'list' }, guidance: `${job.status === 'cancelled' ? 'Cancellation remained terminal after' : 'The approved unpack failed after'} validated extraction remained at the destination, but the later open returned without retaining a project. Inspect this owner job and its warnings, list the workspace, and inspect the destination before repetition; AIMuse did not retry automatically.` };
  return { tool: 'project_manage', arguments: { action: 'list' }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal and did not preempt the compound unpack.' : 'The approved unpack failed and was not retried automatically.'} Owner-only evidence records ${writes}; destination state is ${partial.destination}, cleanup is ${partial.cleanup}, and project-open effects are ${partial.projectOpen}. Inspect the destination and this job again, then list the workspace and observe any retained project before repetition. No archive-wide atomicity, cleanup, rollback, preemption, or automatic retry is promised.` };
}
function approvedPluginInstantiateRequest(job: AsyncJob): { action: 'instantiate'; projectId: Id; trackId: Id; pluginId: string } | undefined {
  if (job.kind !== 'plugin-host' || typeof job.result !== 'object' || !job.result) return undefined;
  const request = (job.result as { request?: unknown }).request; if (!request || typeof request !== 'object') return undefined; const candidate = request as Record<string, unknown>;
  return candidate.action === 'instantiate' && typeof candidate.projectId === 'string' && typeof candidate.trackId === 'string' && typeof candidate.pluginId === 'string'
    ? { action: 'instantiate', projectId: candidate.projectId, trackId: candidate.trackId, pluginId: candidate.pluginId }
    : undefined;
}
function approvedPluginInstantiateNext(job: AsyncJob): NextStep | undefined {
  const request = approvedPluginInstantiateRequest(job); if (!request || !terminal(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const result = job.result as { output?: unknown; partial?: ApprovedPluginInstantiatePartialEffects }; const partial = result.partial; if (!partial) return undefined;
  if (partial.projectTransaction === 'not-started') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The approved plug-in instantiate was cancelled before its authority continuation or project transaction. No descriptor device or native host was created, and AIMuse did not retry automatically.' };
  if (partial.projectTransaction === 'committed' && partial.device === 'retained') return { tool: 'project_observe', arguments: { projectId: request.projectId }, guidance: `${job.status === 'cancelled' ? 'Cancellation remained terminal, but the approved instantiate transaction committed late.' : 'The approved instantiate transaction committed.'} Re-observe the retained descriptor device and project revision before another non-idempotent instantiate. This continuation did not start native plug-in hosting, and AIMuse did not retry automatically.` };
  if (partial.projectTransaction === 'not-committed') { const output = typeof result.output === 'object' && result.output ? result.output as { status?: unknown } : undefined; const outcome = typeof output?.status === 'string' ? ` with ${output.status} status` : ''; return { tool: 'project_observe', arguments: { projectId: request.projectId }, guidance: `The approved instantiate continuation settled${outcome} without committing its descriptor device. Re-observe the destination track, human locks, and project revision before deciding whether to try again; AIMuse did not retry automatically or start native plug-in hosting.` }; }
  return { tool: 'project_observe', arguments: { projectId: request.projectId }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal but did not preempt the running approved instantiate transaction.' : 'The approved instantiate continuation failed and was not retried automatically.'} Its descriptor-device commit remains uncertain. Re-observe the destination track and project revision before deciding whether to try again. No native plug-in hosting is claimed by this continuation.` };
}
function approvedMediaImportRequest(job: AsyncJob): { action: 'import'; projectId: Id; paths: string[] } | undefined {
  if (job.kind !== 'media' || typeof job.result !== 'object' || !job.result) return undefined;
  const request = (job.result as { request?: unknown }).request; if (!request || typeof request !== 'object') return undefined; const candidate = request as Record<string, unknown>;
  return candidate.action === 'import' && typeof candidate.projectId === 'string' && Array.isArray(candidate.paths) && candidate.paths.every((path) => typeof path === 'string')
    ? { action: 'import', projectId: candidate.projectId, paths: candidate.paths as string[] }
    : undefined;
}
function initialApprovedMediaImportPartial(requestedFiles: number): ApprovedMediaImportPartialEffects {
  return {
    continuation: 'not-started', requestedFiles,
    files: Array.from({ length: requestedFiles }, (_, index): MediaImportFileEffect => ({ index, outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' })),
  };
}
function approvedMediaImportNext(job: AsyncJob): NextStep | undefined {
  const request = approvedMediaImportRequest(job); if (!request || !['cancelled', 'failed'].includes(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const partial = (job.result as { partial?: ApprovedMediaImportPartialEffects }).partial; if (!partial) return undefined;
  if (partial.continuation === 'not-started') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: 'The approved media import was cancelled before its authority continuation, source reads, cache copies, or per-file project transactions. No automatic retry was attempted.' };
  const committed = partial.files.filter((file) => file.projectTransaction === 'committed').length; const uncertain = partial.files.filter((file) => file.projectTransaction === 'may-have-committed').length; const retainedCache = partial.files.filter((file) => file.cache === 'retained').length; const partialCache = partial.files.filter((file) => file.cache === 'may-be-partial').length; const warnings = partial.files.filter((file) => file.outcome === 'warning').length;
  const effects = `${committed} committed per-file project transaction${committed === 1 ? '' : 's'}, ${uncertain} uncertain transaction${uncertain === 1 ? '' : 's'}, ${retainedCache} retained cache output${retainedCache === 1 ? '' : 's'}, ${partialCache} possibly partial cache output${partialCache === 1 ? '' : 's'}, and ${warnings} warning${warnings === 1 ? '' : 's'}`;
  if (partial.continuation === 'fulfilled') return { tool: 'project_observe', arguments: { projectId: request.projectId }, guidance: `Cancellation remained terminal after the sequential approved media import settled with ${effects}. Earlier files and cache artifacts were not rolled back or cleaned up. Re-observe the project, inspect this owner job and its warnings, and inspect cache/source state before deciding whether to import again; AIMuse did not retry automatically.` };
  return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal but does not preempt the current approved media-import file.' : 'The approved media-import continuation failed and was not retried automatically.'} Current owner-only evidence reports ${effects}; it may settle further if the continuation is still running. Inspect this job again, then re-observe the project and cache/source state before deciding whether to import again. No cleanup, rollback, request-wide atomicity, or automatic retry is promised.` };
}
function pluginScanJobNext(job: AsyncJob): NextStep | undefined {
  if (job.kind !== 'plugin-scan' || !['cancelled', 'failed'].includes(job.status) || typeof job.result !== 'object' || !job.result) return undefined;
  const partial = (job.result as PluginScanJobResult).partial; if (!partial) return undefined;
  const helper = partial.nativeHelper === 'not-started' ? 'No native helper call started.' : partial.nativeHelper === 'unconfirmed' ? 'A native helper call may still be running or may have effects AIMuse cannot confirm.' : 'The invoked helper call settled, without a preemption or external-effect guarantee.';
  if (partial.catalog === 'replaced') return { tool: 'plugin_manage', arguments: { action: 'catalog' }, guidance: `${job.status === 'cancelled' ? 'Cancellation remained terminal, but' : 'The scan failed after'} the complete replacement catalog became globally observable. Partial candidate results were never published as a catalog. ${helper} Re-read the catalog and inspect this owner job before deciding whether to scan again; AIMuse did not retry automatically.` };
  if (partial.catalog === 'write-may-have-completed') return { tool: 'job_manage', arguments: { action: 'inspect', jobId: job.id }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal, but' : 'The scan failed while'} the atomic replacement-catalog write may have completed. The active catalog has not been confirmed by this result and may settle later. ${helper} Inspect this owner job again, then re-read the catalog before deciding whether to scan again; AIMuse did not clean up or retry automatically.` };
  const candidate = partial.candidateResults === 'partial' ? 'Some candidate results were computed privately, but no partial catalog was published.' : partial.candidateResults === 'complete' ? 'Candidate processing settled, but its results were not published as a catalog.' : partial.discovery === 'completed' ? 'No candidate result was produced.' : 'Candidate discovery did not settle.';
  return { tool: 'plugin_manage', arguments: { action: 'catalog' }, guidance: `${job.status === 'cancelled' ? 'Cancellation is terminal and' : 'The scan failed and'} the existing catalog remains active. ${candidate} ${helper} Re-read the catalog and inspect this owner job before deciding whether to scan again; AIMuse did not retry automatically.` };
}
function completedProjectOpenEffects(output: unknown, projectRetained: boolean, controllerSynchronized: boolean): ApprovedProjectOpenPartialEffects {
  const opened = typeof output === 'object' && output && Array.isArray((output as { opened?: unknown }).opened) && (output as { opened: unknown[] }).opened.every((id) => typeof id === 'string') ? (output as { opened: string[] }).opened : undefined;
  if (!opened) return { sourceRead: 'completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' };
  return opened.length
    ? { sourceRead: 'completed', workspaceIdentity: projectRetained ? 'retained' : 'may-have-changed', openedProject: projectRetained ? 'retained' : 'may-have-opened', audioController: controllerSynchronized ? 'synchronized' : 'may-have-synchronized' }
    : { sourceRead: 'completed', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' };
}
function jobSummary(job: AsyncJob): Record<string, unknown> { const summary = { id: job.id, projectId: job.projectId, kind: job.kind, status: job.status, progress: job.progress, message: job.message, createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error, result: terminal(job.status) ? job.result : undefined, dependency: job.status === 'waiting-for-user' && job.approval ? { type: 'user-approval', approval: job.approval, guidance: 'A human must review this request in AIMuse. job_manage cannot approve it.' } : undefined }; const next = exportJobNext(job) ?? approvedProjectSaveNext(job) ?? approvedProjectOpenNext(job) ?? approvedProjectUnpackNext(job) ?? approvedPluginInstantiateNext(job) ?? approvedMediaImportNext(job) ?? pluginScanJobNext(job) ?? inferredNext(summary); return { ...summary, ...(next ? { next } : {}) }; }

const NextStepSchema = z.object({ tool: z.string().optional().describe('Tool to call next, when another MCP call can advance the workflow.'), arguments: z.record(z.string(), z.unknown()).optional().describe('Suggested arguments; placeholders must be replaced with real IDs or approved paths.'), guidance: z.string().describe('Plain-language next action and boundary.'), humanRequired: z.boolean().optional().describe('True when only a human in AIMuse can advance the dependency.') }).strict();
const ToolOutputSchema = z.object({ data: z.unknown().describe('The tool-specific result. Text content contains the same JSON for clients without structured-output support.'), next: NextStepSchema.optional().describe('Explicit follow-up for jobs, approvals, or incomplete calls.') }).strict();
const TOOL_OUTPUT = { outputSchema: ToolOutputSchema } as const;

interface ActionRule { description: string; required?: string[]; allowed?: string[] }
function actionSchema<const Actions extends readonly [string, ...string[]], Fields extends z.ZodRawShape>(actions: Actions, fields: Fields, rules: Record<Actions[number], ActionRule>) {
  const names = Object.keys(fields);
  const schema = z.object({ action: z.enum(actions).describe('Selects one action; tools/list oneOf branches define its valid fields.'), ...fields }).strict().superRefine((value, context) => {
    const candidate = value as unknown as Record<string, unknown>; const action = String(candidate.action) as Actions[number]; const rule = rules[action]; const allowed = new Set(rule.allowed ?? rule.required ?? []);
    for (const required of rule.required ?? []) if (candidate[required] === undefined) context.addIssue({ code: 'custom', path: [required], message: `${required} is required when action is ${action}.` });
    for (const name of names) if (candidate[name] !== undefined && !allowed.has(name)) context.addIssue({ code: 'custom', path: [name], message: `${name} is not valid when action is ${action}.` });
  });
  return schema.meta({ oneOf: actions.map((actionValue) => { const action = actionValue as Actions[number]; const rule = rules[action]; const allowed = new Set(rule.allowed ?? rule.required ?? []); const forbidden = names.filter((name) => !allowed.has(name)); return { title: `${action}: ${rule.description}`, properties: { action: { const: action } }, required: ['action', ...(rule.required ?? [])], ...(forbidden.length ? { not: { anyOf: forbidden.map((name) => ({ required: [name] })) } } : {}) }; }) });
}

const ProjectIdField = z.string().min(1).optional().describe('Open project ID. When allowed and omitted, AIMuse uses the active project.');
const SessionSchema = actionSchema(['join', 'inspect', 'update', 'leave'], {
  name: z.string().min(1).max(100).optional().describe('Agent display name; required to join.'), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional().describe('Optional six-digit actor color.'), projectId: ProjectIdField,
  cursor: z.object({ tick: z.number().int().nonnegative(), trackId: z.string().optional(), tool: z.string().max(80).optional() }).strict().optional().describe('Current musical cursor and optional track/tool context.'),
  range: z.object({ startTick: z.number().int().nonnegative(), endTick: z.number().int().positive(), trackIds: z.array(z.string()).max(200).optional() }).strict().optional().describe('Current selected musical range; endTick must be after startTick.'),
  client: z.object({ product: z.string().max(100).optional(), model: z.string().max(160).optional(), effort: z.string().max(80).optional(), taskId: z.string().max(240).optional(), version: z.string().max(80).optional() }).strict().optional().describe('Non-secret client/model metadata shown in collaboration presence.'),
}, {
  join: { description: 'establish authenticated actor presence', required: ['name'], allowed: ['name', 'color', 'projectId', 'cursor', 'range', 'client'] }, inspect: { description: 'read presence and human locks' },
  update: { description: 'update this session cursor/range presence', allowed: ['projectId', 'cursor', 'range'] }, leave: { description: 'remove this session presence' },
});
const ProjectManageSchema = actionSchema(['list', 'new', 'activate', 'open', 'save', 'close', 'checkpoint', 'branch', 'compare', 'merge', 'discard-branch', 'pack', 'unpack'], {
  projectId: ProjectIdField, path: z.string().min(1).optional().describe('Local working-folder or pack source path; file authority applies.'), destination: z.string().min(1).optional().describe('Local output folder/file; file authority and no-overwrite rules apply.'), kind: z.enum(['song', 'sfx']).optional().describe('Project kind for new.'), name: z.string().max(200).optional().describe('Project, checkpoint, or branch name according to action.'), sampleRate: z.union([z.literal(44_100), z.literal(48_000), z.literal(96_000)]).optional().describe('New-project sample rate.'), bpm: z.number().min(20).max(400).optional().describe('New-project initial tempo.'), variantId: z.string().min(1).optional().describe('Named branch/variant ID.'), force: z.boolean().optional().describe('For close only: discard unsaved in-memory state without saving.'), overwrite: z.boolean().optional().describe('For pack only: explicit destination-overwrite intent; authority still applies.'),
}, {
  list: { description: 'list open projects' }, new: { description: 'create a project', allowed: ['kind', 'name', 'sampleRate', 'bpm'] }, activate: { description: 'activate a project', allowed: ['projectId'] }, open: { description: 'open an approved working folder', required: ['path'] }, save: { description: 'save active/specified project to its current or approved path', allowed: ['projectId', 'path'] }, close: { description: 'close a project, preserving dirty state unless force is explicit', allowed: ['projectId', 'force'] }, checkpoint: { description: 'create a durable project checkpoint', allowed: ['projectId', 'name'] }, branch: { description: 'create a named variant', allowed: ['projectId', 'name'] }, compare: { description: 'compare a named variant', required: ['variantId'] }, merge: { description: 'merge a named variant', required: ['variantId'] }, 'discard-branch': { description: 'discard a named variant', required: ['variantId'] }, pack: { description: 'start a portable-pack job', required: ['destination'], allowed: ['projectId', 'destination', 'overwrite'] }, unpack: { description: 'unpack to a new approved destination', required: ['path', 'destination'] },
});
const TransportSchema = actionSchema(['status', 'play', 'record', 'pause', 'stop', 'seek', 'loop'], { tick: z.number().int().nonnegative().optional().describe('Absolute musical tick for seek.'), loopEnabled: z.boolean().optional().describe('Whether looping is enabled.'), loopStartTick: z.number().int().nonnegative().optional().describe('Inclusive loop start tick.'), loopEndTick: z.number().int().positive().optional().describe('Exclusive loop end tick.'), recordingSource: z.enum(['microphone', 'midi-input']).optional().describe('Physical recording source; requires policy or human approval.') }, {
  status: { description: 'read transport state' }, play: { description: 'start playback' }, record: { description: 'request policy-gated recording', allowed: ['recordingSource'] }, pause: { description: 'pause playback' }, stop: { description: 'stop playback' }, seek: { description: 'seek to an absolute tick', required: ['tick'] }, loop: { description: 'configure looping', required: ['loopEnabled'], allowed: ['loopEnabled', 'loopStartTick', 'loopEndTick'] },
});
const MediaSchema = actionSchema(['list', 'import', 'analyze', 'audition', 'consolidate'], { projectId: ProjectIdField, paths: z.array(z.string().min(1)).min(1).max(512).optional().describe('Local media paths; inline bytes are never accepted.'), assetId: z.string().min(1).optional().describe('Project media asset ID.'), trackId: z.string().min(1).optional().describe('Destination or single audition track ID.'), trackIds: z.array(z.string()).max(200).optional().describe('Optional audition/consolidation track subset.'), startTick: z.number().int().nonnegative().optional(), endTick: z.number().int().positive().optional(), placeAtTick: z.number().int().nonnegative().optional().describe('Consolidated clip placement tick.') }, {
  list: { description: 'list project assets', allowed: ['projectId'] }, import: { description: 'import approved local paths', required: ['paths'], allowed: ['projectId', 'paths'] }, analyze: { description: 'analyze one asset', required: ['assetId'], allowed: ['projectId', 'assetId'] }, audition: { description: 'start an auditory observation render job', allowed: ['projectId', 'trackId', 'trackIds', 'startTick', 'endTick'] }, consolidate: { description: 'render and optionally place consolidated audio', allowed: ['projectId', 'trackId', 'trackIds', 'startTick', 'endTick', 'placeAtTick'] },
});
const PluginSchema = actionSchema(['catalog', 'scan', 'instantiate', 'set-parameter', 'set-preset', 'bypass', 'remove'], { projectId: ProjectIdField, roots: z.array(z.string()).max(50).optional().describe('Optional local scan roots.'), trackId: z.string().min(1).optional(), pluginId: z.string().min(1).optional(), deviceId: z.string().min(1).optional(), parameterId: z.string().min(1).optional(), value: z.number().optional(), presetName: z.string().min(1).max(500).optional(), bypassed: z.boolean().optional() }, {
  catalog: { description: 'read the plug-in catalog' }, scan: { description: 'start a local scan job', allowed: ['roots'] }, instantiate: { description: 'instantiate an allowed plug-in', required: ['trackId', 'pluginId'], allowed: ['projectId', 'trackId', 'pluginId'] }, 'set-parameter': { description: 'set a stable parameter ID', required: ['deviceId', 'parameterId', 'value'], allowed: ['projectId', 'deviceId', 'parameterId', 'value'] }, 'set-preset': { description: 'select a preset by name', required: ['deviceId', 'presetName'], allowed: ['projectId', 'deviceId', 'presetName'] }, bypass: { description: 'set device bypass state', required: ['deviceId'], allowed: ['projectId', 'deviceId', 'bypassed'] }, remove: { description: 'remove a device', required: ['deviceId'], allowed: ['projectId', 'deviceId'] },
});
const JobSchema = actionSchema(['list', 'inspect', 'wait', 'cancel', 'approval-dependency'], { jobId: z.string().min(1).optional().describe('Owned job ID; foreign IDs are indistinguishable from missing IDs.'), timeoutMs: z.number().int().min(0).max(30_000).optional().describe('Bounded wait duration. Zero performs one immediate observation.') }, {
  list: { description: 'list only this authenticated actor’s jobs' }, inspect: { description: 'inspect one owned job', required: ['jobId'] }, wait: { description: 'wait briefly for one owned job', required: ['jobId'], allowed: ['jobId', 'timeoutMs'] }, cancel: { description: 'request cancellation of one owned job', required: ['jobId'] }, 'approval-dependency': { description: 'inspect a human-only approval dependency without granting it', required: ['jobId'] },
});
const HistorySchema = actionSchema(['undo', 'redo'], { projectId: ProjectIdField }, { undo: { description: 'undo only this authenticated actor’s latest eligible edit', allowed: ['projectId'] }, redo: { description: 'redo only this authenticated actor’s latest eligible edit', allowed: ['projectId'] } });
const TraceReplaySchema = z.object({
  projectId: z.string().min(1).describe('Open project whose durable trace owns the transaction.'),
  transactionId: z.string().min(1).describe('Transaction ID selected from project_apply or aimuse://projects/{id}/trace.'),
}).strict();
const ProjectApplySchema = z.object({ projectId: z.string().min(1).describe('Open project ID to mutate.'), variantId: z.string().min(1).optional().describe('Required only when commitMode is branch.'), clientOperationId: z.string().min(1).max(240).describe('Caller-generated idempotency key; reuse returns duplicate rather than reapplying.'), label: z.string().min(1).max(500).describe('Human-readable intent shown in activity/history.'), operations: z.array(z.record(z.string(), z.unknown()).meta({ oneOf: Object.values(OPERATION_SCHEMAS) })).min(1).max(512).describe('Canonical operations; each oneOf branch declares the complete nested payload. See aimuse_help composition for a runnable melody/SFX example and operation-schemas for focused discovery.'), commitMode: z.enum(['direct', 'checkpointed', 'branch']).default('direct').describe('direct applies now; checkpointed forces a safety checkpoint; branch requires variantId.') }).strict().superRefine((value, context) => { if (value.commitMode === 'branch' && !value.variantId) context.addIssue({ code: 'custom', path: ['variantId'], message: 'variantId is required when commitMode is branch.' }); if (value.commitMode !== 'branch' && value.variantId) context.addIssue({ code: 'custom', path: ['variantId'], message: 'variantId is valid only when commitMode is branch.' }); }).meta({ allOf: [{ if: { properties: { commitMode: { const: 'branch' } }, required: ['commitMode'] }, then: { required: ['variantId'] } }] });

const SERVER_INSTRUCTIONS = 'Call aimuse_help(getting-started), then session_manage(join). Use project_manage/project_observe before edits, project_apply with a unique clientOperationId for content changes, trace_replay for a non-mutating visualization of a selected durable transaction, and job_manage for every returned jobId. Human approvals cannot be granted through MCP. Submit approval-capable requests one at a time: while one is being prepared or awaits a human, another fails with approval_pending and creates no job. File access is policy-gated; public job reads are owner-scoped. project_apply and history_manage mutation admission is fair and bounded; checkpoint/variant project_manage mutation admission shares the same lanes; plug-in parameter, preset, bypass, and remove mutation admission shares those lanes; WAV media analysis shares those lanes; audition/consolidation render-job creation shares them too. Retry only when a retryable queue response says to, and re-observe before issuing another non-idempotent history, checkpoint/variant, plug-in-device, or media action. AIMuse exposes native DAW editing and deterministic local tools; it has no generative-content provider tool or credential surface.';
const MCP_GUIDE = `# AIMuse MCP guide

## Safe starting workflow

1. Call \`aimuse_help\` with \`getting-started\` and then \`session_manage\` with \`join\`.
2. Use \`project_manage list\` and \`project_observe\` before changing state.
3. Submit musical edits through \`project_apply\` with a unique \`clientOperationId\`, current entity revisions, a clear label, and the smallest useful operation set.
4. When a result contains \`jobId\` or \`next\`, follow that guidance with \`job_manage\`. Waiting approvals are human-only and must be reviewed in AIMuse. Do not submit another approval-capable request until the prior request is terminal; AIMuse fails a concurrent request with \`approval_pending\` and creates no second job.
5. Re-observe state after commits. Use \`history_manage\` for only your authenticated actor's undo/redo. Use \`trace_replay\` to visualize a selected durable transaction without reapplying it.

## Identity, collaboration, and privacy

The server assigns the authenticated actor ID. Agent-supplied transaction actors, timestamps, revisions, assets, historical provenance, checkpoints, and variants are not trusted. Presence is collaborative, while job summaries/details/results are visible only to the owning authenticated session; a foreign job ID is indistinguishable from a missing ID. Active human entity/time locks take priority and return a retryable locked result without mutation. Direct and branch project transactions, actor-scoped undo/redo, checkpoint/variant create/merge/discard actions, plug-in parameter/preset/bypass/remove actions, WAV media analysis, and audition/consolidation render-job creation enter one four-lane actor-round-robin scheduler with bounded per-actor and global queues; backpressure is explicit and retryable. Queued cancellation starts no mutation. Queued plug-in device cancellation invokes no project transaction. Queued WAV analysis performs no source read, managed-cache write, or project transaction. Queued audition/consolidation creates no render job, invokes no render, writes no cache, and starts no project transaction. Running admission work is not preempted. History, checkpoint/variant, plug-in-device, and media actions are not generally idempotent, so inspect owned jobs when applicable and re-observe the project before deciding whether to issue another one. Branch creation retains its checkpoint-first compound-service semantics after it starts; cancellation is zero-write only while the request remains queued. Running WAV analysis writes three content-addressed cache outputs before one atomic asset-registration transaction, so cache artifacts can remain if a write or commit later fails. Admitted audition/consolidation job creation does not keep a mutation lane occupied while render remains pending. Cancelling that running job does not preempt the render or an already-started project transaction: late cache may remain, an in-flight asset commit may remain, and an in-flight consolidation clip commit may remain. Cancelled and failed jobs report those retained effects; a cancelled job is never overwritten by late completion or failure. Media import retains its separate authority and multi-file contract. Plug-in catalog observation, scan jobs, and authority-gated instantiate retain separate contracts and are not claimed by device-edit admission. Scan cancellation is terminal but does not preempt an already-started native helper or catalog write: partial candidate work is never published, while a complete replacement may remain if its atomic write resolves. Inspect the owner job again and re-read the globally shared catalog before repetition; AIMuse neither retries nor cleans up automatically.

Each engine start creates a fresh 32-byte bearer. AIMuse publishes it only in an atomic, user-private, PID/instance-bound run-state file for its product-owned stdio bridge, then removes that file on clean stop. The durable client setup launches that bridge with only the stable target-engine profile and contains no Chromium profile switch, bearer or per-launch value. The entry derives a real link-free Electron sibling, rejects canonical/filesystem aliases, revalidates it around installation, and prohibits macOS bridge activation. The bridge authenticates every loopback HTTP request, validates exact engine identity, recovers same-session notification-stream loss on the next client message, deletes a remote session whose initialization completes after close, and automatically initializes fresh internal authority after engine restart. The listener binds only to loopback, validates localhost Host/Origin, exposes no unauthenticated health or MCP endpoint, caps sessions, and keeps jobs owner-scoped.

## Files, jobs, and approvals

Approved media import cancellation is terminal. Waiting cancellation starts no authority continuation, source read, cache copy or per-file project transaction. Running cancellation does not preempt the current file: each file reports source-read, cache-copy, project-transaction, source-registration and warning effects independently; earlier commits and cache output survive later warnings. Inspect the owner job and re-observe before repetition. AIMuse does not clean up, roll back or retry automatically.

Approved project-unpack cancellation is terminal. Waiting cancellation starts no archive or destination work. Running cancellation does not preempt sequential archive reads/writes, validation, or an already-started project open; owner-only results retain entry counts, destination/cleanup state, and later workspace/project/controller settlement. Inspect the destination and re-observe the workspace before repetition. Unpack has no archive-wide atomicity, cleanup, rollback, preemption, automatic retry, or fair-lane promise.

Approved plug-in instantiate cancellation is terminal. Waiting cancellation starts no authority continuation or project transaction. Running cancellation does not preempt its one atomic descriptor-device transaction: a returned commit remains, a returned lock/conflict commits no device, and an exceptional failure is reported conservatively for project re-observation. The continuation honors current target validity and human locks, does not start native plug-in hosting, and is not retried automatically.

Open/import/save/export paths are checked against the process-lifetime authority policy and overwrite rules. An out-of-policy operation creates an owner-only approval job and performs no file I/O. MCP has no approval action: a human must allow or deny the request in AIMuse. Poll with bounded \`job_manage wait\`, then inspect terminal output. Approved project-open cancellation is terminal but does not preempt a running read or audio-controller synchronization: its result distinguishes no-start, uncertain, retained-open and completed-without-open effects, and callers must re-observe before repetition. A successful save records a durable, destination-free \`file.saved\` audit event with project and authenticated actor identity; it is separate from undoable musical history and does not increment the project revision.

## Tools and resources

Each tool's JSON Schema has action-specific \`oneOf\` branches and field descriptions. Use \`aimuse_help\` topics for progressive detail. Call composition for a complete runnable melody/SFX payload, operation-schemas for exact nested fields by kind, and rendering before audio export. Stored editing capabilities do not imply that all DSP is rendered. Resources are optional convenience surfaces: \`aimuse://projects\`, \`aimuse://sessions\`, \`aimuse://plugins\`, this guide, project manifest/snapshot/change/trace templates, owner-only job detail, and bounded analysis/audition media. \`trace_replay\` is the public action for a selected durable transaction: it emits bounded visualization progress and returns a deterministic receipt proving whether canonical state stayed unchanged. Exact-URI subscriptions receive only matching project updates.

## Boundaries

Inline media bytes, external provider calls, agent approval, writes to historical provenance, and generic server-owned operations are rejected. AIMuse has no provider adapter, provider credential, content-generation job, or source-separation adapter. Recording and plug-in hosting can require human approval. Use tool results—not assumptions about client support for instructions, prompts, or resources—as the authoritative next-step surface.`;

const HelpTopicSchema = z.enum(['getting-started', 'tool-contracts', 'projects-and-edits', 'jobs-and-approvals', 'files-and-audit', 'collaboration', 'resources', 'composition', 'operation-schemas', 'rendering']).describe('Focused help topic; omit for getting-started.');
function helpTopic(topic = 'getting-started', operationKind?: string, projectId = '<observed project ID>', actorId = '<session actor ID>'): Record<string, unknown> {
  const topics: Record<string, Record<string, unknown>> = {
    composition: { rules: COMPOSITION_RULES, example: compositionExample(projectId, actorId), nextSteps: ['Submit example as project_apply arguments, or adapt the IDs/note values first.', 'project_observe the committed entities.', 'export_manage kind master or sfx-batch to an authorized fresh destination, then job_manage wait/inspect.'] },
    'operation-schemas': { operationKinds: PUBLIC_OPERATION_KINDS, schemas: operationKind ? { [operationKind]: OPERATION_SCHEMAS[operationKind] } : OPERATION_SCHEMAS, rules: COMPOSITION_RULES },
    rendering: { capabilities: RENDER_CAPABILITIES },
    'getting-started': { workflow: ['session_manage join', 'project_manage list', 'project_observe', 'project_apply or a domain tool', 'trace_replay for selected durable transaction visualization', 'job_manage for returned jobId', 're-observe'], rules: ['Use unique clientOperationId values.', 'Treat next as actionable guidance.', 'A human alone can resolve approvals.'] },
    'tool-contracts': { guidance: 'Read tools/list. Every action tool exposes oneOf branches that declare required and forbidden fields; important fields and the structured output envelope are described. Invalid action/field combinations are rejected before execution.' },
    'projects-and-edits': { guidance: 'Observe before applying. project_apply is idempotent and actor-authenticated; branch commits require variantId. Server-owned checkpoint/variant create, merge, and discard actions use fair bounded admission but are not idempotent; compare is read-only. Re-observe revisions after every commit or queued cancellation. trace_replay visualizes a selected durable transaction and returns before/after canonical hashes; it never reapplies the transaction.' },
    'jobs-and-approvals': { guidance: 'Every job belongs to one authenticated actor. Use job_manage list/inspect/wait/cancel. waiting-for-user means a human must decide in AIMuse; MCP cannot approve. Submit one approval-capable request at a time: a concurrent request fails with approval_pending, creates no job, and reveals no incumbent owner, job, or request details. Foreign and missing IDs both return job_not_found. Approved media import cancellation is terminal. Waiting cancellation has no file/project effects; running cancellation does not preempt the current sequential file, so inspect per-file source/cache/transaction/source-registration/warning effects and re-observe before repetition. Earlier commits and cache output remain, with no rollback, cleanup, or retry. Approved project-unpack cancellation is terminal. Waiting cancellation starts no archive/destination/open work; running cancellation does not preempt sequential entries, validation, or project open, so inspect entry counts, destination/cleanup state and later workspace/controller effects before repetition. There is no archive-wide atomicity, cleanup, rollback, preemption, retry or fair-lane promise. Approved project-open cancellation is terminal but does not preempt an already-running source read or audio-controller synchronization: inspect its producer-specific result.partial and re-observe the workspace before deciding whether to open again; AIMuse never retries automatically. Approved project-save cancellation is terminal but does not preempt an already-running save: inspect destination/project/audit partial effects and re-observe before another save; AIMuse does not clean up or retry automatically. Approved plug-in instantiate cancellation is terminal. Waiting cancellation starts no continuation or project transaction; a running returned commit remains, a returned lock/conflict commits no device, exceptional failure remains conservative, native hosting is not started, and AIMuse never retries automatically. Plug-in scan cancellation is terminal but does not preempt an already-started helper or atomic catalog write: inspect its producer-specific result.partial again and re-read the globally shared catalog because a complete replacement may settle late, while partial candidate results are never published. Export cancellation is terminal but cooperative once running: inspect result.partial and the destination before repeating because AIMuse neither preempts/cleans output nor retries automatically, and a portable-pack save may already have completed.' },
    'files-and-audit': { guidance: 'File paths are canonicalized and authority-gated. Rejected access queues only the owner approval job and performs no I/O. Successful saves emit destination-free file.saved audit records without creating an undo step or changing project revision.' },
    collaboration: { guidance: 'Presence is shared and authenticated. Jobs/results stay owner-only. Human entity/time locks preempt conflicting agent edits; unrelated edits remain allowed. project_apply and actor undo/redo share four fair lanes with bounded actor/global queues and explicit retry guidance; checkpoint/variant create/merge/discard actions share those four fair lanes. plug-in parameter/preset/bypass/remove actions share those four fair lanes. WAV media analysis shares those four fair lanes; audition/consolidation render-job creation share those four fair lanes too. Queued cancellation starts no mutation; queued plug-in device cancellation invokes no project transaction, queued WAV analysis performs no source read, managed-cache write, or project transaction, and queued audition/consolidation creates no job/render/cache/project transaction. Pending media-render runtime uses the owner-only job lifecycle without keeping a mutation lane occupied. Running admission work is not preempted. History and checkpoint/variant mutations are not idempotent; plug-in-device and media actions are not generally idempotent. Inspect owned jobs when applicable and re-observe before deciding whether to issue another one. Running WAV analysis can leave content-addressed cache outputs before a failed atomic asset-registration transaction. Running media-job cancellation is cooperative: render output may remain, and already-started asset or consolidation clip transactions may commit; cancelled and failed jobs report retained effects, and a cancelled job never becomes completed or failed later. Media import keeps its separate authority and multi-file contract. Plug-in catalog, scan, and authority-gated instantiate keep their separate discovery/job/approval contracts.' },
    resources: { guidance: 'Resources are optional. aimuse://guide is complete; project manifest/snapshot/change/trace and media templates are observational. Use trace_replay with a project ID and transaction ID from the durable trace for a non-mutating visualization and deterministic audit receipt. aimuse://sessions filters jobs to the reader, and aimuse://jobs/{id} is owner-only. Subscriptions are exact URI strings.' },
  };
  return { topic, ...topics[topic], fullGuideResource: 'aimuse://guide' };
}

export interface McpSessionLifecycleHooks {
  beforeConnect?: (reservationId: string) => Promise<void>;
  beforeInitializeHandle?: (reservationId: string) => Promise<void>;
  initializationAborted?: (reservationId: string) => void;
  sessionClosed?: (reservationId: string) => void;
  requestAuthenticated?: (method: string, pathname: string, generation: number) => void;
}
export interface McpHostOptions { appVersion: string; profileId: string; portSettingsPath: string; cacheRoot: string; projects: ProjectService; audio: AudioEngineController; authority: AuthorityManager; media: MediaManager; plugins: PluginManager; exports: ExportManager; unpackProjectPack?: (packPath: string, destinationRoot: string, options?: UnpackProjectPackOptions) => Promise<string>; sessionLifecycleHooks?: McpSessionLifecycleHooks }

export class McpHost {
  private token = ''; private port?: number; private httpServer?: HttpServer; private readonly instanceId = randomUUID(); private readonly sessions = new Map<string, McpSession>(); private readonly sessionReservations = new Map<string, PendingSessionReservation>(); private sessionGeneration = 0; private sessionSequence = 0; private acceptingSessions = false; private stopPromise?: Promise<void>; private readonly pending = new Map<Id, PendingAction>(); private readonly showAcks = new Map<string, ShowAcknowledgement>(); private readonly mutationScheduler = new FairAgentMutationScheduler(); private lastRevisions = new Map<Id, number>();
  constructor(private readonly options: McpHostOptions) {
    options.projects.on('event', (event) => { if (event.type !== 'workspace') return; for (const project of event.snapshot.projects) if (this.lastRevisions.get(project.id) !== project.revision) { this.lastRevisions.set(project.id, project.revision); void this.notifyProject(project.id, project.revision); } });
    options.projects.on('approval-expired', (job: AsyncJob) => this.pending.delete(job.id));
    options.projects.on('approval-resolved', (job: AsyncJob, decision: string) => { const pending = this.pending.get(job.id); if (pending && decision !== 'deny') void this.runPending(job, pending); else if (decision === 'deny') this.pending.delete(job.id); });
  }

  async start(token: string): Promise<{ port: number; url: string; instanceId: string; profileId: string }> { if (!isEphemeralMcpToken(token)) throw new Error('MCP requires a fresh 32-byte engine-lifetime bearer token.'); if (this.httpServer || this.acceptingSessions) throw new Error('AIMuse MCP is already running.'); this.stopPromise = undefined; this.acceptingSessions = false; const generation = ++this.sessionGeneration; this.token = token; const preferred = await this.readPreferredPort(); const ports = [preferred, ...Array.from({ length: PORT_END - PORT_START + 1 }, (_, index) => PORT_START + index)].filter((value, index, values) => value >= PORT_START && value <= PORT_END && values.indexOf(value) === index); let failure: unknown; for (const port of ports) try { await this.listen(port); if (generation !== this.sessionGeneration) { await this.closeHttpServer(this.httpServer); this.httpServer = undefined; throw new Error('AIMuse MCP start was cancelled.'); } this.port = port; this.acceptingSessions = true; try { await mkdir(resolve(this.options.portSettingsPath, '..'), { recursive: true }); await import('./persistence').then(({ atomicWriteFile }) => atomicWriteFile(this.options.portSettingsPath, `${JSON.stringify({ version: 1, preferredPort: port } satisfies PortFile)}\n`)); } catch { /* Port preference is non-secret convenience state, never a listener prerequisite. */ } return { port, url: `http://127.0.0.1:${port}/mcp`, instanceId: this.instanceId, profileId: this.options.profileId }; } catch (error) { failure = error; if (generation !== this.sessionGeneration) break; } this.acceptingSessions = false; this.token = ''; throw failure instanceof Error ? failure : new Error('No AIMuse MCP port is available.'); }
  connection(): { url?: string; token: string; instanceId: string; profileId: string } { return { url: this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined, token: this.token, instanceId: this.instanceId, profileId: this.options.profileId }; }
  beginShowAcknowledgement(requestId: string): boolean {
    if (!SHOW_REQUEST_ID.test(requestId)) return false;
    const normalized = requestId.toLowerCase();
    const existing = this.showAcks.get(normalized);
    if (existing) {
      existing.status = 'rejected'; existing.reason = 'duplicate-request'; existing.attempts += 1; existing.acknowledgedAt = new Date().toISOString();
      return false;
    }
    this.pruneShowAcknowledgements();
    if (this.showAcks.size >= SHOW_ACK_LIMIT) return false;
    this.showAcks.set(normalized, { requestId: normalized, status: 'pending', pid: process.pid, instanceId: this.instanceId, profileId: this.options.profileId, receivedAt: new Date().toISOString(), attempts: 1 });
    return true;
  }
  completeShowAcknowledgement(requestId: string, status: 'accepted' | 'rejected', reason?: ShowAcknowledgementRejection): boolean {
    if (!SHOW_REQUEST_ID.test(requestId) || (status === 'accepted' && reason !== undefined) || (status === 'rejected' && reason === undefined)) return false;
    const acknowledgement = this.showAcks.get(requestId.toLowerCase());
    if (!acknowledgement || acknowledgement.status !== 'pending' || acknowledgement.attempts !== 1) return false;
    acknowledgement.status = status; acknowledgement.acknowledgedAt = new Date().toISOString();
    if (reason) acknowledgement.reason = reason;
    return true;
  }
  showAcknowledgements(): ShowAcknowledgement[] { return [...this.showAcks.values()].map((acknowledgement) => ({ ...acknowledgement })); }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingSessions = false;
    this.sessionGeneration += 1;
    const server = this.httpServer;
    this.httpServer = undefined;
    this.port = undefined;
    this.token = '';
    this.stopPromise = (async () => {
      this.mutationScheduler.cancelQueued();
      const committed = [...this.sessions.values()];
      this.sessions.clear();
      const reservations = [...this.sessionReservations.values()];
      await Promise.all([
        ...committed.map((session) => this.closeSession(session)),
        ...reservations.flatMap((reservation) => reservation.session ? [this.closeSession(reservation.session)] : []),
      ]);
      await Promise.all(reservations.map((reservation) => reservation.settled));
      await this.closeHttpServer(server);
      this.pending.clear();
      this.showAcks.clear();
    })();
    return this.stopPromise;
  }
  cancelQueuedMutations(projectId?: Id): number { return this.mutationScheduler.cancelQueued(projectId ? { projectId } : {}); }

  private pruneShowAcknowledgements(now = Date.now()): void {
    for (const [requestId, acknowledgement] of this.showAcks) {
      if (acknowledgement.status === 'pending' || !acknowledgement.acknowledgedAt) continue;
      const acknowledgedAt = Date.parse(acknowledgement.acknowledgedAt);
      if (Number.isFinite(acknowledgedAt) && acknowledgedAt <= now - SHOW_ACK_RETENTION_MS) this.showAcks.delete(requestId);
    }
  }

  private async listen(port: number): Promise<void> { const validateHost = localhostHostValidation(); const validateOrigin = localhostOriginValidation(); const server = createServer((request, response) => { if (!validateHost(request, response) || !validateOrigin(request, response)) return; response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); void this.handleRequest(request, response).catch((error) => { const status = error instanceof McpHttpError ? error.status : 500; const code = error instanceof McpHttpError ? error.code : 'mcp_request_failed'; if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' }); if (!response.writableEnded) response.end(JSON.stringify({ error: code, message: error instanceof Error ? error.message : 'MCP request failed.' })); }); }); await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolvePromise); }); this.httpServer = server; }
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port ?? PORT_START}`);
    const authorization = request.headers.authorization ?? '';
    const offeredAuthority = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const admission = this.admitRequest(offeredAuthority);
    if (!admission) {
      this.rejectUnauthorized(response);
      return;
    }
    this.options.sessionLifecycleHooks?.requestAuthenticated?.(request.method ?? 'GET', url.pathname, admission.generation);
    if (url.pathname === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'AIMuse Engine', version: this.options.appVersion, status: 'ok', pid: process.pid, instanceId: this.instanceId, profileId: this.options.profileId, showAcknowledgements: this.showAcknowledgements(), uiRequired: false, audio: this.options.audio.status() }));
      return;
    }
    if (url.pathname !== '/mcp') { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not_found"}'); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, { allow: 'GET, POST, DELETE, OPTIONS' }); response.end(); return; }
    let bodyBytes: Buffer | undefined;
    try {
      bodyBytes = request.method === 'POST' ? await this.readBodyBytes(request) : undefined;
    } catch (error) {
      if (!this.requireActiveAdmission(admission, response)) return;
      throw error;
    }
    if (!this.requireActiveAdmission(admission, response)) return;
    const body = bodyBytes === undefined ? undefined : this.parseBody(bodyBytes);
    const header = request.headers['mcp-session-id']; const sessionId = Array.isArray(header) ? header[0] : header;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    let reservation: PendingSessionReservation | undefined;
    let requestAborted = request.aborted || (response.destroyed && !response.writableFinished);
    const markRequestAborted = () => { if (requestAborted) return; requestAborted = true; if (reservation) this.options.sessionLifecycleHooks?.initializationAborted?.(reservation.id); };
    const markResponseClosed = () => { if (!response.writableFinished) markRequestAborted(); };
    request.once('aborted', markRequestAborted);
    request.socket.once('close', markRequestAborted);
    response.once('close', markResponseClosed);
    try {
      if (!session) {
        const method = body && typeof body === 'object' && 'method' in body ? (body as { method?: unknown }).method : undefined;
        if (request.method !== 'POST' || method !== 'initialize') { response.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: sessionId ? 'unknown_session' : 'initialization_required' })); return; }
        if (!this.requireActiveAdmission(admission, response)) return;
        reservation = this.reserveSession();
        if (!reservation) { response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' }); response.end('{"error":"session_limit"}'); return; }
        session = await this.createSession(reservation);
        if (!this.requireActiveAdmission(admission, response)) return;
        this.assertReservationActive(reservation, requestAborted);
        await this.options.sessionLifecycleHooks?.beforeInitializeHandle?.(reservation.id);
        if (!this.requireActiveAdmission(admission, response)) return;
        this.assertReservationActive(reservation, requestAborted);
      }
      if (request.method === 'DELETE' && sessionId) {
        if (!this.requireActiveAdmission(admission, response)) return;
        try { await session.transport.handleRequest(request, response, body); }
        finally { if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId); await this.closeSession(session); }
        return;
      }
      if (!this.requireActiveAdmission(admission, response)) return;
      await session.transport.handleRequest(request, response, body);
      if (reservation) {
        if (!this.requestAdmissionIsActive(admission)) return;
        this.assertReservationActive(reservation, requestAborted);
        const assigned = session.transport.sessionId;
        if (!assigned) throw new McpHttpError(400, 'initialization_failed', 'MCP initialization did not establish a session.');
        if (this.sessions.has(assigned)) throw new McpHttpError(409, 'session_collision', 'MCP assigned a duplicate session identity.');
        this.adoptReservation(reservation, assigned, session);
      }
    } finally {
      request.off('aborted', markRequestAborted);
      request.socket.off('close', markRequestAborted);
      response.off('close', markResponseClosed);
      if (reservation && !reservation.released) {
        if (session) await this.closeSession(session);
        this.releaseReservation(reservation);
      }
    }
  }
  private admitRequest(offeredAuthority: string): McpRequestAdmission | undefined {
    const authority = this.token;
    const generation = this.sessionGeneration;
    if (!this.acceptingSessions || !safeEqualAuthority(offeredAuthority, authority)) return undefined;
    return { authority, generation };
  }
  private requestAdmissionIsActive(admission: McpRequestAdmission): boolean { return this.acceptingSessions && admission.generation === this.sessionGeneration && safeEqualAuthority(admission.authority, this.token); }
  private requireActiveAdmission(admission: McpRequestAdmission, response: ServerResponse): boolean { if (this.requestAdmissionIsActive(admission)) return true; this.rejectUnauthorized(response); return false; }
  private rejectUnauthorized(response: ServerResponse): void { response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="AIMuse MCP"' }); response.end('{"error":"invalid_token"}'); }
  private async readBodyBytes(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength; if (bytes > MAX_BODY) throw new McpHttpError(413, 'body_too_large', 'MCP body exceeds 4 MiB.'); chunks.push(value); } return Buffer.concat(chunks); }
  private parseBody(bytes: Buffer): unknown { if (!bytes.byteLength) return undefined; try { return JSON.parse(bytes.toString('utf8')); } catch { throw new McpHttpError(400, 'invalid_json', 'MCP request body is not valid JSON.'); } }
  private reserveSession(): PendingSessionReservation | undefined {
    if (!this.acceptingSessions || this.sessions.size + this.sessionReservations.size >= MAX_MCP_SESSIONS) return undefined;
    let settle!: () => void;
    const reservation: PendingSessionReservation = { id: randomUUID(), generation: this.sessionGeneration, index: this.sessionSequence++, settled: new Promise<void>((resolvePromise) => { settle = resolvePromise; }), settle, released: false };
    this.sessionReservations.set(reservation.id, reservation);
    return reservation;
  }
  private reservationIsActive(reservation: PendingSessionReservation): boolean { return this.acceptingSessions && reservation.generation === this.sessionGeneration && this.sessionReservations.get(reservation.id) === reservation && !reservation.released; }
  private assertReservationActive(reservation: PendingSessionReservation, requestAborted = false): void {
    if (requestAborted) throw new McpHttpError(400, 'initialization_aborted', 'MCP initialization was aborted by the client.');
    if (!this.reservationIsActive(reservation)) throw new McpHttpError(503, 'server_stopping', 'AIMuse MCP is stopping.');
  }
  private releaseReservation(reservation: PendingSessionReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    if (this.sessionReservations.get(reservation.id) === reservation) this.sessionReservations.delete(reservation.id);
    reservation.settle();
  }
  private adoptReservation(reservation: PendingSessionReservation, sessionId: string, session: McpSession): void {
    this.assertReservationActive(reservation);
    this.sessionReservations.delete(reservation.id);
    this.sessions.set(sessionId, session);
    reservation.released = true;
    reservation.settle();
  }
  private async createSession(reservation: PendingSessionReservation): Promise<McpSession> {
    const index = reservation.index;
    const session: McpSession = { actor: { id: createId('agent'), kind: 'agent', name: `Agent ${index + 1}`, color: COLORS[index % COLORS.length] }, mcp: undefined as unknown as McpServer, transport: new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }), resourceSubscriptions: new Set(), reservationId: reservation.id };
    session.mcp = this.buildServer(session);
    reservation.session = session;
    try {
      await this.options.sessionLifecycleHooks?.beforeConnect?.(reservation.id);
      this.assertReservationActive(reservation);
      await session.mcp.connect(session.transport);
      this.assertReservationActive(reservation);
      return session;
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
  }
  private closeSession(session: McpSession): Promise<void> {
    if (!session.closePromise) session.closePromise = (async () => {
      session.resourceSubscriptions.clear();
      this.mutationScheduler.cancelQueued({ actorId: session.actor.id });
      this.options.projects.removePresence(session.actor.id);
      this.options.sessionLifecycleHooks?.sessionClosed?.(session.reservationId);
      await session.mcp.close().catch(() => undefined);
    })();
    return session.closePromise;
  }
  private async closeHttpServer(server: HttpServer | undefined): Promise<void> { if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())); }

  private buildServer(session: McpSession): McpServer {
    const server = new McpServer({ name: 'aimuse', version: this.options.appVersion }, { capabilities: { resources: { subscribe: true, listChanged: true }, tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS }); const projects = this.options.projects;
    server.server.setRequestHandler('resources/subscribe', async (request) => { session.resourceSubscriptions.add(request.params.uri); return {}; });
    server.server.setRequestHandler('resources/unsubscribe', async (request) => { session.resourceSubscriptions.delete(request.params.uri); return {}; });
    server.registerResource('Open AIMuse projects', 'aimuse://projects', { title: 'Open AIMuse projects', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(projects.snapshot(session.actor.id).projects) }] }));
    server.registerResource('AIMuse sessions', 'aimuse://sessions', { title: 'Collaboration presence and reader-owned jobs', description: 'Shared authenticated presence plus job summaries owned by this exact MCP session only.', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ presence: projects.getMcpInfo().sessions, jobs: projects.listJobs(session.actor.id).map(jobSummary) }) }] }));
    server.registerResource('AIMuse plug-in catalog', 'aimuse://plugins', { title: 'VST3 and CLAP catalog', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.options.plugins.list()) }] }));
    server.registerResource('AIMuse MCP guide', 'aimuse://guide', { title: 'Complete AIMuse MCP guide', description: 'Optional full workflow, privacy, authority, job and discovery guidance.', mimeType: 'text/markdown' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: MCP_GUIDE }] }));
    const manifest = new ResourceTemplate('aimuse://projects/{id}/manifest', { list: undefined }); server.registerResource('AIMuse project manifest', manifest, { title: 'Project manifest', mimeType: 'application/json' }, async (uri, variables) => { const project = projects.getProject(String(variables.id)); if (!project) throw new Error('Project is not open.'); return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ format: project.format, schemaVersion: project.schemaVersion, id: project.id, revision: project.revision, name: project.name, kind: project.kind, dirty: project.dirty, sampleRate: project.settings.sampleRate, tracks: Object.keys(project.tracks).length, clips: Object.keys(project.clips).length, assets: Object.keys(project.assets).length }) }] }; });
    const snapshot = new ResourceTemplate('aimuse://projects/{id}/snapshot', { list: undefined }); server.registerResource('AIMuse project snapshot', snapshot, { title: 'Canonical project snapshot', mimeType: 'application/json' }, async (uri, variables) => { const project = projects.getProject(String(variables.id)); if (!project) throw new Error('Project is not open.'); return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(project) }] }; });
    const changes = new ResourceTemplate('aimuse://projects/{id}/changes/{revision}', { list: undefined }); server.registerResource('AIMuse revision changes', changes, { title: 'Revision changes', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(projects.getChanges(String(variables.id), Number(variables.revision))) }] }));
    const trace = new ResourceTemplate('aimuse://projects/{id}/trace', { list: undefined }); server.registerResource('AIMuse transaction trace', trace, { title: 'Durable transaction trace', mimeType: 'application/x-ndjson' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/x-ndjson', text: (await projects.listTrace(String(variables.id))).map((entry) => JSON.stringify(entry)).join('\n') }] }));
    const jobs = new ResourceTemplate('aimuse://jobs/{id}', { list: undefined }); server.registerResource('AIMuse job', jobs, { title: 'Reader-owned job status', description: 'Owner-only job detail; foreign IDs are indistinguishable from missing IDs.', mimeType: 'application/json' }, async (uri, variables) => { const job = projects.getJob(String(variables.id)); if (!job || job.ownerActorId !== session.actor.id) throw new Error('Job does not exist.'); return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jobSummary(job)) }] }; });
    const media = new ResourceTemplate('aimuse://projects/{projectId}/media/{assetId}', { list: undefined }); server.registerResource('AIMuse analysis or audition media', media, { title: 'Analysis/audition media', mimeType: 'application/octet-stream' }, async (uri, variables) => { const projectId = String(variables.projectId); const assetId = String(variables.assetId); const project = projects.getProject(projectId); const asset = project?.assets[assetId]; const path = projects.getAssetSource(projectId, assetId); if (!asset || !path || !['analysis', 'audition'].includes(asset.kind)) throw new Error('Observation asset is unavailable.'); const bytes = await readFile(path); if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Observation asset exceeds the MCP resource limit.'); return { contents: [{ uri: uri.href, mimeType: asset.mimeType, blob: bytes.toString('base64') }] }; });

    server.registerTool('aimuse_help', { title: 'Learn AIMuse MCP workflows', description: 'Returns focused, model-readable workflow, privacy, authority, job, save-audit, and resource guidance. Call this first; use aimuse://guide only when the client supports resources.', inputSchema: z.object({ topic: HelpTopicSchema.optional(), operationKind: z.enum(PUBLIC_OPERATION_KINDS).optional().describe('Filter operation-schemas to one complete payload schema.') }).strict(), ...TOOL_OUTPUT, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ topic, operationKind }) => jsonText(helpTopic(topic, operationKind, projects.getActiveProjectId(), session.actor.id)));
    server.registerTool('session_manage', { title: 'Manage AIMuse session', description: 'Join before work; inspect shared presence/human locks; update this actor’s cursor/range; or leave. Returns the server-assigned actor, presence and locks.', inputSchema: SessionSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ action, name, color, projectId, cursor, range, client }) => { if (action === 'leave') projects.removePresence(session.actor.id); else { if (name) session.actor.name = name; if (color) session.actor.color = color; if (client) session.actor.client = client; if (action !== 'inspect') projects.updatePresence({ actor: structuredClone(session.actor), projectId, cursor, range, queueDepth: projects.listJobs(session.actor.id).filter((job) => !terminal(job.status)).length, status: 'idle', joinedAt: nowIso() }); } return jsonText({ actor: session.actor, presence: projects.getMcpInfo().sessions, locks: projects.snapshot(session.actor.id).locks }); });

    server.registerTool('project_manage', { title: 'Manage AIMuse projects', description: 'Project lifecycle/branches. Checkpoint/variant create, merge, and discard mutations use fair bounded admission and are not idempotent; compare remains read-only. Returns project/workspace data, safe save audit, or a jobId; open/save/pack/unpack are authority-gated and jobs use job_manage. Approved project-unpack cancellation is terminal and reports sequential archive/destination/open effects without archive-wide atomicity, preemption, cleanup, rollback, retry, or fair-lane claims. Approved project-open cancellation is terminal and reports source/workspace/project/audio-controller partial effects without preemption or retry. Approved project-save cancellation is terminal and reports destination/project/audit partial effects; a running save is not preempted, cleaned up, or retried automatically.', inputSchema: ProjectManageSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async (request) => {
      const projectId = request.projectId ?? projects.getActiveProjectId();
      if (request.action === 'list') return jsonText(projects.snapshot(session.actor.id).projects);
      if (request.action === 'new') return jsonText(await projects.create({ kind: request.kind ?? 'song', name: request.name, sampleRate: request.sampleRate, bpm: request.bpm }, session.actor));
      if (request.action === 'activate' && projectId) return jsonText(await projects.activate(projectId, session.actor.id));
      if (request.action === 'close' && projectId) return jsonText(await projects.close(projectId, request.force ?? false));
      if (request.action === 'checkpoint' && projectId) return this.scheduleProjectDomainMutation(session, projectId, 'checkpoint creation', (actor) => projects.createCheckpoint(projectId, request.name ?? 'Agent checkpoint', actor));
      if (request.action === 'branch' && projectId) return this.scheduleProjectDomainMutation(session, projectId, 'branch creation', (actor) => projects.createBranch(projectId, request.name ?? 'Agent variant', actor));
      if (request.action === 'compare' && request.variantId) return jsonText(await projects.compareBranch(request.variantId));
      if ((request.action === 'merge' || request.action === 'discard-branch') && request.variantId) {
        const variantProjectId = projects.getProjects().find((project) => Boolean(project.variants[request.variantId!]))?.id;
        if (!variantProjectId) return jsonText(request.action === 'merge' ? await projects.mergeBranch(request.variantId, session.actor) : await projects.discardBranch(request.variantId, session.actor));
        if (request.action === 'merge') return this.scheduleProjectDomainMutation(session, variantProjectId, 'branch merge', (actor) => projects.mergeBranch(request.variantId!, actor));
        return this.scheduleProjectDomainMutation(session, variantProjectId, 'branch discard', (actor) => projects.discardBranch(request.variantId!, actor));
      }
      if (request.action === 'pack' && projectId && request.destination) return this.startApprovalCapableJob(session, (reservationId) => this.options.exports.start({ projectId, kind: 'pack', destination: request.destination!, overwrite: request.overwrite ?? false }, session.actor, reservationId));
      if (request.action === 'open' && request.path) return this.fileAction(session, request.path, 'read', 'media', 'Open project folder', { action: 'open', path: resolve(request.path) }, async () => projects.open([request.path]), 'project-open'); if (request.action === 'save' && projectId) { const target = request.path ?? projects.getProject(projectId)?.projectPath; if (!target) return jsonText({ error: 'path_required' }); return this.fileAction(session, target, 'write', 'save', 'Save project folder', { action: 'save', projectId, path: resolve(target) }, async (actor) => projects.save(projectId, target, actor), 'project-save'); } if (request.action === 'unpack' && request.path && request.destination) return this.multiFileAction(session, [{ path: request.path, mode: 'read' }, { path: request.destination, mode: 'write' }], 'pack', 'Unpack portable project', { action: 'unpack', path: resolve(request.path), destination: resolve(request.destination) }, async (_actor, observer) => { const folder = await (this.options.unpackProjectPack ?? unpackProjectPack)(request.path!, request.destination!, { observe: (effect) => observer?.({ producer: 'project-unpack', effect }) }); observer?.({ producer: 'project-unpack', effect: { phase: 'project-open', state: 'started' } }); return projects.open([folder]); }, 'project-unpack'); return jsonText({ error: 'invalid_arguments' });
    });

    server.registerTool('project_observe', { title: 'Observe AIMuse project', description: 'Read a canonical snapshot or revision diff before/after edits, with optional editor state, safe file-save audit, and bounded observation-resource references.', inputSchema: z.object({ projectId: ProjectIdField, variantId: z.string().min(1).optional().describe('Observe a named branch instead of the main project.'), sinceRevision: z.number().int().nonnegative().optional().describe('Return main-project transactions strictly after this revision instead of the full snapshot.'), includeEditor: z.boolean().default(false).describe('Include attached editor selection, transport and human locks.'), includeFileAudit: z.boolean().default(false).describe('Include durable destination-free file.saved records; these are not undoable content history.'), assetIds: z.array(z.string()).max(20).default([]).describe('Return resource references for these analysis/audition asset IDs.') }).strict(), ...TOOL_OUTPUT, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ projectId, variantId, sinceRevision, includeEditor, includeFileAudit, assetIds }) => { const id = projectId ?? projects.getActiveProjectId(); if (!id) return jsonText({ error: 'no_open_project' }); const project = variantId ? await projects.getBranch(variantId) : projects.getProject(id); if (!project) return jsonText({ error: 'project_not_open' }); const workspace = projects.snapshot(session.actor.id); return jsonText({ project: sinceRevision === undefined ? project : undefined, changes: sinceRevision === undefined || variantId ? undefined : projects.getChanges(id, sinceRevision), revision: project.revision, fileAudit: includeFileAudit ? projects.listFileAudit(id) : undefined, editor: includeEditor ? { selection: workspace.selection, transport: workspace.transport, locks: workspace.locks } : undefined, observations: assetIds.map((assetId) => { const asset = project.assets[assetId]; return asset ? { assetId, kind: asset.kind, mimeType: asset.mimeType, resource: `aimuse://projects/${id}/media/${assetId}` } : { assetId, error: 'not_found' }; }) }); });

    server.registerTool('project_apply', { title: 'Apply AIMuse transaction', description: 'Fairly schedules up to 512 idempotent content operations. Returns status plus revision/transaction/checkpoint, bounded conflict, or explicit retryable backpressure; Nested creation metadata fields remain required placeholders; AIMuse overwrites their actor/time attribution. Call aimuse_help composition for a runnable example and rendering for actual audio limits.', inputSchema: ProjectApplySchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, async ({ projectId, variantId, clientOperationId, label, operations, commitMode }) => {
      const forbidden = operations.find((operation) => ['asset.add', 'provenance.register', 'provenance.update', 'provenance.delete', 'checkpoint.register', 'variant.register', 'variant.update'].includes(String(operation.kind)));
      if (forbidden) return jsonText({ status: 'conflict', message: `${String(forbidden.kind)} is server-owned. Historical generation provenance is read-only; use the corresponding media, checkpoint, or branch tool for other server-owned entities.` });
      const transaction: ProjectTransaction = { id: createId('tx'), clientOperationId, projectId, actor: structuredClone(session.actor), label, createdAt: nowIso(), operations: operations as ProjectOperation[], checkpointPolicy: commitMode === 'checkpointed' ? 'required' : 'auto' };
      const scheduled = await this.submitMutation(session, projectId, operations.length,
        () => commitMode === 'branch' ? projects.applyBranch(variantId!, transaction, session.actor) : projects.apply(transaction, session.actor));
      if (!scheduled.accepted) {
        const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
        if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, { tool: 'project_observe', arguments: { projectId }, guidance: 'Re-observe the project before deciding whether to submit the cancelled intent again.' });
        return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, { guidance: `Wait at least ${scheduled.retryAfterMs} ms, then retry the same idempotent project_apply request.` });
      }
      return jsonText(scheduled.result);
    });

    server.registerTool('transport_manage', { title: 'Manage AIMuse transport', description: 'Read/control the shared transport and return its state. Seek/loop fields are action-specific; microphone recording is policy-gated, while MIDI input reports unavailable until a native backend is connected.', inputSchema: TransportSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async ({ action, recordingSource, ...options }) => { if (action === 'status') return jsonText(this.options.audio.snapshot()); if (action === 'record' && recordingSource === 'midi-input') return jsonText({ error: 'midi_input_unavailable', message: 'MIDI input capture is unavailable because no native MIDI backend is connected.', retryable: false }, { guidance: 'Do not treat transport recording state as MIDI capture. Connect and verify a native MIDI backend before requesting MIDI input recording.' }); if (action === 'record') { const kind = recordingSource ?? 'microphone'; const decision = this.options.authority.recording(kind); if (!decision.allowed) return this.queueApproval(session, 'approval', decision.approvalKind ?? 'recording', 'Start recording', { action, kind }, async () => this.options.audio.transport('record', options)); } return jsonText(await this.options.audio.transport(action, options)); });
    server.registerTool('history_manage', { title: 'Manage actor history', description: 'Fairly schedules undo/redo for only this authenticated actor and returns commit/conflict, cancellation, or retryable backpressure; later work from other actors is preserved. History actions are not idempotent.', inputSchema: HistorySchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ action, projectId }) => {
      const actor = structuredClone(session.actor);
      const id = projectId ?? projects.getActiveProjectId();
      if (!id) return jsonText(action === 'undo' ? await projects.undo(undefined, actor) : await projects.redo(undefined, actor));
      const scheduled = await this.submitMutation(session, id, 1, () => action === 'undo' ? projects.undo(id, actor) : projects.redo(id, actor));
      if (!scheduled.accepted) {
        const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
        const next = { tool: 'project_observe', arguments: { projectId: id }, guidance: scheduled.code === 'cancelled'
          ? `No ${action} mutation started. Re-observe the project before deciding whether to issue a new history action.`
          : `Wait at least ${scheduled.retryAfterMs} ms, then re-observe the project before deciding whether to issue a new ${action}; history actions are not idempotent.` };
        if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, next);
        return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, next);
      }
      return jsonText(scheduled.result);
    });
    server.registerTool('trace_replay', { title: 'Replay durable transaction trace', description: 'Visualizes one selected durable transaction without applying operations. Returns a deterministic, credential-free receipt with source and canonical before/after hashes.', inputSchema: TraceReplaySchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ projectId, transactionId }) => {
      const before = projects.getProject(projectId);
      if (!before) return jsonText({ error: 'no_open_project', projectId });
      const entry = await projects.findTrace(projectId, transactionId);
      if (!entry?.transaction) return jsonText({ error: 'trace_transaction_not_found', projectId, transactionId }, { tool: 'aimuse_help', arguments: { topic: 'resources' }, guidance: `Read aimuse://projects/${projectId}/trace and retry with a transaction ID present in that durable trace.` });
      const replay = await projects.replayTrace(projectId, transactionId);
      if (!replay.replaying) return jsonText({ error: 'trace_replay_unavailable', projectId, transactionId, reason: replay.reason });
      const replayedEntry = await projects.findTrace(projectId, transactionId);
      if (!replayedEntry?.transaction || sha256Json(replayedEntry) !== sha256Json(entry)) return jsonText({ error: 'trace_changed_during_replay', projectId, transactionId });
      const after = projects.getProject(projectId);
      if (!after) return jsonText({ error: 'project_closed_during_trace_replay', projectId, transactionId });
      return jsonText(buildTraceReplayAudit(entry as ReplayableTraceEntry, before, after));
    });

    server.registerTool('media_manage', { title: 'Manage AIMuse media', description: 'List/import/analyze/render project media. WAV analysis uses fair bounded admission; audition/consolidation job creation shares it. Queued render cancellation creates no job or effects; an admitted job does not keep the lane occupied while render remains pending and uses cooperative owner-job cancellation with explicit retained-cache/commit results. Imports accept only authority-approved local paths; approved import cancellation is terminal and reports sequential per-file source/cache/transaction/warning effects without preemption or rollback. Inline bytes are never accepted.', inputSchema: MediaSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, async ({ action, projectId, paths, assetId, trackId, trackIds, startTick, endTick, placeAtTick }) => {
      const id = projectId ?? projects.getActiveProjectId();
      const project = id ? projects.getProject(id) : undefined;
      if (!id || !project) return jsonText({ error: 'no_open_project' });
      if (action === 'list') return jsonText(Object.values(project.assets));
      if (action === 'analyze' && assetId) return this.scheduleMediaAnalysis(session, id, (actor) => this.options.media.analyze(id, assetId, actor));
      if ((action === 'audition' || action === 'consolidate')) return this.scheduleMediaRender(session, id, action, (actor) => this.startAudition(id, actor, startTick, endTick, trackIds ?? (trackId ? [trackId] : undefined), action === 'consolidate', trackId, placeAtTick));
      if (action === 'import' && paths?.length) return this.multiFileAction(session, paths.map((path) => ({ path, mode: 'read' as const })), 'media', 'Import media', { action, paths: paths.map((path) => resolve(path)), projectId: id }, async (actor, observer) => this.options.media.importPaths(id, paths, actor, true, (effect) => observer?.({ producer: 'media-import', effect })), 'media-import');
      return jsonText({ error: 'invalid_arguments' });
    });

    server.registerTool('plugin_manage', { title: 'Manage VST3 and CLAP plug-ins', description: 'Catalog/scan or mutate plug-in devices with action-specific IDs. Parameter, preset, bypass, and remove use fair bounded project admission; queued cancellation invokes no project transaction. Scan returns a jobId whose terminal cancellation reports discovery/helper/candidate/catalog effects; partial candidate work is never published, but a complete replacement may settle late. Instantiate is allowlist-gated; its approved continuation has terminal cancellation and reports descriptor-device transaction effects without claiming native hosting.', inputSchema: PluginSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ action, projectId, roots, trackId, pluginId, deviceId, parameterId, value, presetName, bypassed }) => {
      if (action === 'catalog') return jsonText(this.options.plugins.list());
      if (action === 'scan') return jsonText(this.options.plugins.scan(roots, session.actor));
      const id = projectId ?? projects.getActiveProjectId();
      const project = id ? projects.getProject(id) : undefined;
      if (!id || !project) return jsonText({ error: 'no_open_project' });
      if (action === 'instantiate' && trackId && pluginId) {
        const decision = this.options.authority.plugin(pluginId);
        if (!decision.allowed) return this.queueApproval(session, 'plugin-host', decision.approvalKind ?? 'plugin', 'Instantiate plug-in', { action, projectId: id, trackId, pluginId }, async (actor) => this.options.plugins.instantiate(id, trackId, pluginId, actor, true), structuredClone(session.actor), 'plugin-instantiate');
        return jsonText(await this.options.plugins.instantiate(id, trackId, pluginId, session.actor));
      }
      if (!deviceId || !project.devices[deviceId]) return jsonText({ error: 'device_not_found' });
      let operation: ProjectOperation;
      if (action === 'set-parameter' && parameterId && value !== undefined) operation = { kind: 'device.parameter.set', deviceId, parameterId, value, expectedRevision: project.devices[deviceId].revision };
      else if (action === 'set-preset' && presetName) operation = { kind: 'device.update', deviceId, changes: { presetName }, expectedRevision: project.devices[deviceId].revision };
      else if (action === 'bypass') operation = { kind: 'device.update', deviceId, changes: { bypassed: bypassed ?? true }, expectedRevision: project.devices[deviceId].revision };
      else if (action === 'remove') operation = { kind: 'device.delete', deviceId, expectedRevision: project.devices[deviceId].revision };
      else return jsonText({ error: 'invalid_arguments' });
      const deviceName = project.devices[deviceId].name;
      return this.schedulePluginDeviceMutation(session, id, action, (actor) => projects.apply({ id: createId('tx'), clientOperationId: createId('plugin-operation'), projectId: id, actor, label: `${action}: ${deviceName}`, createdAt: nowIso(), operations: [operation], checkpointPolicy: 'none' }, actor));
    });

    server.registerTool('export_manage', { title: 'Export AIMuse project', description: 'Starts an owner-scoped export job. Destination authority and explicit overwrite rules apply; poll the returned jobId for terminal output. Running cancellation is terminal but cooperative: partial output or a pack save may remain, and AIMuse does not clean up or retry automatically. Concurrent approval-capable requests fail with approval_pending and create no job.', inputSchema: z.object({ projectId: ProjectIdField, kind: z.enum(['master', 'stems', 'midi', 'dawproject', 'sfx-batch', 'pack']).describe('Export artifact family.'), destination: z.string().min(1).describe('Exact local output path checked by file authority.'), format: z.enum(['wav', 'flac', 'mp3']).optional().describe('Requested audio codec; unsupported codecs fail rather than silently substituting WAV.'), startTick: z.number().int().nonnegative().optional(), endTick: z.number().int().positive().optional(), trackIds: z.array(z.string()).max(500).optional(), overwrite: z.boolean().default(false).describe('Explicit overwrite intent; authority policy still decides.') }).strict(), ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, async ({ projectId, ...request }) => { const id = projectId ?? projects.getActiveProjectId(); if (!id) return jsonText({ error: 'no_open_project' }); return this.startApprovalCapableJob(session, (reservationId) => this.options.exports.start({ projectId: id, ...request } as ExportRequest, session.actor, reservationId)); });

    server.registerTool('job_manage', { title: 'Manage AIMuse jobs', description: 'Owner-only list/inspect/bounded-wait/cancel/dependency. Foreign IDs equal missing IDs. Approval dependencies can only be resolved by a human in AIMuse.', inputSchema: JobSchema, ...TOOL_OUTPUT, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ action, jobId, timeoutMs }) => {
      if (action === 'list') return jsonText(projects.listJobs(session.actor.id).map(jobSummary));
      if (!jobId) return jsonText({ error: 'job_id_required' });
      let job = projects.getJob(jobId);
      if (!job || job.ownerActorId !== session.actor.id) return jsonText({ error: 'job_not_found' });
      const mediaRenderAction = job.kind === 'render' && typeof job.result === 'object' && job.result && 'action' in job.result && ['audition', 'consolidate'].includes(String((job.result as { action?: unknown }).action));
      if (action === 'cancel') {
        const pending = this.pending.get(jobId); if (exportJobRequest(job)) this.options.exports.cancel(jobId); else if (pending?.producer === 'project-save') this.cancelPendingProjectSave(jobId, pending); else if (pending?.producer === 'project-open') this.cancelPendingProjectOpen(jobId, pending); else if (pending?.producer === 'project-unpack') this.cancelPendingProjectUnpack(jobId, pending); else if (pending?.producer === 'plugin-instantiate') this.cancelPendingPluginInstantiate(jobId, pending); else if (pending?.producer === 'media-import') this.cancelPendingMediaImport(jobId, pending); else projects.cancelJob(jobId); job = projects.getJob(jobId) ?? job; this.pending.delete(jobId);
        if (mediaRenderAction && job.status === 'cancelled') return jsonText(jobSummary(job), { tool: 'job_manage', arguments: { action: 'inspect', jobId }, guidance: 'Cancellation is terminal for this owner job, but it does not preempt the running render or an already-started project transaction. Inspect the job again for its retained-effect result, then re-observe the project before deciding whether to repeat the render action.' });
      }
      if (action === 'wait' && (timeoutMs ?? 0) > 0) { const deadline = Date.now() + (timeoutMs ?? 0); while (!terminal(job.status) && job.status !== 'waiting-for-user' && Date.now() < deadline) { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); job = projects.getJob(jobId) ?? job; } }
      return jsonText(jobSummary(job));
    });
    return server;
  }

  private async fileAction(session: McpSession, path: string, mode: 'read' | 'write', kind: AsyncJob['kind'], summary: string, request: Record<string, unknown>, run: PendingRun, producer: PendingProducer = 'generic') { return this.multiFileAction(session, [{ path, mode }], kind, summary, request, run, producer); }
  private async submitMutation<T>(session: McpSession, projectId: Id, cost: number, run: () => Promise<T>): Promise<AgentMutationResult<T>> { const scheduled = await this.mutationScheduler.submit({ actorId: session.actor.id, projectId, cost, run, onStateChange: () => this.refreshMutationPresence(session) }); this.refreshMutationPresence(session); return scheduled; }
  private async scheduleProjectDomainMutation<T>(session: McpSession, projectId: Id, action: string, run: (actor: Actor) => Promise<T>) {
    const actor = structuredClone(session.actor);
    const scheduled = await this.submitMutation(session, projectId, 1, () => run(actor));
    if (scheduled.accepted) return jsonText(scheduled.result);
    const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
    const next = { tool: 'project_observe', arguments: { projectId }, guidance: scheduled.code === 'cancelled'
      ? `No ${action} started. Re-observe the project before deciding whether to issue another checkpoint/variant mutation.`
      : `Wait at least ${scheduled.retryAfterMs} ms, then re-observe the project before deciding whether to issue another ${action}; checkpoint/variant mutations are not idempotent.` };
    if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, next);
    return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, next);
  }
  private async schedulePluginDeviceMutation<T>(session: McpSession, projectId: Id, action: string, run: (actor: Actor) => Promise<T>) {
    const actor = structuredClone(session.actor);
    const scheduled = await this.submitMutation(session, projectId, 1, () => run(actor));
    if (scheduled.accepted) return jsonText(scheduled.result);
    const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
    const effect = `No plug-in ${action} project transaction started.`;
    const next = { tool: 'project_observe', arguments: { projectId }, guidance: scheduled.code === 'cancelled'
      ? `${effect} Re-observe the device and project before deciding whether to issue another plug-in device action.`
      : `${effect} Wait at least ${scheduled.retryAfterMs} ms, then re-observe the device and project before deciding whether to issue another plug-in device action; these actions are not idempotent.` };
    if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, next);
    return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, next);
  }
  private async scheduleMediaAnalysis<T>(session: McpSession, projectId: Id, run: (actor: Actor) => Promise<T>) {
    const actor = structuredClone(session.actor);
    const scheduled = await this.submitMutation(session, projectId, 1, () => run(actor));
    if (scheduled.accepted) return jsonText(scheduled.result);
    const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
    const effect = 'No media analysis source read, managed-cache output, or project transaction started.';
    const next = { tool: 'project_observe', arguments: { projectId }, guidance: scheduled.code === 'cancelled'
      ? `${effect} Re-observe the asset and project before deciding whether to analyze again.`
      : `${effect} Wait at least ${scheduled.retryAfterMs} ms, then re-observe the asset and project before deciding whether to analyze again; analysis is not idempotent.` };
    if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, next);
    return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, next);
  }
  private async scheduleMediaRender<T>(session: McpSession, projectId: Id, action: 'audition' | 'consolidate', run: (actor: Actor) => T | Promise<T>) {
    const actor = structuredClone(session.actor);
    const scheduled = await this.submitMutation(session, projectId, 1, () => Promise.resolve(run(actor)));
    if (scheduled.accepted) return jsonText(scheduled.result);
    const scheduler = { code: scheduled.code, actorQueueDepth: scheduled.queueDepth, globalQueueDepth: scheduled.globalQueueDepth };
    const effect = `No ${action} render job, cache output, or project transaction started.`;
    const next = { tool: 'project_observe', arguments: { projectId }, guidance: scheduled.code === 'cancelled'
      ? `${effect} Re-observe the project before deciding whether to start another media render.`
      : `${effect} Wait at least ${scheduled.retryAfterMs} ms, then re-observe the project before deciding whether to start another media render; render actions are not idempotent.` };
    if (scheduled.code === 'cancelled') return jsonText({ status: 'cancelled', message: scheduled.message, scheduler }, next);
    return jsonText({ status: 'busy', message: scheduled.message, conflict: { retryable: true, retryAfterMs: scheduled.retryAfterMs }, scheduler }, next);
  }
  private refreshMutationPresence(session: McpSession): void { const existing = this.options.projects.getMcpInfo().sessions.find((presence) => presence.actor.id === session.actor.id); if (!existing) return; const state = this.mutationScheduler.status().actors[session.actor.id]; this.options.projects.updatePresence({ ...existing, actor: structuredClone(session.actor), queueDepth: state?.queued ?? 0, status: state?.active ? 'working' : state?.queued ? 'waiting' : 'idle' }); }
  private async multiFileAction(session: McpSession, files: Array<{ path: string; mode: 'read' | 'write' }>, kind: AsyncJob['kind'], summary: string, request: Record<string, unknown>, run: PendingRun, producer: PendingProducer = 'generic') { const actor = structuredClone(session.actor); for (const file of files) { const target = resolve(file.path); const present = await stat(target).then(() => true, () => false); const decision = await this.options.authority.file(target, file.mode, present); if (!decision.allowed) return this.queueApproval(session, kind, decision.approvalKind ?? (file.mode === 'read' ? 'file-read' : 'file-write'), summary, request, run, actor, producer); } return jsonText(await run(actor)); }
  private approvalPending() { return jsonText({ error: 'approval_pending', message: 'Another approval-capable request is being prepared or awaits human review. No job was created.', retryable: true }, { guidance: 'Wait for the single visible approval request to be resolved or cancelled, then retry. AIMuse does not reveal another actor’s approval details.', humanRequired: true }); }
  private async startApprovalCapableJob(session: McpSession, start: (reservationId: Id) => { jobId: Id } | Promise<{ jobId: Id }>) { const reservation = this.options.projects.reserveApproval(session.actor.id); if (!reservation) return this.approvalPending(); try { return jsonText(await start(reservation.reservationId)); } catch (error) { this.options.projects.releaseApprovalReservation(reservation.reservationId); throw error; } }
  private queueApproval(session: McpSession, kind: AsyncJob['kind'], approvalKind: NonNullable<AsyncJob['approval']>['kind'], summary: string, request: Record<string, unknown>, run: PendingRun, authenticatedActor = structuredClone(session.actor), producer: PendingProducer = 'generic') {
    const reservation = this.options.projects.reserveApproval(authenticatedActor.id); if (!reservation) return this.approvalPending(); const timestamp = nowIso(); const job: AsyncJob = { id: createId('approval-job'), ownerActorId: authenticatedActor.id, projectId: typeof request.projectId === 'string' ? request.projectId : undefined, kind, status: 'waiting-for-user', progress: 0, message: `${summary} is waiting for in-app approval.`, createdAt: timestamp, updatedAt: timestamp, cancellable: true, approval: { kind: approvalKind, summary, request, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, result: { request } }; if (!this.options.projects.bindApprovalReservation(reservation.reservationId, job.id, authenticatedActor.id)) { this.options.projects.releaseApprovalReservation(reservation.reservationId); return this.approvalPending(); }
    const actor = structuredClone(authenticatedActor);
    if (producer === 'generic') this.pending.set(job.id, { producer, actor, run });
    else if (producer === 'project-unpack') this.pending.set(job.id, { producer, phase: 'waiting', actor, run, partial: initialApprovedProjectUnpackPartial() });
    else if (producer === 'media-import') { const paths = Array.isArray(request.paths) ? request.paths : []; this.pending.set(job.id, { producer, phase: 'waiting', actor, run, partial: initialApprovedMediaImportPartial(paths.length) }); }
    else this.pending.set(job.id, { producer, phase: 'waiting', actor, run });
    this.options.projects.upsertJob(job); return jsonText({ jobId: job.id, status: job.status, dependency: { type: 'user-approval', approval: job.approval } }, { tool: 'job_manage', arguments: { action: 'wait', jobId: job.id, timeoutMs: 0 }, guidance: 'A human must approve or deny this request in AIMuse. This agent may only poll its owned job.', humanRequired: true });
  }

  private async runPending(job: AsyncJob, pending: PendingAction): Promise<void> { if (pending.producer === 'project-save') return this.runPendingProjectSave(job, pending); if (pending.producer === 'project-open') return this.runPendingProjectOpen(job, pending); if (pending.producer === 'project-unpack') return this.runPendingProjectUnpack(job, pending); if (pending.producer === 'plugin-instantiate') return this.runPendingPluginInstantiate(job, pending); if (pending.producer === 'media-import') return this.runPendingMediaImport(job, pending); return this.runPendingGeneric(job, pending); }

  private async runPendingGeneric(job: AsyncJob, pending: GenericPendingAction): Promise<void> { this.options.projects.upsertJob({ ...job, status: 'running', progress: 0.1, message: 'Running approved action…', approval: undefined, updatedAt: nowIso() }); try { const output = await pending.run(structuredClone(pending.actor)); this.options.projects.upsertJob({ ...job, status: 'completed', progress: 1, message: 'Approved action completed.', approval: undefined, updatedAt: nowIso(), result: { ...(typeof job.result === 'object' && job.result ? job.result : {}), output } }); } catch (error) { this.options.projects.upsertJob({ ...job, status: 'failed', message: error instanceof Error ? error.message : String(error), approval: undefined, updatedAt: nowIso(), error: { code: 'approved-action-failed', message: error instanceof Error ? error.message : String(error), retryable: false } }); } finally { this.pending.delete(job.id); } }

  private updatePendingMediaImportEffect(jobId: Id, pending: PendingMediaImportAction, effect: MediaImportFileEffect): void {
    if (!Number.isInteger(effect.index) || effect.index < 0 || effect.index >= pending.partial.files.length) return;
    pending.partial.files[effect.index] = structuredClone(effect);
    const current = this.options.projects.getJob(jobId); if (!current || current.status !== 'cancelled') return;
    const result = typeof current.result === 'object' && current.result ? current.result as Record<string, unknown> : {};
    const next: AsyncJob = { ...current, cancellable: false, message: 'Approved media-import cancellation remains terminal while its sequential continuation settles. Per-file cache, project and warning effects may continue to become more precise; no cleanup or retry was attempted.', updatedAt: nowIso(), result: { ...result, partial: structuredClone(pending.partial) } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
  }

  private cancelPendingMediaImport(jobId: Id, pending: PendingMediaImportAction): AsyncJob | undefined {
    const current = this.options.projects.getJob(jobId); if (!current || terminal(current.status)) return current; const executionStarted = pending.phase === 'running'; const cancelled = this.options.projects.cancelJob(jobId); if (!cancelled || cancelled.status !== 'cancelled') return cancelled;
    const result = typeof cancelled.result === 'object' && cancelled.result ? cancelled.result as Record<string, unknown> : {}; const next: AsyncJob = { ...cancelled, cancellable: false, message: executionStarted ? 'Approved media-import cancellation is terminal. It does not preempt the current file, roll back earlier files, clean cache output, or retry the sequential continuation.' : 'Approved media import cancelled before authority continuation, source-read, cache-copy, project-transaction, or warning effects.', result: { ...result, partial: structuredClone(pending.partial) } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return next;
  }

  private async runPendingMediaImport(job: AsyncJob, pending: PendingMediaImportAction): Promise<void> {
    const current = this.options.projects.getJob(job.id); if (!current || terminal(current.status)) { this.pending.delete(job.id); return; }
    const running: AsyncJob = { ...current, status: 'running', progress: 0.1, message: 'Running approved media import sequentially…', updatedAt: nowIso() }; delete running.approval; delete running.error; this.options.projects.upsertJob(running);
    const runnable = this.options.projects.getJob(job.id); if (!runnable || runnable.status === 'cancelled') { this.pending.delete(job.id); return; } pending.phase = 'running'; pending.partial.continuation = 'running';
    try {
      const output = await pending.run(structuredClone(pending.actor), (progress) => { if (progress.producer === 'media-import') this.updatePendingMediaImportEffect(job.id, pending, progress.effect); }); pending.partial.continuation = 'fulfilled';
      const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial = structuredClone(pending.partial);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, progress: 1, message: 'Approved media-import cancellation remained terminal after the sequential continuation settled. Reported per-file cache outputs, committed transactions, source registrations and warnings remain; no cleanup, rollback or retry was attempted.', updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'completed', cancellable: false, progress: 1, message: 'Approved media import completed sequentially.', updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
    } catch (error) {
      pending.partial.continuation = 'rejected'; const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial = structuredClone(pending.partial); const message = error instanceof Error ? error.message : String(error);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, message: 'Approved media-import cancellation remained terminal after the continuation rejected. Reported per-file effects remain and any in-flight cache or project effect stays conservative; no cleanup, rollback or retry was attempted.', updatedAt: nowIso(), result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...result, partial }, error: { code: 'approved-media-import-failed', message, retryable: false } }; delete next.approval; this.options.projects.upsertJob(next);
    } finally { this.pending.delete(job.id); }
  }

  private updatePendingProjectUnpackEffect(jobId: Id, pending: PendingProjectUnpackAction, effect: ApprovedProjectUnpackProgress): void {
    if (effect.phase === 'archive-read') pending.partial.archiveRead = effect.state === 'completed' ? 'completed' : 'reading';
    else if (effect.phase === 'destination') {
      if (effect.state === 'root-created') pending.partial.destination = 'root-created';
      else if (effect.state === 'cleanup-started') { pending.partial.cleanup = 'running'; delete pending.partial.entries.active; if (pending.partial.entries.discovered) pending.partial.destination = 'may-be-partial'; }
      else if (effect.state === 'removed') { pending.partial.cleanup = 'completed'; pending.partial.destination = 'removed'; }
      else { pending.partial.cleanup = 'failed'; pending.partial.destination = pending.partial.entries.discovered ? 'may-be-partial' : 'root-created'; }
    } else if (effect.phase === 'entry') {
      pending.partial.entries.discovered = Math.max(pending.partial.entries.discovered, effect.index + 1);
      if (effect.state === 'started') {
        pending.partial.entries.active = { index: effect.index, entryType: effect.entryType };
        if (effect.entryType === 'file') pending.partial.entries.fileWritesStarted += 1;
        pending.partial.destination = 'may-be-partial';
      } else if (effect.state === 'completed') {
        if (effect.entryType === 'file') pending.partial.entries.filesWritten += 1; else pending.partial.entries.directoriesCreated += 1;
        if (pending.partial.entries.active?.index === effect.index) delete pending.partial.entries.active;
      }
    } else if (effect.phase === 'project-validation') {
      pending.partial.projectValidation = effect.state === 'completed' ? 'completed' : 'reading';
      if (effect.state === 'completed') pending.partial.destination = 'retained';
    } else {
      pending.partial.projectOpen = 'running'; pending.partial.workspaceIdentity = 'may-have-changed'; pending.partial.openedProject = 'may-have-opened'; pending.partial.audioController = 'may-have-synchronized';
    }
    const current = this.options.projects.getJob(jobId); if (!current || current.status !== 'cancelled') return;
    const result = typeof current.result === 'object' && current.result ? current.result as Record<string, unknown> : {};
    const next: AsyncJob = { ...current, cancellable: false, message: 'Approved project-unpack cancellation remains terminal while archive, destination, validation, and project-open effects settle. No preemption, rollback, cleanup guarantee, or retry is implied.', updatedAt: nowIso(), result: { ...result, partial: structuredClone(pending.partial) } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
  }

  private cancelPendingProjectUnpack(jobId: Id, pending: PendingProjectUnpackAction): AsyncJob | undefined {
    const current = this.options.projects.getJob(jobId); if (!current || terminal(current.status)) return current; const executionStarted = pending.phase === 'running'; const cancelled = this.options.projects.cancelJob(jobId); if (!cancelled || cancelled.status !== 'cancelled') return cancelled;
    const result = typeof cancelled.result === 'object' && cancelled.result ? cancelled.result as Record<string, unknown> : {}; const next: AsyncJob = { ...cancelled, cancellable: false, message: executionStarted ? 'Approved project-unpack cancellation is terminal. It does not preempt archive reading, the current destination write, validation, or an already-started project open; effects may continue to settle.' : 'Approved project unpack cancelled before archive, destination, validation, workspace, opened-project, or audio-controller effects.', result: { ...result, partial: structuredClone(pending.partial) } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return next;
  }

  private settlePendingProjectUnpackOpenFailure(job: AsyncJob, pending: PendingProjectUnpackAction): void {
    if (pending.partial.projectOpen !== 'running') return;
    pending.partial.projectOpen = 'rejected'; const request = approvedProjectUnpackRequest(job); if (!request) return;
    const project = this.options.projects.getProjects().find((candidate) => candidate.projectPath && resolve(candidate.projectPath) === resolve(request.destination));
    if (!project) return;
    pending.partial.workspaceIdentity = 'retained'; pending.partial.openedProject = 'retained'; pending.partial.audioController = 'may-have-synchronized';
  }

  private async runPendingProjectUnpack(job: AsyncJob, pending: PendingProjectUnpackAction): Promise<void> {
    const current = this.options.projects.getJob(job.id); if (!current || terminal(current.status)) { this.pending.delete(job.id); return; } const running: AsyncJob = { ...current, status: 'running', progress: 0.1, message: 'Running approved project unpack sequentially…', updatedAt: nowIso() }; delete running.approval; delete running.error; this.options.projects.upsertJob(running);
    const runnable = this.options.projects.getJob(job.id); if (!runnable || runnable.status === 'cancelled') { this.pending.delete(job.id); return; } pending.phase = 'running'; pending.partial.continuation = 'running'; pending.partial.archiveRead = 'reading';
    try {
      const output = await pending.run(structuredClone(pending.actor), (progress) => { if (progress.producer === 'project-unpack') this.updatePendingProjectUnpackEffect(job.id, pending, progress.effect); }); pending.partial.continuation = 'fulfilled'; pending.partial.projectOpen = 'fulfilled';
      const opened = typeof output === 'object' && output && Array.isArray((output as { opened?: unknown }).opened) ? (output as { opened: unknown[] }).opened : []; const openedProjectId = typeof opened.at(-1) === 'string' ? opened.at(-1) as string : undefined; const openedProject = openedProjectId ? this.options.projects.getProject(openedProjectId) : undefined; const transport = this.options.audio.snapshot(); const openEffects = completedProjectOpenEffects(output, Boolean(openedProject), Boolean(openedProject && transport.projectId === openedProject.id && transport.graphRevision === openedProject.revision)); pending.partial.workspaceIdentity = openEffects.workspaceIdentity; pending.partial.openedProject = openEffects.openedProject; pending.partial.audioController = openEffects.audioController;
      const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial = structuredClone(pending.partial);
      if (settled.status === 'cancelled') { const message = partial.workspaceIdentity === 'retained' && partial.audioController === 'synchronized' ? 'Approved project-unpack cancellation remained terminal after extraction and open completed. Destination output and the synchronized opened project remain.' : partial.workspaceIdentity === 'unchanged' ? 'Approved project-unpack cancellation remained terminal after extraction completed and project open returned without retaining a project. Extracted destination output remains.' : 'Approved project-unpack cancellation remained terminal after the compound continuation returned with uncertain open effects. Extracted destination output remains.'; const next: AsyncJob = { ...settled, cancellable: false, progress: 1, message, updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'completed', cancellable: false, progress: 1, message: 'Approved project unpack and open completed.', updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
    } catch (error) {
      pending.partial.continuation = 'rejected'; this.settlePendingProjectUnpackOpenFailure(job, pending); const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial = structuredClone(pending.partial); const message = error instanceof Error ? error.message : String(error);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, message: 'Approved project-unpack cancellation remained terminal after the compound continuation rejected. Reported destination and open effects remain; no rollback, cleanup guarantee, or retry was applied.', updatedAt: nowIso(), result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...result, partial }, error: { code: 'approved-project-unpack-failed', message, retryable: false } }; delete next.approval; this.options.projects.upsertJob(next);
    } finally { this.pending.delete(job.id); }
  }

  private cancelPendingProjectOpen(jobId: Id, pending: PendingProjectOpenAction): AsyncJob | undefined {
    const current = this.options.projects.getJob(jobId); if (!current || terminal(current.status)) return current; const executionStarted = pending.phase === 'running'; const cancelled = this.options.projects.cancelJob(jobId); if (!cancelled || cancelled.status !== 'cancelled') return cancelled;
    const partial: ApprovedProjectOpenPartialEffects = executionStarted
      ? { sourceRead: 'may-have-completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' }
      : { sourceRead: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' };
    const result = typeof cancelled.result === 'object' && cancelled.result ? cancelled.result as Record<string, unknown> : {}; const next: AsyncJob = { ...cancelled, cancellable: false, message: executionStarted ? 'Approved project-open cancellation is terminal. The running source read, workspace update, and audio-controller synchronization were not preempted or retried.' : 'Approved project open cancelled before source-read, workspace, opened-project, or audio-controller effects.', result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return next;
  }

  private async runPendingProjectOpen(job: AsyncJob, pending: PendingProjectOpenAction): Promise<void> {
    const current = this.options.projects.getJob(job.id); if (!current || terminal(current.status)) { this.pending.delete(job.id); return; } const running: AsyncJob = { ...current, status: 'running', progress: 0.1, message: 'Running approved project open…', updatedAt: nowIso() }; delete running.approval; delete running.error; this.options.projects.upsertJob(running);
    const runnable = this.options.projects.getJob(job.id); if (!runnable || runnable.status === 'cancelled') { this.pending.delete(job.id); return; } pending.phase = 'running';
    try {
      const output = await pending.run(structuredClone(pending.actor)); const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {};
      if (settled.status === 'cancelled') { const opened = typeof output === 'object' && output && Array.isArray((output as { opened?: unknown }).opened) ? (output as { opened: unknown[] }).opened : []; const openedProjectId = typeof opened.at(-1) === 'string' ? opened.at(-1) as string : undefined; const openedProject = openedProjectId ? this.options.projects.getProject(openedProjectId) : undefined; const transport = this.options.audio.snapshot(); const partial = completedProjectOpenEffects(output, Boolean(openedProject), Boolean(openedProject && transport.projectId === openedProject.id && transport.graphRevision === openedProject.revision)); const message = partial.workspaceIdentity === 'retained' && partial.audioController === 'synchronized' ? 'Approved project-open cancellation remained terminal after open completed. Settlement-time workspace and audio-controller state confirm the opened project remains synchronized.' : partial.workspaceIdentity === 'unchanged' ? 'Approved project-open cancellation remained terminal after the read finished without opening a project. Workspace identity and audio-controller state are unchanged.' : 'Approved project-open cancellation remained terminal after open returned with uncertain workspace and audio-controller effects.'; const next: AsyncJob = { ...settled, cancellable: false, progress: 1, message, updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'completed', cancellable: false, progress: 1, message: 'Approved project open completed.', updatedAt: nowIso(), result: { ...result, output } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
    } catch (error) {
      const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial: ApprovedProjectOpenPartialEffects = { sourceRead: 'may-have-completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' }; const message = error instanceof Error ? error.message : String(error);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, message: 'Approved project-open cancellation remained terminal after open failed. Source-read, workspace/opened-project, and audio-controller effects remain uncertain. No automatic rollback or retry was attempted.', updatedAt: nowIso(), result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...result, partial }, error: { code: 'approved-project-open-failed', message, retryable: false } }; delete next.approval; this.options.projects.upsertJob(next);
    } finally { this.pending.delete(job.id); }
  }

  private cancelPendingProjectSave(jobId: Id, pending: PendingProjectSaveAction): AsyncJob | undefined {
    const current = this.options.projects.getJob(jobId); if (!current || terminal(current.status)) return current; const executionStarted = pending.phase === 'running'; const cancelled = this.options.projects.cancelJob(jobId); if (!cancelled || cancelled.status !== 'cancelled') return cancelled;
    const partial: ApprovedProjectSavePartialEffects = executionStarted
      ? { destination: 'may-be-partial', project: 'save-may-have-completed', audit: 'may-have-been-recorded' }
      : { destination: 'unchanged', project: 'unchanged', audit: 'unchanged' };
    const result = typeof cancelled.result === 'object' && cancelled.result ? cancelled.result as Record<string, unknown> : {}; const next: AsyncJob = { ...cancelled, cancellable: false, message: executionStarted ? 'Approved project-save cancellation is terminal. The running save was not preempted, cleaned up, or retried automatically.' : 'Approved project save cancelled before destination, project, or file-audit effects.', result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return next;
  }

  private async runPendingProjectSave(job: AsyncJob, pending: PendingProjectSaveAction): Promise<void> {
    const current = this.options.projects.getJob(job.id); if (!current || terminal(current.status)) { this.pending.delete(job.id); return; } const running: AsyncJob = { ...current, status: 'running', progress: 0.1, message: 'Running approved project save…', updatedAt: nowIso() }; delete running.approval; delete running.error; this.options.projects.upsertJob(running);
    const runnable = this.options.projects.getJob(job.id); if (!runnable || runnable.status === 'cancelled') { this.pending.delete(job.id); return; } pending.phase = 'running';
    try {
      const output = await pending.run(structuredClone(pending.actor)); const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {};
      if (settled.status === 'cancelled') { const partial: ApprovedProjectSavePartialEffects = { destination: 'retained', project: 'saved', audit: 'recorded' }; const next: AsyncJob = { ...settled, cancellable: false, progress: 1, message: 'Approved project-save cancellation remained terminal after the save completed. Destination output, project clean state, and file.saved audit remain.', updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'completed', cancellable: false, progress: 1, message: 'Approved project save completed.', updatedAt: nowIso(), result: { ...result, output } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
    } catch (error) {
      const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial: ApprovedProjectSavePartialEffects = { destination: 'may-be-partial', project: 'save-may-have-completed', audit: 'may-have-been-recorded' }; const message = error instanceof Error ? error.message : String(error);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, message: 'Approved project-save cancellation remained terminal after the save failed. Destination output may be partial; project clean-state publication and file-audit recording remain uncertain. No automatic cleanup or retry was attempted.', updatedAt: nowIso(), result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...result, partial }, error: { code: 'approved-project-save-failed', message, retryable: false } }; delete next.approval; this.options.projects.upsertJob(next);
    } finally { this.pending.delete(job.id); }
  }

  private cancelPendingPluginInstantiate(jobId: Id, pending: PendingPluginInstantiateAction): AsyncJob | undefined {
    const current = this.options.projects.getJob(jobId); if (!current || terminal(current.status)) return current; const executionStarted = pending.phase === 'running'; const cancelled = this.options.projects.cancelJob(jobId); if (!cancelled || cancelled.status !== 'cancelled') return cancelled;
    const partial: ApprovedPluginInstantiatePartialEffects = executionStarted
      ? { projectTransaction: 'may-have-committed', device: 'may-have-been-added' }
      : { projectTransaction: 'not-started', device: 'unchanged' };
    const result = typeof cancelled.result === 'object' && cancelled.result ? cancelled.result as Record<string, unknown> : {}; const next: AsyncJob = { ...cancelled, cancellable: false, message: executionStarted ? 'Approved plug-in instantiate cancellation is terminal. The running descriptor-device transaction was not preempted or retried.' : 'Approved plug-in instantiate cancelled before its authority continuation or project transaction.', result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return next;
  }

  private async runPendingPluginInstantiate(job: AsyncJob, pending: PendingPluginInstantiateAction): Promise<void> {
    const current = this.options.projects.getJob(job.id); if (!current || terminal(current.status)) { this.pending.delete(job.id); return; } const running: AsyncJob = { ...current, status: 'running', progress: 0.1, message: 'Running approved plug-in instantiate transaction…', updatedAt: nowIso() }; delete running.approval; delete running.error; this.options.projects.upsertJob(running);
    const runnable = this.options.projects.getJob(job.id); if (!runnable || runnable.status === 'cancelled') { this.pending.delete(job.id); return; } pending.phase = 'running';
    try {
      const output = await pending.run(structuredClone(pending.actor)); const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const request = approvedPluginInstantiateRequest(settled) ?? approvedPluginInstantiateRequest(job); const record = typeof output === 'object' && output ? output as { status?: unknown; deviceId?: unknown } : undefined; const committed = record?.status === 'committed' && typeof record.deviceId === 'string'; const confirmedNoCommit = record?.status === 'locked' || record?.status === 'conflict' || record?.status === 'approval-required'; const retained = Boolean(committed && request && this.options.projects.getProject(request.projectId)?.devices[record.deviceId as string]?.trackId === request.trackId && this.options.projects.getProject(request.projectId)?.devices[record.deviceId as string]?.pluginId === request.pluginId); const partial: ApprovedPluginInstantiatePartialEffects = committed
        ? { projectTransaction: 'committed', device: retained ? 'retained' : 'may-have-been-added' }
        : confirmedNoCommit
          ? { projectTransaction: 'not-committed', device: 'unchanged' }
          : { projectTransaction: 'may-have-committed', device: 'may-have-been-added' };
      if (settled.status === 'cancelled') { const message = partial.projectTransaction === 'committed' && partial.device === 'retained' ? 'Approved plug-in instantiate cancellation remained terminal after the descriptor-device transaction committed. The device remains in the project.' : partial.projectTransaction === 'not-committed' ? 'Approved plug-in instantiate cancellation remained terminal after the continuation settled without committing a device.' : 'Approved plug-in instantiate cancellation remained terminal after the continuation returned with uncertain descriptor-device effects.'; const next: AsyncJob = { ...settled, cancellable: false, progress: 1, message, updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const message = partial.projectTransaction === 'committed' && partial.device === 'retained' ? 'Approved plug-in instantiate transaction committed.' : partial.projectTransaction === 'not-committed' ? 'Approved plug-in instantiate continuation settled without committing a device.' : 'Approved plug-in instantiate continuation returned with uncertain descriptor-device effects.'; const next: AsyncJob = { ...settled, status: 'completed', cancellable: false, progress: 1, message, updatedAt: nowIso(), result: { ...result, output, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next);
    } catch (error) {
      const settled = this.options.projects.getJob(job.id); if (!settled) return; const result = typeof settled.result === 'object' && settled.result ? settled.result as Record<string, unknown> : {}; const partial: ApprovedPluginInstantiatePartialEffects = { projectTransaction: 'may-have-committed', device: 'may-have-been-added' }; const message = error instanceof Error ? error.message : String(error);
      if (settled.status === 'cancelled') { const next: AsyncJob = { ...settled, cancellable: false, message: 'Approved plug-in instantiate cancellation remained terminal after the continuation failed. Descriptor-device effects remain uncertain, and no automatic retry was attempted.', updatedAt: nowIso(), result: { ...result, partial } }; delete next.approval; delete next.error; this.options.projects.upsertJob(next); return; }
      if (settled.status !== 'running') return; const next: AsyncJob = { ...settled, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...result, partial }, error: { code: 'approved-plugin-instantiate-failed', message, retryable: false } }; delete next.approval; this.options.projects.upsertJob(next);
    } finally { this.pending.delete(job.id); }
  }

  private startAudition(projectId: Id, actor: Actor, startTick?: number, endTick?: number, trackIds?: Id[], consolidate = false, trackId?: Id, placeAtTick?: number): { jobId: Id } {
    const jobId = createId(consolidate ? 'consolidate-job' : 'audition-job'); const timestamp = nowIso();
    this.options.projects.upsertJob({ id: jobId, ownerActorId: actor.id, projectId, kind: 'render', status: 'queued', progress: 0, message: consolidate ? 'Consolidation queued.' : 'Audition render queued.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, result: { action: consolidate ? 'consolidate' : 'audition' } });
    let cacheCompleted = false; let asset: MediaAsset | undefined; let assetCommitted = false; let clipId: Id | undefined; let warnings: string[] = [];
    const effectResult = () => ({
      ...(assetCommitted && asset ? { assetId: asset.id, resource: `aimuse://projects/${projectId}/media/${asset.id}` } : {}),
      ...(clipId ? { clipId } : {}),
      warnings,
      partial: {
        cache: cacheCompleted ? 'retained' : 'may-be-partial',
        project: clipId ? 'asset-and-clip-committed' : assetCommitted ? 'asset-committed' : 'unchanged',
      },
    });
    const retainCancellation = (): boolean => {
      const current = this.options.projects.getJob(jobId); if (current?.status !== 'cancelled') return false;
      const effects = effectResult();
      const message = clipId
        ? 'Cancelled after the consolidation clip transaction started. The managed render, asset and committed clip remain.'
        : assetCommitted
          ? 'Cancelled after the render-asset transaction started. The managed render and committed asset remain; no later clip transaction started.'
          : cacheCompleted
            ? 'Cancelled while rendering. The completed managed-cache output remains; no project transaction started.'
            : 'Cancelled while rendering. A partial managed-cache output may remain; no project transaction started.';
      this.options.projects.upsertJob({ ...current, cancellable: false, message, updatedAt: nowIso(), result: { ...(typeof current.result === 'object' && current.result ? current.result : {}), ...effects } });
      return true;
    };
    void (async () => {
      try {
        const project = this.options.projects.getProject(projectId); if (!project) throw new Error('Project is not open.');
        const path = join(this.options.cacheRoot, 'auditions', `${jobId}.wav`);
        this.options.projects.upsertJob({ ...this.options.projects.getJob(jobId)!, status: 'running', progress: 0.1, message: 'Rendering auditory observation…', updatedAt: nowIso() });
        const rendered = await this.options.audio.render(project, path, startTick, endTick, trackIds);
        cacheCompleted = true; warnings = rendered.warnings;
        if (retainCancellation()) return;
        const hashed = await sha256File(path);
        if (retainCancellation()) return;
        asset = { ...entityBase('asset', actor), kind: consolidate ? 'audio' : 'audition', name: `${consolidate ? 'Consolidated' : 'Audition'} ${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, mimeType: 'audio/wav', sha256: hashed.sha256, byteLength: hashed.byteLength, storage: 'managed-cache', externalPath: path, sampleRate: project.settings.sampleRate, channels: 2, durationSamples: rendered.durationSamples, source: 'render' };
        const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('render-asset'), projectId, actor, label: consolidate ? 'Consolidate audio' : 'Create audition render', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }], checkpointPolicy: 'none' };
        const result = await this.options.projects.apply(tx, actor); if (result.status !== 'committed') throw new Error(result.message ?? 'Render asset could not be registered.');
        assetCommitted = true; this.options.projects.registerAssetSource(asset.id, path);
        if (retainCancellation()) return;
        if (consolidate && trackId) { const clip = await this.options.media.createAudioClip(projectId, asset.id, trackId, placeAtTick ?? startTick ?? 0, actor); clipId = clip.id; }
        if (retainCancellation()) return;
        this.options.projects.upsertJob({ ...this.options.projects.getJob(jobId)!, status: 'completed', progress: 1, message: consolidate ? 'Consolidated audio is in the arrangement.' : 'Audition render is ready.', updatedAt: nowIso(), cancellable: false, result: { action: consolidate ? 'consolidate' : 'audition', assetId: asset.id, resource: `aimuse://projects/${projectId}/media/${asset.id}`, ...(clipId ? { clipId } : {}), warnings } });
      } catch (error) {
        if (retainCancellation()) return;
        const current = this.options.projects.getJob(jobId); if (!current) return;
        const message = error instanceof Error ? error.message : String(error);
        this.options.projects.upsertJob({ ...current, status: 'failed', message, updatedAt: nowIso(), cancellable: false, result: { ...(typeof current.result === 'object' && current.result ? current.result : {}), ...effectResult() }, error: { code: error instanceof UnsupportedAudioRenderError ? error.code : 'audition-render-failed', message, retryable: !(error instanceof UnsupportedAudioRenderError) } });
      }
    })();
    return { jobId };
  }
  private async notifyProject(projectId: Id, revision: number): Promise<void> { const uris = [`aimuse://projects/${projectId}/manifest`, `aimuse://projects/${projectId}/snapshot`, `aimuse://projects/${projectId}/changes/${Math.max(0, revision - 1)}`]; for (const session of this.sessions.values()) await Promise.allSettled(uris.filter((uri) => session.resourceSubscriptions.has(uri)).map((uri) => session.mcp.server.sendResourceUpdated({ uri }))); }
  private async readPreferredPort(): Promise<number> { try { const value = JSON.parse(await readFile(this.options.portSettingsPath, 'utf8')) as PortFile; return value.version === 1 ? value.preferredPort : PORT_START; } catch { return PORT_START; } }
}
