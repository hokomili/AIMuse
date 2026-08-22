import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { type Actor, type AsyncJob, type AuthorityPolicy } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { McpHost } from '../../src/main/mcp-host';
import { MediaManager } from '../../src/main/media-manager';
import { packProjectFolder, unpackProjectPack, type UnpackProjectPackOptions } from '../../src/main/persistence';
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

describe('headless authenticated approved project-unpack terminality', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let host: McpHost;
  let url: string;
  let unpackRuntime: Omit<UnpackProjectPackOptions, 'observe'>;
  let unpackInvocations: number;
  const token = Buffer.alloc(32, 0x37).toString('base64url');
  const clients: TestClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-approved-project-unpack-'));
    audio = new AudioEngineController(); audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const exports = new ExportManager(projects, audio, authority);
    unpackRuntime = {}; unpackInvocations = 0;
    host = new McpHost({
      appVersion: 'test', profileId: 'b'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'),
      projects, audio, authority, media, plugins, exports,
      unpackProjectPack: async (packPath, destinationRoot, options) => {
        unpackInvocations += 1;
        return unpackProjectPack(packPath, destinationRoot, { ...unpackRuntime, ...options });
      },
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

  async function createPack(slug: string): Promise<{ id: string; path: string }> {
    await projects.create({ kind: 'song', name: `Unpack fixture ${slug}` });
    const id = projects.getActiveProjectId()!;
    const saved = await projects.save(id, join(root, 'fixtures', slug));
    await writeFile(join(saved.projectPath, `extra-${slug}.txt`), `extra-${slug}`);
    const path = await packProjectFolder(saved.projectPath, join(root, 'packs', `${slug}.aimusepack`));
    await projects.close(id, true); expect(projects.getProject(id)).toBeUndefined();
    return { id, path };
  }

  async function waitForJob(jobId: string, predicate: (job: AsyncJob) => boolean): Promise<AsyncJob> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const job = projects.getJob(jobId); if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for approved project-unpack job ${jobId}.`);
  }

  async function installAuthority(): Promise<void> {
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'approved-project-unpack-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [root], writeRoots: [root], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
  }

  function statuses(upsert: ReturnType<typeof vi.spyOn>, jobId: string): string[] {
    return (upsert.mock.calls as Array<[AsyncJob]>).map(([job]) => job).filter((job) => job.id === jobId).map((job) => job.status);
  }

  it('cancels before archive effects, preserves owner privacy and approval capacity, and leaves direct authority-allowed output synchronous', async () => {
    const waiting = await createPack('waiting'); const direct = await createPack('direct');
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Approved unpack owner'); const foreign = await createClient('Approved unpack foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Approved Unpack Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Approved Unpack Foreign' });
    const listed = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'project_manage')?.description).toContain('Approved project-unpack cancellation is terminal');
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Approved project-unpack cancellation is terminal');
    const destination = join(root, 'unpacked-waiting.aimuse');
    const queued = await owner.callTool<{ jobId: string; status: string }>('project_manage', { action: 'unpack', path: waiting.path, destination });
    expect(queued).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: joined.actor.id, kind: 'pack', approval: { kind: 'file-read', request: { action: 'unpack', path: waiting.path, destination } } });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { continuation: 'not-started', archiveRead: 'not-started', destination: 'unchanged', cleanup: 'not-started', entries: { discovered: 0, fileWritesStarted: 0, filesWritten: 0, directoriesCreated: 0 }, projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' } },
      next: { guidance: expect.stringContaining('before archive access') },
    });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'cancelled' }); expect(unpackInvocations).toBe(0); await expect(stat(destination)).rejects.toThrow();

    const reusedDestination = join(root, 'unpacked-reused.aimuse');
    const reused = await foreign.callTool<{ jobId: string; status: string }>('project_manage', { action: 'unpack', path: waiting.path, destination: reusedDestination });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' }); await foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId });

    await installAuthority(); const beforeJobs = projects.listJobs().length; const directDestination = join(root, 'unpacked-direct.aimuse');
    await expect(owner.callTool('project_manage', { action: 'unpack', path: direct.path, destination: directDestination })).resolves.toEqual({ opened: [direct.id], warnings: [] });
    expect(projects.listJobs()).toHaveLength(beforeJobs); expect(unpackInvocations).toBe(1); expect((await stat(join(directDestination, 'project.json'))).isFile()).toBe(true); expect(projects.getActiveProjectId()).toBe(direct.id); expect(audio.snapshot()).toMatchObject({ projectId: direct.id }); expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps cancellation terminal through delayed archive opening and retains the fully extracted, opened, synchronized project', async () => {
    const fixture = await createPack('late-archive-open'); const destination = join(root, 'unpacked-late-archive-open.aimuse'); const owner = await createClient('Late archive open owner'); await owner.callTool('session_manage', { action: 'join', name: 'Late Archive Open Owner' });
    const archiveStarted = deferred(); const releaseArchive = deferred();
    unpackRuntime.openArchive = async (path, openDefault) => { archiveStarted.resolve(); await releaseArchive.promise; return openDefault(path); };
    const upsert = vi.spyOn(projects, 'upsertJob'); const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: fixture.path, destination });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await archiveStarted.promise;
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { continuation: 'running', archiveRead: 'reading', destination: 'root-created', entries: { discovered: 0, filesWritten: 0 }, projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged' } },
    });
    releaseArchive.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'fulfilled');
    expect(retained).toMatchObject({
      status: 'cancelled', progress: 1, cancellable: false,
      result: { output: { opened: [fixture.id], warnings: [] }, partial: { continuation: 'fulfilled', archiveRead: 'completed', destination: 'retained', cleanup: 'not-started', entries: { discovered: expect.any(Number), fileWritesStarted: expect.any(Number), filesWritten: expect.any(Number) }, projectValidation: 'completed', projectOpen: 'fulfilled', workspaceIdentity: 'retained', openedProject: 'retained', audioController: 'synchronized' } },
    });
    const partial = (retained.result as { partial: { entries: { discovered: number; filesWritten: number } } }).partial; expect(partial.entries.discovered).toBeGreaterThan(1); expect(partial.entries.filesWritten).toBeGreaterThan(1);
    expect(projects.getProject(fixture.id)?.projectPath).toBe(destination); expect(audio.snapshot()).toMatchObject({ projectId: fixture.id }); expect((await stat(join(destination, 'project.json'))).isFile()).toBe(true); expect(statuses(upsert, queued.jobId)).not.toContain('completed'); expect(statuses(upsert, queued.jobId)).not.toContain('failed'); expect(unpackInvocations).toBe(1); expect(audioStart).not.toHaveBeenCalled();
  });

  it('settles an archive-open rejection after its exact destination-removal attempt without retrying', async () => {
    const fixture = await createPack('archive-open-failure'); const destination = join(root, 'unpacked-archive-open-failure.aimuse'); const owner = await createClient('Archive open failure owner'); await owner.callTool('session_manage', { action: 'join', name: 'Archive Open Failure Owner' });
    let archiveOpens = 0; unpackRuntime.openArchive = async () => { archiveOpens += 1; throw new Error('Injected archive-open failure'); };
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: fixture.path, destination }); expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const failed = await waitForJob(queued.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      status: 'failed', cancellable: false,
      error: { code: 'approved-project-unpack-failed', message: 'Injected archive-open failure', retryable: false },
      result: { partial: { continuation: 'rejected', archiveRead: 'reading', destination: 'removed', cleanup: 'completed', entries: { discovered: 0, fileWritesStarted: 0, filesWritten: 0, directoriesCreated: 0 }, projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({ next: { tool: 'job_manage', guidance: expect.stringMatching(/completed its destination-removal attempt.*does not promise cleanup/) } });
    await expect(stat(destination)).rejects.toThrow(); expect(archiveOpens).toBe(1); expect(unpackInvocations).toBe(1); expect(projects.getProject(fixture.id)).toBeUndefined(); expect(audioStart).not.toHaveBeenCalled();
  });

  it('reports completed and incomplete per-file writes when a cancelled extraction rejects and cleanup itself fails', async () => {
    const fixture = await createPack('partial-write'); const destination = join(root, 'unpacked-partial-write.aimuse'); const owner = await createClient('Partial unpack owner'); await owner.callTool('session_manage', { action: 'join', name: 'Partial Unpack Owner' });
    const secondWriteStarted = deferred(); const releaseWrite = deferred(); let writes = 0; let cleanupAttempts = 0;
    unpackRuntime.writeEntry = async (stream, path, writeDefault) => {
      writes += 1;
      if (writes === 1) return writeDefault(stream, path);
      await writeFile(path, 'injected partial archive entry'); secondWriteStarted.resolve(); await releaseWrite.promise; throw new Error('Injected archive entry failure');
    };
    unpackRuntime.removeDestination = async () => { cleanupAttempts += 1; throw new Error('Injected unpack cleanup failure'); };
    const upsert = vi.spyOn(projects, 'upsertJob'); const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: fixture.path, destination });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await secondWriteStarted.promise;
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { continuation: 'running', archiveRead: 'reading', destination: 'may-be-partial', cleanup: 'not-started', entries: { fileWritesStarted: 2, filesWritten: 1, active: { entryType: 'file' } }, projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged' } },
      next: { guidance: expect.stringContaining('No archive-wide atomicity') },
    });
    releaseWrite.resolve();
    const settled = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'rejected');
    expect(settled).toMatchObject({
      status: 'cancelled', cancellable: false,
      result: { partial: { continuation: 'rejected', archiveRead: 'reading', destination: 'may-be-partial', cleanup: 'failed', entries: { fileWritesStarted: 2, filesWritten: 1 }, projectValidation: 'not-started', projectOpen: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({ next: { tool: 'project_manage', guidance: expect.stringMatching(/No archive-wide atomicity.*cleanup.*retry/) } });
    expect(settled).not.toHaveProperty('error'); expect((await stat(destination)).isDirectory()).toBe(true); expect(projects.getProject(fixture.id)).toBeUndefined(); expect(writes).toBe(2); expect(cleanupAttempts).toBe(1); expect(unpackInvocations).toBe(1); expect(statuses(upsert, queued.jobId)).not.toContain('completed'); expect(statuses(upsert, queued.jobId)).not.toContain('failed'); expect(audioStart).not.toHaveBeenCalled();
  });

  it('reports the open phase separately and keeps late controller synchronization terminal while retaining extraction and workspace identity', async () => {
    const fixture = await createPack('late-controller'); const destination = join(root, 'unpacked-late-controller.aimuse'); const owner = await createClient('Late unpack controller owner'); await owner.callTool('session_manage', { action: 'join', name: 'Late Unpack Controller Owner' });
    const priorAudioProject = audio.snapshot().projectId; const synchronize = audio.synchronizeProject.bind(audio); const controllerStarted = deferred(); const releaseController = deferred();
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject').mockImplementation(async (project) => { controllerStarted.resolve(); await releaseController.promise; return synchronize(project); });
    const upsert = vi.spyOn(projects, 'upsertJob'); const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: fixture.path, destination });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await controllerStarted.promise;
    expect(projects.getProject(fixture.id)?.projectPath).toBe(destination); expect(audio.snapshot().projectId).toBe(priorAudioProject);
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { continuation: 'running', archiveRead: 'completed', destination: 'retained', projectValidation: 'completed', projectOpen: 'running', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' } },
    });
    releaseController.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { continuation?: string } } | undefined)?.partial?.continuation === 'fulfilled');
    expect(retained).toMatchObject({ status: 'cancelled', result: { output: { opened: [fixture.id], warnings: [] }, partial: { destination: 'retained', projectOpen: 'fulfilled', workspaceIdentity: 'retained', openedProject: 'retained', audioController: 'synchronized' } } });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({ next: { guidance: expect.stringContaining('opened project remains in the workspace') } });
    expect(audio.snapshot()).toMatchObject({ projectId: fixture.id, graphRevision: projects.getProject(fixture.id)!.revision }); expect(synchronizeSpy).toHaveBeenCalledTimes(1); expect(statuses(upsert, queued.jobId)).not.toContain('completed'); expect(statuses(upsert, queued.jobId)).not.toContain('failed'); expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps late open rejection terminal, reports re-observable retained workspace effects, and fails an ordinary request once without retry', async () => {
    const cancelledFixture = await createPack('open-failure-cancelled'); const ordinaryFixture = await createPack('open-failure-ordinary'); const cancelledDestination = join(root, 'unpacked-open-failure-cancelled.aimuse'); const ordinaryDestination = join(root, 'unpacked-open-failure-ordinary.aimuse');
    const owner = await createClient('Failing unpack open owner'); const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Failing Unpack Open Owner' });
    const controllerStarted = deferred(); const releaseController = deferred(); let synchronizations = 0;
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject').mockImplementation(async () => { synchronizations += 1; if (synchronizations === 1) { controllerStarted.resolve(); await releaseController.promise; } throw new Error('Injected unpack open synchronization failure'); });
    const upsert = vi.spyOn(projects, 'upsertJob'); const cancelledJob = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: cancelledFixture.path, destination: cancelledDestination });
    expect(projects.resolveJob(cancelledJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); await controllerStarted.promise; await owner.callTool('job_manage', { action: 'cancel', jobId: cancelledJob.jobId }); releaseController.resolve();
    const cancelled = await waitForJob(cancelledJob.jobId, (job) => (job.result as { partial?: { projectOpen?: string } } | undefined)?.partial?.projectOpen === 'rejected');
    expect(cancelled).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', cancellable: false,
      result: { partial: { continuation: 'rejected', archiveRead: 'completed', destination: 'retained', cleanup: 'not-started', projectValidation: 'completed', projectOpen: 'rejected', workspaceIdentity: 'retained', openedProject: 'retained', audioController: 'may-have-synchronized' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: cancelledJob.jobId })).resolves.toMatchObject({ next: { tool: 'project_manage', guidance: expect.stringMatching(/did not preempt.*No archive-wide atomicity/) } });
    expect(cancelled).not.toHaveProperty('error'); expect(projects.getProject(cancelledFixture.id)?.projectPath).toBe(cancelledDestination); expect(statuses(upsert, cancelledJob.jobId)).not.toContain('completed'); expect(statuses(upsert, cancelledJob.jobId)).not.toContain('failed');

    const ordinaryJob = await owner.callTool<{ jobId: string }>('project_manage', { action: 'unpack', path: ordinaryFixture.path, destination: ordinaryDestination });
    expect(projects.resolveJob(ordinaryJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' }); const failed = await waitForJob(ordinaryJob.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      ownerActorId: joined.actor.id, status: 'failed', cancellable: false,
      error: { code: 'approved-project-unpack-failed', message: 'Injected unpack open synchronization failure', retryable: false },
      result: { partial: { continuation: 'rejected', archiveRead: 'completed', destination: 'retained', projectValidation: 'completed', projectOpen: 'rejected', workspaceIdentity: 'retained', openedProject: 'retained', audioController: 'may-have-synchronized' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: ordinaryJob.jobId })).resolves.toMatchObject({ next: { guidance: expect.stringContaining('was not retried automatically') } });
    expect(projects.getProject(ordinaryFixture.id)?.projectPath).toBe(ordinaryDestination); expect(synchronizeSpy).toHaveBeenCalledTimes(2); expect(synchronizations).toBe(2); expect(unpackInvocations).toBe(2); expect(audioStart).not.toHaveBeenCalled();
  });
});
