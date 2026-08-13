import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  createId, createTrack, HUMAN_ACTOR, nowIso,
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
import { encodeFloat32Wav } from '../../src/main/wav';

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
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

describe('headless authenticated MCP export cancellation', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let host: McpHost;
  let url: string;
  const token = 'export-cancellation-token-0123456789';
  const clients: TestClient[] = [];
  const wav = encodeFloat32Wav([new Float32Array(2_048).fill(0.2), new Float32Array(2_048).fill(-0.2)], 48_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-export-cancellation-'));
    audio = new AudioEngineController();
    audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const policy: AuthorityPolicy = {
      version: 1, id: 'headless-export-policy', issuedAt, expiresAt, maxRuntimeMinutes: 60,
      budget: { currency: 'USD', maxSpendMinor: 0, maxGenerationRequests: 0, maxUnknownCostRequests: 0 },
      providers: {}, readRoots: [root], writeRoots: [root], overwritePaths: [], pluginAllowlist: [],
      allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
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
      appVersion: 'test', profileId: '8'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
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
    const client: TestClient = {
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const response = await request({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: toolName, arguments: args } }, sessionId!);
        expect(response.response.status).toBe(200);
        expect(response.message?.error).toBeUndefined();
        const result = response.message?.result as ToolCallResult;
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
    throw new Error(`Timed out waiting for export job ${jobId}.`);
  }

  it('keeps late master success or failure terminally cancelled and owner-private without cleaning retained output', async () => {
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Export owner');
    const foreign = await createClient('Export foreign actor');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Export Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Export Foreign' });
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Export cancellation is terminal but cooperative once running');
    expect(help.guidance).toContain('neither preempts/cleans output nor retries automatically');
    const project = projects.getActiveProject()!;
    const before = projects.getProject(project.id)!;
    const jobUpdates = vi.spyOn(projects, 'upsertJob');

    const successStarted = deferred(); const releaseSuccess = deferred();
    const render = vi.spyOn(audio, 'render').mockImplementationOnce(async (_project, destination) => {
      successStarted.resolve(); await releaseSuccess.promise;
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: ['injected late success'] };
    });
    const destination = join(root, 'late-master');
    const started = await owner.callTool<{ jobId: string }>('export_manage', { projectId: project.id, kind: 'master', destination, format: 'wav', overwrite: false });
    await successStarted.promise;
    expect(projects.getJob(started.jobId)).toMatchObject({ ownerActorId: joined.actor.id, status: 'running' });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: started.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: started.jobId })).resolves.toEqual({ error: 'job_not_found' });
    const cancelled = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: started.jobId });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      result: { partial: { output: 'may-be-partial', project: 'unchanged' } },
      next: { tool: 'job_manage', arguments: { action: 'inspect', jobId: started.jobId }, guidance: expect.stringContaining('does not preempt or clean up in-flight output') },
    });
    releaseSuccess.resolve();
    await waitForJob(started.jobId, (job) => (job.result as { partial?: { output?: string } } | undefined)?.partial?.output === 'retained');
    const inspected = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'inspect', jobId: started.jobId });
    expect(inspected).toMatchObject({
      status: 'cancelled',
      message: 'Export cancellation remained terminal after master output completed. The output remains at its destination.',
      result: { destination: `${destination}.wav`, request: { kind: 'master' }, partial: { output: 'retained', project: 'unchanged' } },
      next: { guidance: expect.stringContaining('before deciding whether to issue another export') },
    });
    await expect(access(`${destination}.wav`)).resolves.toBeUndefined();
    expect(projects.getProject(project.id)).toEqual(before);
    expect(jobUpdates.mock.calls.map(([job]) => job).filter((job) => job.id === started.jobId).map((job) => job.status)).not.toContain('completed');

    const failureStarted = deferred(); const releaseFailure = deferred();
    render.mockImplementationOnce(async () => { failureStarted.resolve(); await releaseFailure.promise; throw new Error('Injected export failure after cancellation.'); });
    const failedDestination = join(root, 'late-failure');
    const lateFailure = await owner.callTool<{ jobId: string }>('export_manage', { projectId: project.id, kind: 'master', destination: failedDestination, format: 'wav', overwrite: false });
    await failureStarted.promise;
    await owner.callTool('job_manage', { action: 'cancel', jobId: lateFailure.jobId });
    releaseFailure.resolve();
    await waitForJob(lateFailure.jobId, (job) => job.message.startsWith('Export cancellation remained terminal.'));
    const lateFailureResult = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'inspect', jobId: lateFailure.jobId });
    expect(lateFailureResult).toMatchObject({ status: 'cancelled', result: { partial: { output: 'may-be-partial', project: 'unchanged' } }, next: { guidance: expect.stringContaining('does not preempt or clean up') } });
    expect(lateFailureResult).not.toHaveProperty('error');
    await expect(access(`${failedDestination}.wav`)).rejects.toThrow();

    render.mockRejectedValueOnce(new Error('Injected ordinary export failure.'));
    const ordinaryFailure = await owner.callTool<{ jobId: string }>('export_manage', { projectId: project.id, kind: 'master', destination: join(root, 'ordinary-failure'), format: 'wav', overwrite: false });
    const failed = await waitForJob(ordinaryFailure.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'export-failed', retryable: true }, result: { partial: { output: 'may-be-partial', project: 'unchanged' } } });
    const publicFailure = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'inspect', jobId: ordinaryFailure.jobId });
    expect(publicFailure).toMatchObject({ status: 'failed', next: { guidance: expect.stringContaining('did not retry it automatically') } });
    expect(render).toHaveBeenCalledTimes(3);
    expect(audioStart).not.toHaveBeenCalled();
  }, 30_000);

  it('stops a multi-file stems export at its next cooperative boundary and reports retained partial output', async () => {
    const owner = await createClient('Stem export owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Stem Export Owner' });
    const project = projects.getActiveProject()!;
    const master = Object.values(project.tracks).find((track) => track.kind === 'master')!;
    const first = createTrack('audio', 'First Stem', '#06b6d4', joined.actor); first.routing.outputTrackId = master.id;
    const second = createTrack('audio', 'Second Stem', '#10b981', joined.actor); second.routing.outputTrackId = master.id;
    const fixture: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'export-stem-fixture', projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Create export stem fixtures', createdAt: nowIso(), checkpointPolicy: 'none',
      operations: [{ kind: 'track.add', track: first, index: project.trackOrder.length - 1 }, { kind: 'track.add', track: second, index: project.trackOrder.length }],
    };
    await expect(projects.apply(fixture, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed' });
    const before = projects.getProject(project.id)!;
    const renderStarted = deferred(); const releaseRender = deferred();
    const render = vi.spyOn(audio, 'render').mockImplementation(async (_project, destination) => {
      renderStarted.resolve(); await releaseRender.promise;
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: [] };
    });
    const destination = join(root, 'partial-stems');
    const started = await owner.callTool<{ jobId: string }>('export_manage', { projectId: project.id, kind: 'stems', destination, trackIds: [first.id, second.id], overwrite: false });
    await renderStarted.promise;
    const cancellation = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: started.jobId });
    expect(cancellation).toMatchObject({ status: 'cancelled', result: { partial: { output: 'may-be-partial', project: 'unchanged' } } });
    releaseRender.resolve();
    const settled = await waitForJob(started.jobId, (job) => job.message.startsWith('Export cancellation remained terminal.'));
    expect(settled).toMatchObject({ status: 'cancelled', result: { partial: { output: 'may-be-partial', project: 'unchanged' } } });
    expect(render).toHaveBeenCalledTimes(1);
    expect((await readdir(destination)).filter((name) => name.endsWith('.wav'))).toHaveLength(1);
    expect(projects.getProject(project.id)).toEqual(before);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('cancels waiting export approval with zero output and releases the global approval gate', async () => {
    const first = await createClient('First approval owner');
    const second = await createClient('Second approval owner');
    await first.callTool('session_manage', { action: 'join', name: 'First Approval Owner' });
    await second.callTool('session_manage', { action: 'join', name: 'Second Approval Owner' });
    const projectId = projects.getActiveProjectId()!;
    const outsideFirst = join(tmpdir(), `${basename(root)}-outside-first`);
    const outsideSecond = join(tmpdir(), `${basename(root)}-outside-second`);

    const firstStart = await first.callTool<{ jobId: string }>('export_manage', { projectId, kind: 'midi', destination: outsideFirst, overwrite: false });
    await waitForJob(firstStart.jobId, (job) => job.status === 'waiting-for-user');
    const cancelled = await first.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: firstStart.jobId });
    expect(cancelled).toMatchObject({
      status: 'cancelled', result: { partial: { output: 'unchanged', project: 'unchanged' } },
      next: { guidance: expect.stringContaining('before destination writes or a portable-pack save started') },
    });
    expect(projects.getJob(firstStart.jobId)).not.toHaveProperty('approval');
    await expect(access(`${outsideFirst}.mid`)).rejects.toThrow();

    const secondStart = await second.callTool<{ jobId: string }>('export_manage', { projectId, kind: 'midi', destination: outsideSecond, overwrite: false });
    await waitForJob(secondStart.jobId, (job) => job.status === 'waiting-for-user');
    await expect(first.callTool('job_manage', { action: 'inspect', jobId: secondStart.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await second.callTool('job_manage', { action: 'cancel', jobId: secondStart.jobId });
    await expect(access(`${outsideSecond}.mid`)).rejects.toThrow();
    expect(audioStart).not.toHaveBeenCalled();
  });
});
