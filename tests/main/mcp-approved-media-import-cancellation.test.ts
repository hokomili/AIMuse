import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  type Actor, type AsyncJob, type AuthorityPolicy, type ProjectTransaction,
} from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
import { GenerationManager, type ProviderCredentials } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { McpHost } from '../../src/main/mcp-host';
import { MediaManager } from '../../src/main/media-manager';
import { PluginManager } from '../../src/main/plugin-manager';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

interface RpcResultMessage {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

interface TestClient {
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

describe('headless authenticated approved media-import terminality', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let media: MediaManager;
  let host: McpHost;
  let url: string;
  let makeCacheDirectory: (path: string) => Promise<void>;
  let copyToCache: (source: string, destination: string) => Promise<void>;
  const token = 'approved-media-import-token';
  const clients: TestClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-approved-media-import-'));
    audio = new AudioEngineController(); audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager(); makeCacheDirectory = async (path) => { await mkdir(path, { recursive: true }); }; copyToCache = (source, destination) => copyFile(source, destination);
    media = new MediaManager(join(root, 'managed'), projects, authority, { importRuntime: { makeCacheDirectory: (path) => makeCacheDirectory(path), copyToCache: (source, destination) => copyToCache(source, destination) } });
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const credentials: ProviderCredentials = {
      get: async () => undefined,
      set: async () => undefined,
      status: async () => ({ elevenlabs: false, stability: false, lyria: false }),
    };
    const generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '9'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'),
      projects, audio, authority, media, plugins, generation, exports,
    });
    await projects.initialize(); await plugins.initialize(); url = (await host.start(token)).url;
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await host.stop(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks();
  });

  async function createClient(name: string): Promise<TestClient> {
    let requestId = 0;
    const request = async (body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcResultMessage }> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!text) return { response };
      if (!response.headers.get('content-type')?.includes('text/event-stream')) return { response, message: JSON.parse(text) as RpcResultMessage };
      const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as RpcResultMessage);
      return { response, message: messages.at(-1) };
    };
    const initialized = await request({
      jsonrpc: '2.0', id: ++requestId, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: '1' } },
    });
    expect(initialized.response.status).toBe(200); expect(initialized.message?.error).toBeUndefined();
    const sessionId = initialized.response.headers.get('mcp-session-id'); expect(sessionId).toBeTruthy();
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
    const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const response = await request({ jsonrpc: '2.0', id: ++requestId, method, params }, sessionId!);
      expect(response.response.status).toBe(200); expect(response.message?.error).toBeUndefined(); return response.message?.result as T;
    };
    const client: TestClient = {
      rpc,
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc<ToolCallResult>('tools/call', { name: toolName, arguments: args });
        expect(result.isError).not.toBe(true); expect(result.content).toHaveLength(1); return JSON.parse(result.content[0].text!) as T;
      },
      close: async () => { await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! } }); },
    };
    clients.push(client); return client;
  }

  async function waitForJob(jobId: string, predicate: (job: AsyncJob) => boolean): Promise<AsyncJob> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = projects.getJob(jobId); if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for approved media-import job ${jobId}.`);
  }

  async function source(name: string, value = name): Promise<string> {
    const path = join(root, name); await writeFile(path, Buffer.from(`RIFF-${value}`)); return path;
  }

  function managedPath(value: string): string {
    return join(root, 'managed', 'media', createHash('sha256').update(Buffer.from(`RIFF-${value}`)).digest('hex'));
  }

  async function installReadAuthority(): Promise<void> {
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'approved-media-import-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      budget: { currency: 'USD', maxSpendMinor: 0, maxGenerationRequests: 0, maxUnknownCostRequests: 0 }, providers: {}, readRoots: [root], writeRoots: [], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
  }

  it('cancels while waiting before file effects, preserves privacy and gate reuse, and leaves direct authorized import synchronous', async () => {
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Approved media import owner'); const foreign = await createClient('Approved media import foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Approved Media Import Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Approved Media Import Foreign' });
    const listed = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'media_manage')?.description).toContain('approved import cancellation');
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Approved media import cancellation is terminal');
    const first = await source('waiting-first.wav'); const second = await source('waiting-second.wav'); const project = projects.getActiveProject()!; const before = projects.getProject(project.id)!;
    const importPaths = vi.spyOn(media, 'importPaths');
    const queued = await owner.callTool<{ jobId: string; status: string }>('media_manage', { action: 'import', projectId: project.id, paths: [first, second] });
    expect(queued).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: joined.actor.id, kind: 'media', approval: { kind: 'file-read', request: { action: 'import', projectId: project.id, paths: [first, second] } } });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: {
        partial: {
          continuation: 'not-started', requestedFiles: 2,
          files: [
            { index: 0, outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' },
            { index: 1, outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' },
          ],
        },
      },
      next: { guidance: expect.stringContaining('before its authority continuation') },
    });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'cancelled' }); expect(importPaths).not.toHaveBeenCalled(); expect(projects.getProject(project.id)).toEqual(before);
    await expect(stat(join(root, 'managed', 'media'))).rejects.toThrow();

    const reused = await foreign.callTool<{ jobId: string; status: string }>('media_manage', { action: 'import', projectId: project.id, paths: [first] });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId });

    await installReadAuthority(); const jobCount = projects.listJobs().length;
    const direct = await owner.callTool<{ imported: Array<{ asset: { id: string; createdBy: string } }>; warnings: string[] }>('media_manage', { action: 'import', projectId: project.id, paths: [first] });
    expect(direct).toMatchObject({ imported: [{ asset: { id: expect.stringMatching(/^asset_/), createdBy: joined.actor.id } }], warnings: [] });
    expect(projects.listJobs()).toHaveLength(jobCount); expect(importPaths).toHaveBeenCalledTimes(1); expect(projects.getProject(project.id)!.assets[direct.imported[0].asset.id]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id });
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps cancellation terminal through a late cache copy, asset commit and source registration', async () => {
    const owner = await createClient('Late media copy owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Late Media Copy Owner' });
    const path = await source('late-copy.wav'); const project = projects.getActiveProject()!; const before = projects.getProject(project.id)!;
    const copyStarted = deferred(); const releaseCopy = deferred(); let copies = 0;
    copyToCache = async (sourcePath, destination) => { copies += 1; copyStarted.resolve(); await releaseCopy.promise; await copyFile(sourcePath, destination); };
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('media_manage', { action: 'import', projectId: project.id, paths: [path] });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await copyStarted.promise; await waitForJob(queued.jobId, (job) => job.status === 'running');
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { continuation: 'running', files: [{ outcome: 'running', sourceRead: 'completed', cache: 'may-be-partial', projectTransaction: 'unchanged', assetSource: 'unchanged' }] } },
      next: { guidance: expect.stringContaining('does not preempt the current approved media-import file') },
    });
    expect(projects.getProject(project.id)).toEqual(before); releaseCopy.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'fulfilled');
    expect(retained).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', progress: 1, cancellable: false,
      result: {
        output: { imported: [{ asset: { id: expect.stringMatching(/^asset_/), createdBy: joined.actor.id }, managedPath: managedPath('late-copy.wav') }], warnings: [] },
        partial: { continuation: 'fulfilled', requestedFiles: 1, files: [{ outcome: 'imported', sourceRead: 'completed', cache: 'retained', projectTransaction: 'committed', assetSource: 'registered', assetId: expect.stringMatching(/^asset_/) }] },
      },
    });
    expect(retained).not.toHaveProperty('approval'); expect(retained).not.toHaveProperty('error');
    const imported = (retained.result as { output: { imported: Array<{ asset: { id: string } }> } }).output.imported[0].asset; const after = projects.getProject(project.id)!;
    expect(after).toMatchObject({ revision: before.revision + 1 }); expect(after.assets[imported.id]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id, externalPath: managedPath('late-copy.wav') });
    expect(after.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id, kind: 'agent' }, label: 'Import late-copy.wav', status: 'committed' });
    expect(projects.getAssetSource(project.id, imported.id)).toBe(managedPath('late-copy.wav')); expect(await readFile(managedPath('late-copy.wav'), 'utf8')).toBe('RIFF-late-copy.wav');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({ status: 'cancelled', next: { tool: 'project_observe', guidance: expect.stringMatching(/not rolled back or cleaned up.*did not retry/) } });
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('completed');
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('failed');
    expect(copies).toBe(1); expect(audioStart).not.toHaveBeenCalled();
  });

  it('continues sequentially after copy and explicit non-commit warnings without rolling back earlier or later commits', async () => {
    const owner = await createClient('Sequential media warning owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Sequential Media Warning Owner' });
    const paths = await Promise.all([source('first-success.wav'), source('copy-warning.wav'), source('transaction-conflict.wav'), source('later-success.wav')]); const project = projects.getActiveProject()!; const before = projects.getProject(project.id)!;
    const copied: string[] = [];
    copyToCache = async (sourcePath, destination) => {
      copied.push(basename(sourcePath));
      if (basename(sourcePath) === 'copy-warning.wav') { await writeFile(destination, 'injected-partial-cache'); throw new Error('Injected cache-copy failure'); }
      await copyFile(sourcePath, destination);
    };
    const apply = projects.apply.bind(projects); const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction: ProjectTransaction, actor, skipCheckpoint) => transaction.label === 'Import transaction-conflict.wav'
      ? { status: 'conflict', message: 'Injected import transaction conflict', conflict: { retryable: true } }
      : apply(transaction, actor, skipCheckpoint));
    const queued = await owner.callTool<{ jobId: string }>('media_manage', { action: 'import', projectId: project.id, paths });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const completed = await waitForJob(queued.jobId, (job) => job.status === 'completed');
    expect(completed).toMatchObject({
      status: 'completed', cancellable: false,
      result: {
        output: { imported: [{ asset: { name: 'first-success.wav' } }, { asset: { name: 'later-success.wav' } }], warnings: ['copy-warning.wav: Injected cache-copy failure', 'transaction-conflict.wav: Injected import transaction conflict'] },
        partial: {
          continuation: 'fulfilled', requestedFiles: 4,
          files: [
            { index: 0, outcome: 'imported', sourceRead: 'completed', cache: 'retained', projectTransaction: 'committed', assetSource: 'registered' },
            { index: 1, outcome: 'warning', sourceRead: 'completed', cache: 'may-be-partial', projectTransaction: 'unchanged', assetSource: 'unchanged', warning: 'copy-warning.wav: Injected cache-copy failure' },
            { index: 2, outcome: 'warning', sourceRead: 'completed', cache: 'retained', projectTransaction: 'unchanged', assetSource: 'unchanged', warning: 'transaction-conflict.wav: Injected import transaction conflict' },
            { index: 3, outcome: 'imported', sourceRead: 'completed', cache: 'retained', projectTransaction: 'committed', assetSource: 'registered' },
          ],
        },
      },
    });
    const after = projects.getProject(project.id)!; expect(after.revision).toBe(before.revision + 2); expect(copied).toEqual(['first-success.wav', 'copy-warning.wav', 'transaction-conflict.wav', 'later-success.wav']);
    expect(Object.values(after.assets).filter((asset) => asset.source === 'import').map((asset) => asset.name).sort()).toEqual(['first-success.wav', 'later-success.wav']);
    expect(after.activity.filter((entry) => entry.label.startsWith('Import ')).map((entry) => entry.label)).toEqual(['Import first-success.wav', 'Import later-success.wav']);
    for (const asset of Object.values(after.assets).filter((candidate) => candidate.source === 'import')) { expect(asset.createdBy).toBe(joined.actor.id); expect(projects.getAssetSource(project.id, asset.id)).toBe(asset.externalPath); }
    expect(await readFile(managedPath('copy-warning.wav'), 'utf8')).toBe('injected-partial-cache'); expect(await readFile(managedPath('transaction-conflict.wav'), 'utf8')).toBe('RIFF-transaction-conflict.wav'); expect(applySpy).toHaveBeenCalledTimes(3); expect(audioStart).not.toHaveBeenCalled();
  });

  it('retains an earlier commit and conservative current-file effects when a cancelled transaction returns engine-error late', async () => {
    const owner = await createClient('Late media transaction owner');
    await owner.callTool('session_manage', { action: 'join', name: 'Late Media Transaction Owner' });
    const paths = await Promise.all([source('committed-before-failure.wav'), source('transaction-failure.wav')]); const project = projects.getActiveProject()!; const before = projects.getProject(project.id)!;
    const transactionStarted = deferred(); const releaseTransaction = deferred(); const apply = projects.apply.bind(projects);
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction: ProjectTransaction, actor, skipCheckpoint) => {
      if (transaction.label === 'Import transaction-failure.wav') { transactionStarted.resolve(); await releaseTransaction.promise; return { status: 'engine-error', message: 'Injected import transaction engine error', conflict: { retryable: true } }; }
      return apply(transaction, actor, skipCheckpoint);
    });
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('media_manage', { action: 'import', projectId: project.id, paths });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await transactionStarted.promise;
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: {
        partial: {
          continuation: 'running',
          files: [
            { outcome: 'imported', cache: 'retained', projectTransaction: 'committed', assetSource: 'registered' },
            { outcome: 'running', sourceRead: 'completed', cache: 'retained', projectTransaction: 'may-have-committed', assetSource: 'unchanged' },
          ],
        },
      },
    });
    releaseTransaction.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'fulfilled');
    expect(retained).toMatchObject({
      status: 'cancelled', cancellable: false,
      result: {
        output: { imported: [{ asset: { name: 'committed-before-failure.wav' } }], warnings: ['transaction-failure.wav: Injected import transaction engine error'] },
        partial: {
          continuation: 'fulfilled',
          files: [
            { outcome: 'imported', cache: 'retained', projectTransaction: 'committed', assetSource: 'registered' },
            { outcome: 'warning', sourceRead: 'completed', cache: 'retained', projectTransaction: 'may-have-committed', assetSource: 'unchanged', warning: 'transaction-failure.wav: Injected import transaction engine error' },
          ],
        },
      },
    });
    const after = projects.getProject(project.id)!; expect(after.revision).toBe(before.revision + 1); expect(Object.values(after.assets).filter((asset) => asset.source === 'import').map((asset) => asset.name)).toEqual(['committed-before-failure.wav']);
    expect(await readFile(managedPath('transaction-failure.wav'), 'utf8')).toBe('RIFF-transaction-failure.wav'); expect(applySpy).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('completed');
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('failed');
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('never resurrects a cancellation when cache preparation rejects late and reports an ordinary rejection once without retry', async () => {
    const owner = await createClient('Rejecting media preparation owner');
    await owner.callTool('session_manage', { action: 'join', name: 'Rejecting Media Preparation Owner' });
    const path = await source('preparation-failure.wav'); const project = projects.getActiveProject()!; const before = projects.getProject(project.id)!;
    const preparationStarted = deferred(); const releasePreparation = deferred(); let preparations = 0;
    makeCacheDirectory = async () => { preparations += 1; if (preparations === 1) { preparationStarted.resolve(); await releasePreparation.promise; } throw new Error('Injected media cache preparation failure'); };
    const upsert = vi.spyOn(projects, 'upsertJob');
    const cancelledJob = await owner.callTool<{ jobId: string }>('media_manage', { action: 'import', projectId: project.id, paths: [path] });
    expect(projects.resolveJob(cancelledJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await preparationStarted.promise;
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: cancelledJob.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { continuation: 'running', files: [{ outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' }] } },
    });
    releasePreparation.resolve();
    const cancelled = await waitForJob(cancelledJob.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'rejected');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellable: false, result: { partial: { continuation: 'rejected', files: [{ outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' }] } } });
    expect(cancelled).not.toHaveProperty('approval'); expect(cancelled).not.toHaveProperty('error'); expect(projects.getProject(project.id)).toEqual(before);
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === cancelledJob.jobId).map((job) => job.status)).not.toContain('failed');
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === cancelledJob.jobId).map((job) => job.status)).not.toContain('completed');

    const failedJob = await owner.callTool<{ jobId: string }>('media_manage', { action: 'import', projectId: project.id, paths: [path] });
    expect(projects.resolveJob(failedJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const failed = await waitForJob(failedJob.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      status: 'failed', cancellable: false,
      error: { code: 'approved-media-import-failed', message: 'Injected media cache preparation failure', retryable: false },
      result: { partial: { continuation: 'rejected', files: [{ outcome: 'pending', sourceRead: 'not-started', cache: 'unchanged', projectTransaction: 'unchanged', assetSource: 'unchanged' }] } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: failedJob.jobId })).resolves.toMatchObject({ next: { guidance: expect.stringMatching(/failed and was not retried automatically.*No cleanup, rollback, request-wide atomicity/) } });
    expect(preparations).toBe(2); expect(projects.getProject(project.id)).toEqual(before); expect(audioStart).not.toHaveBeenCalled();
  });
});
