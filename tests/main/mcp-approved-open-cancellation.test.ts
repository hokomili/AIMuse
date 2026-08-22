import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

describe('headless authenticated approved project-open cancellation', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let host: McpHost;
  let url: string;
  const token = Buffer.alloc(32, 0x31).toString('base64url');
  const clients: TestClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-approved-open-cancellation-'));
    audio = new AudioEngineController();
    audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '6'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
      cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, exports,
    });
    await projects.initialize();
    await plugins.initialize();
    url = (await host.start(token)).url;
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await host.stop();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createClient(name: string): Promise<TestClient> {
    let requestId = 0;
    const request = async (body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcResultMessage }> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
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
    expect(initialized.response.status).toBe(200);
    expect(initialized.message?.error).toBeUndefined();
    const sessionId = initialized.response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
    const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const response = await request({ jsonrpc: '2.0', id: ++requestId, method, params }, sessionId!);
      expect(response.response.status).toBe(200);
      expect(response.message?.error).toBeUndefined();
      return response.message?.result as T;
    };
    const client: TestClient = {
      rpc,
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc<ToolCallResult>('tools/call', { name: toolName, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.content).toHaveLength(1);
        return JSON.parse(result.content[0].text!) as T;
      },
      close: async () => {
        await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! } });
      },
    };
    clients.push(client);
    return client;
  }

  async function createSavedFixture(slug: string): Promise<{ id: string; path: string }> {
    await projects.create({ kind: 'song', name: `Open fixture ${slug}` });
    const id = projects.getActiveProjectId()!;
    const saved = await projects.save(id, join(root, 'fixtures', slug));
    await projects.close(id, true);
    expect(projects.getProject(id)).toBeUndefined();
    return { id, path: saved.projectPath };
  }

  async function waitForJob(jobId: string, predicate: (job: AsyncJob) => boolean): Promise<AsyncJob> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = projects.getJob(jobId);
      if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for approved open job ${jobId}.`);
  }

  function workspaceState(): { activeProjectId?: string; projectIds: string[]; audioProjectId?: string; graphRevision: number } {
    const transport = audio.snapshot();
    return {
      activeProjectId: projects.getActiveProjectId(),
      projectIds: projects.getProjects().map((project) => project.id).sort(),
      audioProjectId: transport.projectId,
      graphRevision: transport.graphRevision,
    };
  }

  it('cancels a waiting approved open before effects, preserves privacy and gate reuse, and leaves direct authority-allowed open synchronous', async () => {
    const waitingFixture = await createSavedFixture('waiting');
    const directFixture = await createSavedFixture('direct-authority');
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Approved open owner');
    const foreign = await createClient('Approved open foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Approved Open Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Approved Open Foreign' });
    const listed = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'project_manage')?.description).toContain('Approved project-open cancellation is terminal and reports source/workspace/project/audio-controller partial effects');
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Approved project-open cancellation is terminal but does not preempt an already-running source read or audio-controller synchronization');
    const openSpy = vi.spyOn(projects, 'open');
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject');
    const before = workspaceState();

    const queued = await owner.callTool<{ jobId: string; status: string }>('project_manage', { action: 'open', path: waitingFixture.path });
    expect(queued).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: joined.actor.id, kind: 'media', status: 'waiting-for-user', approval: { kind: 'file-read', request: { action: 'open', path: waitingFixture.path } } });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { sourceRead: 'not-started', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' } },
      next: { guidance: expect.stringContaining('cancelled before its source read') },
    });
    expect(projects.getJob(queued.jobId)).not.toHaveProperty('approval');
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'cancelled' });
    expect(openSpy).not.toHaveBeenCalled();
    expect(synchronizeSpy).not.toHaveBeenCalled();
    expect(workspaceState()).toEqual(before);

    const reused = await foreign.callTool<{ jobId: string; status: string }>('project_manage', { action: 'open', path: directFixture.path });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId })).resolves.toMatchObject({ status: 'cancelled', result: { partial: { sourceRead: 'not-started' } } });
    expect(openSpy).not.toHaveBeenCalled();

    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'approved-open-direct-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [root], writeRoots: [], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
    const beforeDirectJobs = projects.listJobs().length;
    await expect(foreign.callTool('project_manage', { action: 'open', path: directFixture.path })).resolves.toEqual({ opened: [directFixture.id], warnings: [] });
    expect(projects.listJobs()).toHaveLength(beforeDirectJobs);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(synchronizeSpy).toHaveBeenCalledTimes(1);
    expect(projects.getActiveProjectId()).toBe(directFixture.id);
    expect(audio.snapshot()).toMatchObject({ projectId: directFixture.id });
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps late approved-open success cancelled while retaining the opened project and completed controller synchronization', async () => {
    const fixture = await createSavedFixture('late-success');
    const owner = await createClient('Late approved open owner');
    const foreign = await createClient('Late approved open foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Late Open Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Late Open Foreign' });
    const priorAudioProjectId = audio.snapshot().projectId;
    const synchronize = audio.synchronizeProject.bind(audio);
    const started = deferred(); const release = deferred();
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject').mockImplementation(async (project) => { started.resolve(); await release.promise; return synchronize(project); });
    const openSpy = vi.spyOn(projects, 'open');
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'open', path: fixture.path });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise;
    await waitForJob(queued.jobId, (job) => job.status === 'running');
    expect(projects.getProject(fixture.id)).toBeDefined();
    expect(projects.getActiveProjectId()).toBe(fixture.id);
    expect(audio.snapshot().projectId).toBe(priorAudioProjectId);
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });

    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { sourceRead: 'may-have-completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' } },
      next: { guidance: expect.stringContaining('did not preempt the running approved open') },
    });
    const reused = await foreign.callTool<{ jobId: string; status: string }>('project_manage', { action: 'open', path: fixture.path });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId });

    release.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { workspaceIdentity?: string } } | undefined)?.partial?.workspaceIdentity === 'retained');
    expect(retained).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', progress: 1, cancellable: false,
      result: {
        output: { opened: [fixture.id], warnings: [] },
        partial: { sourceRead: 'completed', workspaceIdentity: 'retained', openedProject: 'retained', audioController: 'synchronized' },
      },
    });
    expect(retained).not.toHaveProperty('approval');
    expect(retained).not.toHaveProperty('error');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', next: { tool: 'project_manage', arguments: { action: 'list' }, guidance: expect.stringContaining('opened project remains in the workspace') },
    });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    expect(projects.getActiveProjectId()).toBe(fixture.id);
    expect(projects.getProject(fixture.id)).toBeDefined();
    expect(audio.snapshot()).toMatchObject({ projectId: fixture.id, graphRevision: projects.getProject(fixture.id)!.revision });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(synchronizeSpy).toHaveBeenCalledTimes(1);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('settles a late completed read with warnings as cancelled and exact zero workspace/project/audio effects', async () => {
    const emptyFolder = join(root, 'empty-project-folder');
    await mkdir(emptyFolder, { recursive: true });
    const owner = await createClient('Warning approved open owner');
    await owner.callTool('session_manage', { action: 'join', name: 'Warning Open Owner' });
    const before = workspaceState();
    const open = projects.open.bind(projects);
    const started = deferred(); const release = deferred();
    const openSpy = vi.spyOn(projects, 'open').mockImplementation(async (...args) => { started.resolve(); await release.promise; return open(...args); });
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject');
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'open', path: emptyFolder });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise;
    await waitForJob(queued.jobId, (job) => job.status === 'running');
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({ status: 'cancelled', result: { partial: { sourceRead: 'may-have-completed' } } });
    release.resolve();
    const settled = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { sourceRead?: string } } | undefined)?.partial?.sourceRead === 'completed');
    expect(settled).toMatchObject({
      status: 'cancelled', progress: 1, cancellable: false,
      result: {
        output: { opened: [], warnings: [expect.stringContaining('empty-project-folder')] },
        partial: { sourceRead: 'completed', workspaceIdentity: 'unchanged', openedProject: 'unchanged', audioController: 'unchanged' },
      },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', next: { tool: 'job_manage', guidance: expect.stringContaining('finished without opening a project') },
    });
    expect(workspaceState()).toEqual(before);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(synchronizeSpy).not.toHaveBeenCalled();
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps audio-controller rejection terminal, reports conservative effects, retains opened workspace state, and never retries', async () => {
    const cancelledFixture = await createSavedFixture('audio-failure-cancelled');
    const failedFixture = await createSavedFixture('audio-failure-ordinary');
    const owner = await createClient('Failing approved open owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Failing Open Owner' });
    const priorAudio = audio.snapshot();
    const started = deferred(); const release = deferred(); let invocation = 0;
    const synchronizeSpy = vi.spyOn(audio, 'synchronizeProject').mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) { started.resolve(); await release.promise; }
      throw new Error('Injected approved project-open audio synchronization failure');
    });
    const openSpy = vi.spyOn(projects, 'open');
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'open', path: cancelledFixture.path });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise;
    await waitForJob(queued.jobId, (job) => job.status === 'running');
    expect(projects.getActiveProjectId()).toBe(cancelledFixture.id);
    expect(projects.getProject(cancelledFixture.id)).toBeDefined();
    expect(audio.snapshot()).toEqual(priorAudio);
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({ status: 'cancelled' });
    release.resolve();
    const cancelled = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.message.includes('open failed'));
    expect(cancelled).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', cancellable: false,
      result: { partial: { sourceRead: 'may-have-completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' } },
    });
    expect(cancelled).not.toHaveProperty('approval');
    expect(cancelled).not.toHaveProperty('error');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', next: { tool: 'project_manage', guidance: expect.stringMatching(/did not preempt.*remain uncertain/) },
    });
    expect(projects.getActiveProjectId()).toBe(cancelledFixture.id);
    expect(projects.getProject(cancelledFixture.id)).toBeDefined();
    expect(audio.snapshot()).toEqual(priorAudio);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(synchronizeSpy).toHaveBeenCalledTimes(1);

    const ordinary = await owner.callTool<{ jobId: string }>('project_manage', { action: 'open', path: failedFixture.path });
    expect(projects.resolveJob(ordinary.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const failed = await waitForJob(ordinary.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      ownerActorId: joined.actor.id, status: 'failed', cancellable: false,
      error: { code: 'approved-project-open-failed', message: 'Injected approved project-open audio synchronization failure', retryable: false },
      result: { partial: { sourceRead: 'may-have-completed', workspaceIdentity: 'may-have-changed', openedProject: 'may-have-opened', audioController: 'may-have-synchronized' } },
    });
    expect(failed).not.toHaveProperty('approval');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: ordinary.jobId })).resolves.toMatchObject({
      status: 'failed', next: { tool: 'project_manage', guidance: expect.stringMatching(/was not retried automatically.*remain uncertain/) },
    });
    expect(projects.getActiveProjectId()).toBe(failedFixture.id);
    expect(projects.getProject(failedFixture.id)).toBeDefined();
    expect(audio.snapshot()).toEqual(priorAudio);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(synchronizeSpy).toHaveBeenCalledTimes(2);
    expect(audioStart).not.toHaveBeenCalled();
  });
});
