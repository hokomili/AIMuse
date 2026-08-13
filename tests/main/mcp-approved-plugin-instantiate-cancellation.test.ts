import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  createId, HUMAN_ACTOR, nowIso,
  type Actor, type AsyncJob, type AuthorityPolicy, type PluginDescriptor, type ProjectTransaction,
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

describe('headless authenticated approved plug-in instantiate terminality', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let plugins: PluginManager;
  let host: McpHost;
  let url: string;
  const token = 'approved-plugin-instantiate-token';
  const clients: TestClient[] = [];
  const plugin: PluginDescriptor = {
    id: 'clap:approved-fixture', format: 'clap', name: 'Approved Fixture', vendor: 'AIMuse Tests', version: '1.0.0',
    path: '/injected/approved-fixture.clap', sha256: 'd'.repeat(64), categories: ['Fx'], instrument: false, quarantined: false,
    parameters: [{ id: 'gain', name: 'Gain', value: 0.5, defaultValue: 0.5, min: 0, max: 1, unit: 'linear', automatable: true }],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-approved-plugin-instantiate-'));
    const catalogPath = join(root, 'plugins.json');
    await writeFile(catalogPath, `${JSON.stringify({ version: 1, scannedAt: new Date(0).toISOString(), plugins: [plugin], quarantine: [] }, null, 2)}\n`);
    audio = new AudioEngineController(); audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    plugins = new PluginManager(catalogPath, undefined, projects, authority);
    const credentials: ProviderCredentials = {
      get: async () => undefined,
      set: async () => undefined,
      status: async () => ({ elevenlabs: false, stability: false, lyria: false }),
    };
    const generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '8'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'),
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
    throw new Error(`Timed out waiting for approved plug-in instantiate job ${jobId}.`);
  }

  function destination() {
    const project = projects.getActiveProject()!;
    const track = Object.values(project.tracks).find((candidate) => !['master', 'folder', 'midi'].includes(candidate.kind));
    if (!track) throw new Error('Expected an audio-capable destination track.');
    return { project, track };
  }

  async function installPluginAuthority(): Promise<void> {
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'approved-plugin-instantiate-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      budget: { currency: 'USD', maxSpendMinor: 0, maxGenerationRequests: 0, maxUnknownCostRequests: 0 }, providers: {}, readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [plugin.id], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
  }

  it('cancels while waiting before continuation or mutation, preserves privacy and gate reuse, and leaves direct allowed behavior synchronous', async () => {
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const owner = await createClient('Approved instantiate owner'); const foreign = await createClient('Approved instantiate foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Approved Instantiate Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Approved Instantiate Foreign' });
    const listed = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'plugin_manage')?.description).toContain('approved continuation has terminal cancellation');
    const help = await owner.callTool<{ guidance: string }>('aimuse_help', { topic: 'jobs-and-approvals' });
    expect(help.guidance).toContain('Approved plug-in instantiate cancellation is terminal');
    const { project, track } = destination(); const before = projects.getProject(project.id)!;
    const instantiate = vi.spyOn(plugins, 'instantiate');
    const queued = await owner.callTool<{ jobId: string; status: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(queued).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: joined.actor.id, kind: 'plugin-host', status: 'waiting-for-user', approval: { kind: 'plugin', request: { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id } } });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { projectTransaction: 'not-started', device: 'unchanged' } },
      next: { guidance: expect.stringContaining('cancelled before its authority continuation or project transaction') },
    });
    expect(projects.getJob(queued.jobId)).not.toHaveProperty('approval');
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'cancelled' });
    expect(instantiate).not.toHaveBeenCalled(); expect(projects.getProject(project.id)).toEqual(before);

    const reused = await foreign.callTool<{ jobId: string; status: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId })).resolves.toMatchObject({ status: 'cancelled', result: { partial: { projectTransaction: 'not-started', device: 'unchanged' } } });
    expect(instantiate).not.toHaveBeenCalled();

    await installPluginAuthority(); const jobCount = projects.listJobs().length;
    const direct = await owner.callTool<{ status: string; deviceId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(direct).toMatchObject({ status: 'committed', deviceId: expect.stringMatching(/^device_/) });
    expect(projects.listJobs()).toHaveLength(jobCount);
    expect(projects.getProject(project.id)!.devices[direct.deviceId]).toMatchObject({ trackId: track.id, pluginId: plugin.id, createdBy: joined.actor.id, updatedBy: joined.actor.id });
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps a running cancellation terminal when the atomic descriptor-device transaction commits late', async () => {
    const owner = await createClient('Late approved instantiate owner'); const foreign = await createClient('Late approved instantiate foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Late Approved Instantiate Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Late Approved Instantiate Foreign' });
    const { project, track } = destination(); const before = projects.getProject(project.id)!;
    const prepare = audio.prepareProject.bind(audio); const started = deferred(); const release = deferred();
    vi.spyOn(audio, 'prepareProject').mockImplementation(async (next) => { started.resolve(); await release.promise; return prepare(next); });
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(projects.resolveJob(queued.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise; await waitForJob(queued.jobId, (job) => job.status === 'running');
    expect(projects.getProject(project.id)).toEqual(before);
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', result: { partial: { projectTransaction: 'may-have-committed', device: 'may-have-been-added' } },
      next: { guidance: expect.stringContaining('did not preempt the running approved instantiate transaction') },
    });
    const reused = await foreign.callTool<{ jobId: string; status: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(reused).toMatchObject({ jobId: expect.stringMatching(/^approval-job_/), status: 'waiting-for-user' });
    await foreign.callTool('job_manage', { action: 'cancel', jobId: reused.jobId });

    release.resolve();
    const retained = await waitForJob(queued.jobId, (job) => (job.result as { partial?: { device?: string } } | undefined)?.partial?.device === 'retained');
    expect(retained).toMatchObject({
      ownerActorId: joined.actor.id, status: 'cancelled', progress: 1, cancellable: false,
      result: { output: { status: 'committed', deviceId: expect.stringMatching(/^device_/) }, partial: { projectTransaction: 'committed', device: 'retained' } },
    });
    expect(retained).not.toHaveProperty('approval'); expect(retained).not.toHaveProperty('error');
    const output = (retained.result as { output: { deviceId: string } }).output; const after = projects.getProject(project.id)!;
    expect(after).toMatchObject({ revision: before.revision + 1 });
    expect(after.devices[output.deviceId]).toMatchObject({ trackId: track.id, pluginId: plugin.id, createdBy: joined.actor.id, updatedBy: joined.actor.id });
    expect(after.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id, kind: 'agent' }, label: `Add ${plugin.name}`, status: 'committed' });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled', next: { tool: 'project_observe', arguments: { projectId: project.id }, guidance: expect.stringContaining('descriptor device') },
    });
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('completed');
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('failed');
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('honors a human destination-track lock and revalidates the target after approval without committing a device', async () => {
    const owner = await createClient('Locked approved instantiate owner');
    await owner.callTool('session_manage', { action: 'join', name: 'Locked Approved Instantiate Owner' });
    const { project, track } = destination(); const instantiate = vi.spyOn(plugins, 'instantiate');
    const before = projects.getProject(project.id)!;
    const lockedJob = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    const lock = projects.acquireLock({ projectId: project.id, entityIds: [track.id] });
    expect(lock).toMatchObject({ acquired: true, lock: { entityIds: [track.id] } });
    expect(projects.resolveJob(lockedJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const locked = await waitForJob(lockedJob.jobId, (job) => job.status === 'completed');
    expect(locked).toMatchObject({
      status: 'completed', cancellable: false,
      result: { output: { status: 'locked' }, partial: { projectTransaction: 'not-committed', device: 'unchanged' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: lockedJob.jobId })).resolves.toMatchObject({
      next: { tool: 'project_observe', guidance: expect.stringMatching(/human locks.*project revision/) },
    });
    expect(projects.getProject(project.id)).toEqual(before); projects.releaseLock(lock.lockId!);

    const prepareFailure = vi.spyOn(audio, 'prepareProject').mockRejectedValueOnce(new Error('Injected descriptor graph preparation failure'));
    const engineErrorJob = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(projects.resolveJob(engineErrorJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const engineError = await waitForJob(engineErrorJob.jobId, (job) => job.status === 'completed');
    expect(engineError).toMatchObject({
      status: 'completed',
      result: { output: { status: 'engine-error', message: 'Injected descriptor graph preparation failure' }, partial: { projectTransaction: 'may-have-committed', device: 'may-have-been-added' } },
    });
    expect(projects.getProject(project.id)).toEqual(before); prepareFailure.mockRestore();

    const staleTargetJob = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    const currentTrack = projects.getProject(project.id)!.tracks[track.id];
    const removeTrack: ProjectTransaction = {
      id: createId('tx'), clientOperationId: createId('remove-instantiate-target'), projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Remove approved instantiate destination', createdAt: nowIso(), operations: [{ kind: 'track.delete', trackId: track.id, cascade: true, expectedRevision: currentTrack.revision }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(removeTrack, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed' });
    const afterRemoval = projects.getProject(project.id)!;
    expect(projects.resolveJob(staleTargetJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const conflicted = await waitForJob(staleTargetJob.jobId, (job) => job.status === 'completed');
    expect(conflicted).toMatchObject({
      status: 'completed', result: { output: { status: 'conflict', message: 'Invalid device target.' }, partial: { projectTransaction: 'not-committed', device: 'unchanged' } },
    });
    expect(projects.getProject(project.id)).toEqual(afterRemoval); expect(Object.values(afterRemoval.devices).filter((device) => device.pluginId === plugin.id)).toEqual([]);
    expect(instantiate).toHaveBeenCalledTimes(3); expect(audioStart).not.toHaveBeenCalled();
  });

  it('never resurrects a cancelled rejected continuation and reports an uncancelled rejection without retry', async () => {
    const owner = await createClient('Failing approved instantiate owner');
    await owner.callTool('session_manage', { action: 'join', name: 'Failing Approved Instantiate Owner' });
    const { project, track } = destination(); const before = projects.getProject(project.id)!;
    const started = deferred(); const release = deferred(); let invocation = 0;
    const instantiate = vi.spyOn(plugins, 'instantiate').mockImplementation(async () => {
      invocation += 1; if (invocation === 1) { started.resolve(); await release.promise; }
      throw new Error('Injected approved plug-in instantiate failure');
    });
    const upsert = vi.spyOn(projects, 'upsertJob');
    const cancelledJob = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(projects.resolveJob(cancelledJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    await started.promise; await waitForJob(cancelledJob.jobId, (job) => job.status === 'running');
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: cancelledJob.jobId })).resolves.toMatchObject({ status: 'cancelled' });
    release.resolve();
    const cancelled = await waitForJob(cancelledJob.jobId, (job) => job.status === 'cancelled' && job.message.includes('continuation failed'));
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellable: false, result: { partial: { projectTransaction: 'may-have-committed', device: 'may-have-been-added' } } });
    expect(cancelled).not.toHaveProperty('approval'); expect(cancelled).not.toHaveProperty('error');
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === cancelledJob.jobId).map((job) => job.status)).not.toContain('failed');
    expect(projects.getProject(project.id)).toEqual(before);

    const failedJob = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'instantiate', projectId: project.id, trackId: track.id, pluginId: plugin.id });
    expect(projects.resolveJob(failedJob.jobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const failed = await waitForJob(failedJob.jobId, (job) => job.status === 'failed');
    expect(failed).toMatchObject({
      status: 'failed', cancellable: false,
      error: { code: 'approved-plugin-instantiate-failed', message: 'Injected approved plug-in instantiate failure', retryable: false },
      result: { partial: { projectTransaction: 'may-have-committed', device: 'may-have-been-added' } },
    });
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: failedJob.jobId })).resolves.toMatchObject({
      next: { guidance: expect.stringMatching(/failed and was not retried automatically.*commit remains uncertain/) },
    });
    expect(instantiate).toHaveBeenCalledTimes(2); expect(projects.getProject(project.id)).toEqual(before); expect(audioStart).not.toHaveBeenCalled();
  });
});
