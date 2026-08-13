import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { type Actor, type AsyncJob } from '@aimuse/core';
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

describe('headless authenticated approved project-save cancellation', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let host: McpHost;
  let url: string;
  const token = 'approved-save-cancellation-token';
  const clients: TestClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-approved-save-cancellation-'));
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
    const credentials: ProviderCredentials = {
      get: async () => undefined,
      set: async () => undefined,
      status: async () => ({ elevenlabs: false, stability: false, lyria: false }),
    };
    const generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '7'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
      cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports,
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

  async function waitForJob(jobId: string, predicate: (job: AsyncJob) => boolean): Promise<AsyncJob> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = projects.getJob(jobId);
      if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for approved save job ${jobId}.`);
  }

  async function makeProjectDirty(client: TestClient, projectId: string): Promise<void> {
    await expect(client.callTool('project_apply', {
      projectId, clientOperationId: `approved-save-edit-${crypto.randomUUID()}`, label: 'Prepare approved save fixture',
      operations: [{ kind: 'lyrics.set', lyrics: 'Approved save cancellation fixture' }], commitMode: 'direct',
    })).resolves.toMatchObject({ status: 'committed' });
  }

  it('cancels a waiting approved save before all effects, preserves privacy, and releases approval capacity', async () => {
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Approved save owner');
    const foreign = await createClient('Approved save foreign actor');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Approved Save Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Approved Save Foreign' });
    const listed = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'project_manage')?.description).toContain('Approved project-save cancellation is terminal and reports destination/project/audit partial effects');
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Approved project-save cancellation is terminal but does not preempt an already-running save');

    const project = projects.getActiveProject()!;
    await makeProjectDirty(owner, project.id);
    const before = projects.getProject(project.id)!;
    const beforeAudit = projects.listFileAudit(project.id);
    const saveSpy = vi.spyOn(projects, 'save');
    const target = join(root, 'waiting-owner-private-save');
    const queued = await owner.callTool<{ jobId: string; status: string }>('project_manage', { action: 'save', projectId: project.id, path: target });
    expect(queued).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: joined.actor.id, status: 'waiting-for-user', approval: { kind: 'file-write' } });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });

    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      id: queued.jobId, status: 'cancelled',
      result: { partial: { destination: 'unchanged', project: 'unchanged', audit: 'unchanged' } },
      next: { guidance: expect.stringContaining('cancelled before destination writes') },
    });
    expect(projects.getJob(queued.jobId)).not.toHaveProperty('approval');
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'cancelled' });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(projects.getProject(project.id)).toEqual(before);
    expect(projects.listFileAudit(project.id)).toEqual(beforeAudit);
    await expect(access(target)).rejects.toThrow();
    await expect(access(`${target}.aimuse`)).rejects.toThrow();

    const nextTarget = join(root, 'approval-gate-reused-save');
    const next = await foreign.callTool<{ jobId: string; status: string }>('project_manage', { action: 'save', projectId: project.id, path: nextTarget });
    expect(next).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: next.jobId })).resolves.toMatchObject({ status: 'cancelled', result: { partial: { destination: 'unchanged', project: 'unchanged', audit: 'unchanged' } } });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps late approved-save success cancelled while retaining destination, clean state, and attributed audit', async () => {
    const owner = await createClient('Late approved save owner');
    const foreign = await createClient('Late approved save foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Late Save Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Late Save Foreign' });
    const project = projects.getActiveProject()!;
    await makeProjectDirty(owner, project.id);
    const before = projects.getProject(project.id)!;
    const save = projects.save.bind(projects);
    const started = deferred(); const release = deferred();
    const saveSpy = vi.spyOn(projects, 'save').mockImplementation(async (...args) => { started.resolve(); await release.promise; return save(...args); });
    const target = join(root, 'late-success-save');
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'save', projectId: project.id, path: target });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise;
    await waitForJob(queued.jobId, (job) => job.status === 'running');
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });

    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      id: queued.jobId, status: 'cancelled',
      result: { partial: { destination: 'may-be-partial', project: 'save-may-have-completed', audit: 'may-have-been-recorded' } },
      next: { guidance: expect.stringContaining('did not preempt the running approved save') },
    });
    expect(projects.getJob(queued.jobId)).not.toHaveProperty('approval');
    expect(projects.getProject(project.id)).toEqual(before);
    expect(projects.listFileAudit(project.id)).toEqual([]);
    await expect(access(`${target}.aimuse`)).rejects.toThrow();

    const gateReuseTarget = join(root, 'running-cancel-gate-reuse');
    const gateReuse = await foreign.callTool<{ jobId: string; status: string }>('project_manage', { action: 'save', projectId: project.id, path: gateReuseTarget });
    expect(gateReuse).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: gateReuse.jobId })).resolves.toMatchObject({ status: 'cancelled' });

    release.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { destination?: string } } | undefined)?.partial?.destination === 'retained');
    expect(retained).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', progress: 1, cancellable: false,
      result: {
        output: { projectPath: expect.stringMatching(/late-success-save\.aimuse$/), warnings: [], audit: { type: 'file.saved', actor: { id: joined.actor.id, kind: 'agent' } } },
        partial: { destination: 'retained', project: 'saved', audit: 'recorded' },
      },
    });
    expect(retained).not.toHaveProperty('approval');
    expect(retained).not.toHaveProperty('error');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { destination: 'retained', project: 'saved', audit: 'recorded' } },
      next: { tool: 'project_observe', guidance: expect.stringContaining('save completed late') },
    });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });

    const output = (retained.result as { output: { projectPath: string; audit: Record<string, unknown> } }).output;
    await expect(access(join(output.projectPath, 'project.json'))).resolves.toBeUndefined();
    const persistedAudit = JSON.parse((await readFile(join(output.projectPath, 'activity', 'file-audit.jsonl'), 'utf8')).trim()) as Record<string, unknown>;
    expect(persistedAudit).toEqual(output.audit);
    const savedProject = projects.getProject(project.id)!;
    expect(savedProject).toMatchObject({ revision: before.revision, dirty: false, projectPath: output.projectPath, activity: before.activity });
    expect(projects.listFileAudit(project.id)).toEqual([output.audit]);
    expect(projects.snapshot(joined.actor.id).canUndo).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps late approved-save failure cancelled, reports conservative destination effects, and never retries', async () => {
    const owner = await createClient('Failing approved save owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Failing Save Owner' });
    const project = projects.getActiveProject()!;
    await makeProjectDirty(owner, project.id);
    const before = projects.getProject(project.id)!;
    const started = deferred(); const release = deferred(); let invocation = 0;
    const saveSpy = vi.spyOn(projects, 'save').mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) { started.resolve(); await release.promise; }
      throw new Error('Injected approved project-save failure');
    });
    const cancelledTarget = join(root, 'late-failure-save');
    const queued = await owner.callTool<{ jobId: string }>('project_manage', { action: 'save', projectId: project.id, path: cancelledTarget });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise;
    await waitForJob(queued.jobId, (job) => job.status === 'running');
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({ status: 'cancelled' });
    release.resolve();
    const cancelled = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.message.includes('save failed'));
    expect(cancelled).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', cancellable: false,
      result: { partial: { destination: 'may-be-partial', project: 'save-may-have-completed', audit: 'may-have-been-recorded' } },
    });
    expect(cancelled).not.toHaveProperty('approval');
    expect(cancelled).not.toHaveProperty('error');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', next: { guidance: expect.stringMatching(/project state is uncertain.*audit recording is uncertain/) },
    });
    expect(projects.getProject(project.id)).toEqual(before);
    expect(projects.listFileAudit(project.id)).toEqual([]);
    await expect(access(`${cancelledTarget}.aimuse`)).rejects.toThrow();
    expect(saveSpy).toHaveBeenCalledTimes(1);

    const failedTarget = join(root, 'ordinary-approved-save-failure');
    const ordinary = await owner.callTool<{ jobId: string }>('project_manage', { action: 'save', projectId: project.id, path: failedTarget });
    expect(projects.resolveJob(ordinary.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const failed = await waitForJob(ordinary.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      ownerActorId: joined.actor.id, status: 'failed', cancellable: false,
      error: { code: 'approved-project-save-failed', message: 'Injected approved project-save failure', retryable: false },
      result: { partial: { destination: 'may-be-partial', project: 'save-may-have-completed', audit: 'may-have-been-recorded' } },
    });
    expect(failed).not.toHaveProperty('approval');
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: ordinary.jobId })).resolves.toMatchObject({
      status: 'failed', next: { guidance: expect.stringMatching(/was not retried automatically.*project state is uncertain.*audit recording is uncertain/) },
    });
    expect(projects.getProject(project.id)).toEqual(before);
    expect(projects.listFileAudit(project.id)).toEqual([]);
    await expect(access(`${failedTarget}.aimuse`)).rejects.toThrow();
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(audioStart).not.toHaveBeenCalled();
  });
});
