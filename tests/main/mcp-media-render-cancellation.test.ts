import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  createId, createTrack, HUMAN_ACTOR, nowIso,
  type Actor, type AsyncJob, type ProjectTransaction,
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

interface AdmissionClient {
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

describe('headless MCP media render-job cancellation', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let host: McpHost;
  const clients: AdmissionClient[] = [];
  const wav = encodeFloat32Wav([new Float32Array(2_048).fill(0.125), new Float32Array(2_048).fill(-0.125)], 48_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-media-render-cancellation-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    const authority = new AuthorityManager();
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
      appVersion: 'test', profileId: '1'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
      cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports,
    });
    await projects.initialize();
    await plugins.initialize();
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await host.stop();
    await audio.stop();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createClient(url: string, token: string, name: string): Promise<AdmissionClient> {
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
      const result = await request({ jsonrpc: '2.0', id: ++requestId, method, params }, sessionId!);
      expect(result.response.status).toBe(200);
      expect(result.message?.error).toBeUndefined();
      return result.message?.result as T;
    };
    const client: AdmissionClient = {
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
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = projects.getJob(jobId);
      if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for render job ${jobId}.`);
  }

  it('keeps cancellation terminal when an audition render succeeds or fails late and retains only possible cache output', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'media-render-cancellation-token-0123456789';
    const startedHost = await host.start(token);
    expect(audioStart).not.toHaveBeenCalled();

    const unauthorized = await fetch(startedHost.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);

    const owner = await createClient(startedHost.url, token, 'Render owner');
    const foreign = await createClient(startedHost.url, token, 'Render foreign actor');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Render Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Render Foreign' });
    const project = projects.getActiveProject()!;
    const initial = projects.getProject(project.id)!;
    const upsert = vi.spyOn(projects, 'upsertJob');
    const apply = vi.spyOn(projects, 'apply');

    let renderPath = '';
    let renderStarted!: () => void;
    let releaseRender!: () => void;
    const started = new Promise<void>((resolvePromise) => { renderStarted = resolvePromise; });
    const gate = new Promise<void>((resolvePromise) => { releaseRender = resolvePromise; });
    const render = vi.spyOn(audio, 'render').mockImplementationOnce(async (_project, destination) => {
      renderPath = destination; renderStarted(); await gate;
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: ['fixture render'] };
    });

    const startedJob = await owner.callTool<{ jobId: string }>('media_manage', { action: 'audition', projectId: project.id });
    await started;
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === startedJob.jobId).map((job) => job.status)).toEqual(['queued', 'running']);
    expect(projects.getJob(startedJob.jobId)).toMatchObject({ ownerActorId: joined.actor.id, status: 'running', cancellable: true });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: startedJob.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: startedJob.jobId })).resolves.toEqual({ error: 'job_not_found' });
    const cancellation = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: startedJob.jobId });
    expect(cancellation).toMatchObject({
      id: startedJob.jobId,
      status: 'cancelled',
      next: {
        tool: 'job_manage', arguments: { action: 'inspect', jobId: startedJob.jobId },
        guidance: expect.stringContaining('does not preempt the running render or an already-started project transaction'),
      },
    });
    releaseRender();

    const cancelled = await waitForJob(startedJob.jobId, (job) => job.status === 'cancelled' && job.cancellable === false);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      message: 'Cancelled while rendering. The completed managed-cache output remains; no project transaction started.',
      result: { warnings: ['fixture render'], partial: { cache: 'retained', project: 'unchanged' } },
    });
    expect(projects.getProject(project.id)).toEqual(initial);
    expect(apply).not.toHaveBeenCalled();
    await expect(access(renderPath)).resolves.toBeUndefined();
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === startedJob.jobId).map((job) => job.status)).not.toContain('completed');

    let rejectStarted!: () => void;
    let releaseReject!: () => void;
    const rejectingStarted = new Promise<void>((resolvePromise) => { rejectStarted = resolvePromise; });
    const rejectGate = new Promise<void>((resolvePromise) => { releaseReject = resolvePromise; });
    render.mockImplementationOnce(async () => { rejectStarted(); await rejectGate; throw new Error('Injected late render failure.'); });
    const rejectedJob = await owner.callTool<{ jobId: string }>('media_manage', { action: 'audition', projectId: project.id });
    await rejectingStarted;
    await owner.callTool('job_manage', { action: 'cancel', jobId: rejectedJob.jobId });
    releaseReject();
    const lateRejected = await waitForJob(rejectedJob.jobId, (job) => job.status === 'cancelled' && job.cancellable === false);
    expect(lateRejected).toMatchObject({
      status: 'cancelled',
      message: 'Cancelled while rendering. A partial managed-cache output may remain; no project transaction started.',
      result: { partial: { cache: 'may-be-partial', project: 'unchanged' } },
    });
    expect(lateRejected.error).toBeUndefined();
    expect(projects.getProject(project.id)).toEqual(initial);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('keeps cancellation terminal while preserving an in-flight consolidation asset or clip commit', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'media-consolidation-cancellation-token-0123456789';
    const startedHost = await host.start(token);
    const owner = await createClient(startedHost.url, token, 'Consolidation owner');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Consolidation Owner' });
    const project = projects.getActiveProject()!;
    const master = Object.values(project.tracks).find((track) => track.kind === 'master')!;
    const track = createTrack('audio', 'Consolidation Target', '#14b8a6', HUMAN_ACTOR); track.routing.outputTrackId = master.id;
    const fixture: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'render-cancellation-track-fixture', projectId: project.id,
      actor: HUMAN_ACTOR, label: 'Create consolidation target', createdAt: nowIso(),
      operations: [{ kind: 'track.add', track, index: Math.max(0, project.trackOrder.length - 1) }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(fixture, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });

    const originalApply = projects.apply.bind(projects);
    let block: 'asset' | 'clip' = 'asset';
    let assetCommitStarted!: () => void;
    let releaseAssetCommit!: () => void;
    const assetStarted = new Promise<void>((resolvePromise) => { assetCommitStarted = resolvePromise; });
    const assetGate = new Promise<void>((resolvePromise) => { releaseAssetCommit = resolvePromise; });
    let clipCommitStarted!: () => void;
    let releaseClipCommit!: () => void;
    const clipStarted = new Promise<void>((resolvePromise) => { clipCommitStarted = resolvePromise; });
    const clipGate = new Promise<void>((resolvePromise) => { releaseClipCommit = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (block === 'asset' && transaction.label === 'Consolidate audio') { assetCommitStarted(); await assetGate; }
      if (block === 'clip' && transaction.label.startsWith('Place ')) { clipCommitStarted(); await clipGate; }
      return originalApply(transaction, actor, skipCheckpoint);
    });
    const render = vi.spyOn(audio, 'render').mockImplementation(async (_renderProject, destination) => {
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: [] };
    });

    const assetRace = await owner.callTool<{ jobId: string }>('media_manage', { action: 'consolidate', projectId: project.id, trackId: track.id, placeAtTick: 240 });
    await assetStarted;
    await owner.callTool('job_manage', { action: 'cancel', jobId: assetRace.jobId });
    releaseAssetCommit();
    const assetCancelled = await waitForJob(assetRace.jobId, (job) => job.status === 'cancelled' && (job.result as { partial?: { project?: string } } | undefined)?.partial?.project === 'asset-committed');
    expect(assetCancelled).toMatchObject({
      ownerActorId: joined.actor.id,
      message: 'Cancelled after the render-asset transaction started. The managed render and committed asset remain; no later clip transaction started.',
      result: { assetId: expect.any(String), partial: { cache: 'retained', project: 'asset-committed' } },
    });
    const assetResult = assetCancelled.result as { assetId: string };
    const afterAssetRace = projects.getProject(project.id)!;
    expect(afterAssetRace.assets[assetResult.assetId]).toMatchObject({ kind: 'audio', createdBy: joined.actor.id, source: 'render' });
    expect(Object.values(afterAssetRace.clips).some((clip) => clip.kind === 'audio' && clip.assetId === assetResult.assetId)).toBe(false);
    expect(projects.getAssetSource(project.id, assetResult.assetId)).toBeTruthy();

    block = 'clip';
    const clipRace = await owner.callTool<{ jobId: string }>('media_manage', { action: 'consolidate', projectId: project.id, trackId: track.id, placeAtTick: 480 });
    await clipStarted;
    await owner.callTool('job_manage', { action: 'cancel', jobId: clipRace.jobId });
    releaseClipCommit();
    const clipCancelled = await waitForJob(clipRace.jobId, (job) => job.status === 'cancelled' && (job.result as { partial?: { project?: string } } | undefined)?.partial?.project === 'asset-and-clip-committed');
    expect(clipCancelled).toMatchObject({
      message: 'Cancelled after the consolidation clip transaction started. The managed render, asset and committed clip remain.',
      result: { assetId: expect.any(String), clipId: expect.any(String), partial: { cache: 'retained', project: 'asset-and-clip-committed' } },
    });
    const clipResult = clipCancelled.result as { assetId: string; clipId: string };
    const afterClipRace = projects.getProject(project.id)!;
    expect(afterClipRace.assets[clipResult.assetId]).toMatchObject({ kind: 'audio', createdBy: joined.actor.id, source: 'render' });
    expect(afterClipRace.clips[clipResult.clipId]).toMatchObject({ kind: 'audio', trackId: track.id, assetId: clipResult.assetId, startTick: 480, createdBy: joined.actor.id });
    expect(projects.getAssetSource(project.id, clipResult.assetId)).toBeTruthy();
    expect(render).toHaveBeenCalledTimes(2);
    expect(applySpy.mock.calls.map(([transaction]) => transaction.label).filter((label) => label === 'Consolidate audio')).toHaveLength(2);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('fairly admits render-job creation and cancels queued audition/consolidation before every effect', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'media-render-admission-token-0123456789';
    const startedHost = await host.start(token);
    const primary = await createClient(startedHost.url, token, 'Render admission owner');
    const joined = await primary.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Render Admission Owner' });
    const help = await primary.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(help.guidance).toContain('audition/consolidation render-job creation share those four fair lanes');
    expect(help.guidance).toContain('queued audition/consolidation creates no job/render/cache/project transaction');
    expect(help.guidance).toContain('Running media-job cancellation is cooperative');
    const listed = await primary.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'media_manage')?.description).toContain('audition/consolidation job creation shares it');

    const project = projects.getActiveProject()!;
    const destinationTrack = Object.values(project.tracks).find((track) => track.kind !== 'master')!;
    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createClient(startedHost.url, token, `Render lane client ${index + 1}`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Render Lane Agent ${index + 1}`, projectId: project.id })));
    const originalApply = projects.apply.bind(projects);
    let activeLanes = 0;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold render scheduler lane')) { activeLanes += 1; await laneGate; }
      return originalApply(transaction, actor, skipCheckpoint);
    });
    const render = vi.spyOn(audio, 'render');
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string; revision?: number }>('project_apply', {
      projectId: project.id,
      clientOperationId: `media-render-admission-blocker-${index + 1}`,
      label: `Hold render scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Retained render lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && activeLanes < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(activeLanes).toBe(4);
      const beforeCancellation = projects.getProject(project.id)!;
      const queued = [
        primary.callTool<Record<string, unknown>>('media_manage', { action: 'audition', projectId: project.id }),
        primary.callTool<Record<string, unknown>>('media_manage', { action: 'consolidate', projectId: project.id, trackId: destinationTrack.id }),
        primary.callTool<Record<string, unknown>>('media_manage', { action: 'audition', projectId: project.id }),
        primary.callTool<Record<string, unknown>>('media_manage', { action: 'consolidate', projectId: project.id, trackId: destinationTrack.id }),
      ];
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ queueDepth: 4, status: 'waiting' });
      expect(projects.listJobs(joined.actor.id)).toEqual([]);
      expect(render).not.toHaveBeenCalled();

      await expect(primary.callTool('media_manage', { action: 'audition', projectId: project.id })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { guidance: expect.stringContaining('No audition render job, cache output, or project transaction started') },
      });
      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelled = await Promise.all(queued);
      expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => String((result.next as { guidance?: string }).guidance).includes('Re-observe the project'))).toBe(true);
      expect(projects.listJobs(joined.actor.id)).toEqual([]);
      expect(render).not.toHaveBeenCalled();
      expect(projects.getProject(project.id)).toEqual(beforeCancellation);
      await expect(access(join(root, 'managed', 'auditions'))).rejects.toThrow();

      releaseLanes();
      const activeResults = await Promise.all(activeRequests);
      expect(activeResults.every((result) => result.status === 'committed')).toBe(true);

      let renderStarted!: () => void;
      let releaseRender!: () => void;
      const started = new Promise<void>((resolvePromise) => { renderStarted = resolvePromise; });
      const renderGate = new Promise<void>((resolvePromise) => { releaseRender = resolvePromise; });
      render.mockImplementationOnce(async (_renderProject, destination) => {
        renderStarted(); await renderGate;
        await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
        return { destination, durationSamples: 2_048, warnings: [] };
      });
      const admitted = await primary.callTool<{ jobId: string }>('media_manage', { action: 'audition', projectId: project.id });
      await started;
      await expect(primary.callTool('project_apply', {
        projectId: project.id,
        clientOperationId: 'media-render-lane-release-proof',
        label: 'Commit while admitted render is pending',
        operations: [{ kind: 'lyrics.set', lyrics: 'Render runtime released its admission lane.' }],
        commitMode: 'direct',
      })).resolves.toMatchObject({ status: 'committed' });
      await primary.callTool('job_manage', { action: 'cancel', jobId: admitted.jobId });
      releaseRender();
      await waitForJob(admitted.jobId, (job) => job.status === 'cancelled' && job.cancellable === false);
      expect(projects.getProject(project.id)!.lyrics).toBe('Render runtime released its admission lane.');
      expect(render).toHaveBeenCalledTimes(1);
      expect(audioStart).not.toHaveBeenCalled();
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
    }
  });
});
