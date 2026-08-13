import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { createId, entityBase, nowIso, type Actor, type AsyncJob, type MediaAsset } from '@aimuse/core';
import type { GenerationCandidate, GenerationJobResult, GenerationRequest } from '../../src/common/generation';
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

interface AdmissionClient {
  initialization: Record<string, unknown>;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

describe('headless MCP generation admission', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let generation: GenerationManager;
  let host: McpHost;
  let credentialGet: ProviderCredentials['get'];
  let providerFetch: typeof fetch;
  const clients: AdmissionClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-generation-admission-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    credentialGet = vi.fn(async () => 'fixture-provider-key');
    providerFetch = vi.fn() as unknown as typeof fetch;
    const credentials: ProviderCredentials = {
      get: credentialGet,
      set: async () => undefined,
      status: async () => ({ elevenlabs: true, stability: false, lyria: false }),
    };
    generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials, providerFetch);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({ appVersion: 'test', profileId: 'D'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports });
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

  function request(projectId: string): GenerationRequest {
    return {
      projectId, provider: 'elevenlabs', model: 'music_v1', kind: 'music',
      prompt: 'Warm analog instrumental with a strong chorus', instrumental: true, durationMs: 3_000,
      resultCount: 1, referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', providerOptions: {},
    };
  }

  function candidate(actor: Actor, suffix: string): GenerationCandidate {
    const asset: MediaAsset = {
      ...entityBase('asset', actor), kind: 'audio', name: `candidate-${suffix}.mp3`, mimeType: 'audio/mpeg',
      sha256: suffix.repeat(64).slice(0, 64), byteLength: 24, storage: 'managed-cache',
      externalPath: join(root, `candidate-${suffix}.mp3`), sampleRate: 48_000, channels: 2,
      durationSamples: 48_000, source: 'generation',
    };
    return {
      id: createId('generation-candidate'), asset, managedPath: asset.externalPath!, requestId: `request-${suffix}`,
      providerMetadata: { modelVersion: 'music_v1', fixture: true },
    };
  }

  async function createClient(url: string, token: string, name: string): Promise<AdmissionClient> {
    let requestId = 0;
    const requestRpc = async (body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcResultMessage }> => {
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

    const initialized = await requestRpc({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: '1' } } });
    expect(initialized.response.status).toBe(200);
    expect(initialized.message?.error).toBeUndefined();
    const sessionId = initialized.response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await requestRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);

    const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await requestRpc({ jsonrpc: '2.0', id: ++requestId, method, params }, sessionId!);
      expect(result.response.status).toBe(200);
      expect(result.message?.error).toBeUndefined();
      return result.message?.result as T;
    };
    const client: AdmissionClient = {
      initialization: initialized.message?.result as Record<string, unknown>,
      rpc,
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc<{ content: Array<{ type: string; text?: string }> }>('tools/call', { name: toolName, arguments: args });
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
        return JSON.parse(result.content[0].text!) as T;
      },
      close: async () => {
        await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! } });
      },
    };
    clients.push(client);
    return client;
  }

  it('fairly admits owner-scoped generation mutations and cancels queued work before approval, job, provider, candidate, or project effects', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'generation-listener-token-0123456789';
    const startedHost = await host.start(token);
    expect(startedHost.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(audioStart).not.toHaveBeenCalled();

    const unauthorized = await fetch(startedHost.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    expect(projects.getMcpInfo().sessions).toEqual([]);

    const primary = await createClient(startedHost.url, token, 'Generation listener client');
    expect(String(primary.initialization.instructions)).toContain('generation mutation admission is fair and bounded through the same lanes');
    const listed = await primary.rpc<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }>('tools/list', {});
    const generationTool = listed.tools.find((tool) => tool.name === 'generation_manage');
    expect(generationTool).toMatchObject({
      description: expect.stringContaining('queued cancellation creates no approval reservation, job, provider request, candidate disposition, or project mutation'),
      annotations: { destructiveHint: true, idempotentHint: false },
    });
    expect(generationTool?.description).toContain('Running cancellation stays terminal across late provider/cache fulfillment');

    const project = projects.getActiveProject()!;
    const joined = await primary.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Generation Agent', color: '#8b5cf6', projectId: project.id });
    const generationRequest = request(project.id);
    const candidates = [candidate(joined.actor, 'a'), candidate(joined.actor, 'b')];
    const timestamp = nowIso();
    const sourceJob: AsyncJob<GenerationJobResult> = {
      id: createId('generation-job'), ownerActorId: joined.actor.id, projectId: project.id, kind: 'generation',
      status: 'completed', progress: 1, message: 'Fixture generation completed.', createdAt: timestamp, updatedAt: timestamp,
      cancellable: true, result: { request: generationRequest, candidates, acceptedCandidateIds: [], rejectedCandidateIds: [] },
    };
    projects.upsertJob(sourceJob);

    const collaboration = await primary.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(collaboration.guidance).toContain('Generation start/variation/accept/reject actions share those four fair lanes');
    expect(collaboration.guidance).toContain('creates no approval reservation or job and makes no provider request');

    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createClient(startedHost.url, token, `Generation lane client ${index + 1}`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Generation Lane Agent ${index + 1}`, color: `#0${index + 1}b6d4`, projectId: project.id })));
    await expect(blockerClients[0].callTool('generation_manage', { action: 'inspect', jobId: sourceJob.id })).resolves.toEqual({ error: 'generation_job_not_found' });
    await expect(blockerClients[0].callTool('generation_manage', { action: 'accept', jobId: sourceJob.id, candidateId: candidates[0].id })).resolves.toEqual({ error: 'generation_job_not_found' });

    const apply = projects.apply.bind(projects);
    let activeLanes = 0;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold generation scheduler lane')) {
        activeLanes += 1;
        await laneGate;
      }
      return apply(transaction, actor, skipCheckpoint);
    });
    const startSpy = vi.spyOn(generation, 'start');
    const acceptSpy = vi.spyOn(generation, 'accept');
    const rejectSpy = vi.spyOn(generation, 'reject');
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string; revision?: number }>('project_apply', {
      projectId: project.id,
      clientOperationId: `generation-admission-blocker-${index + 1}`,
      label: `Hold generation scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Retained generation lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && activeLanes < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(activeLanes).toBe(4);
      const beforeCancellation = projects.getProject(project.id)!;
      const sourceBeforeCancellation = projects.getJob<GenerationJobResult>(sourceJob.id)!;

      const queuedMutations = [
        primary.callTool<Record<string, unknown>>('generation_manage', { action: 'start', request: generationRequest }),
        primary.callTool<Record<string, unknown>>('generation_manage', { action: 'variation', jobId: sourceJob.id, overrides: { seed: 42 } }),
        primary.callTool<Record<string, unknown>>('generation_manage', { action: 'accept', jobId: sourceJob.id, candidateId: candidates[0].id, startTick: 960 }),
        primary.callTool<Record<string, unknown>>('generation_manage', { action: 'reject', jobId: sourceJob.id, candidateId: candidates[1].id }),
      ];
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ actor: { id: joined.actor.id }, projectId: project.id, queueDepth: 4, status: 'waiting' });
      expect(startSpy).not.toHaveBeenCalled();
      expect(acceptSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expect(credentialGet).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();

      await expect(primary.callTool('generation_manage', { action: 'start', request: generationRequest })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { tool: 'job_manage', arguments: { action: 'list' }, guidance: expect.stringContaining('No generation start, approval reservation, generation job, or provider request started') },
      });

      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelled = await Promise.all(queuedMutations);
      expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelled[0]).toMatchObject({ next: { tool: 'job_manage', guidance: expect.stringContaining('No generation start, approval reservation, generation job, or provider request started') } });
      expect(cancelled[1]).toMatchObject({ next: { tool: 'generation_manage', arguments: { action: 'inspect', jobId: sourceJob.id }, guidance: expect.stringContaining('No generation variation, approval reservation, generation job, or provider request started') } });
      expect(cancelled[2]).toMatchObject({ next: { tool: 'generation_manage', guidance: expect.stringContaining('No candidate acceptance, candidate disposition, or project mutation started') } });
      expect(cancelled[3]).toMatchObject({ next: { tool: 'generation_manage', guidance: expect.stringContaining('No candidate rejection, candidate disposition, or project mutation started') } });
      expect(startSpy).not.toHaveBeenCalled();
      expect(acceptSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expect(credentialGet).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
      expect(projects.getProject(project.id)).toEqual(beforeCancellation);
      expect(projects.getJob(sourceJob.id)).toEqual(sourceBeforeCancellation);
      expect(projects.listJobs(joined.actor.id)).toEqual([sourceBeforeCancellation]);
      const reservationProbe = projects.reserveApproval('queued-cancellation-probe');
      expect(reservationProbe).toEqual({ reservationId: expect.stringMatching(/^approval-reservation_/) });
      projects.releaseApprovalReservation(reservationProbe!.reservationId);

      releaseLanes();
      const activeResults = await Promise.all(activeRequests);
      expect(activeResults.every((result) => result.status === 'committed')).toBe(true);
      expect(activeResults.map((result) => result.revision).sort((left, right) => Number(left) - Number(right))).toEqual(Array.from({ length: 4 }, (_, index) => beforeCancellation.revision + index + 1));
      const retainedLyrics = projects.getProject(project.id)!.lyrics;

      const started = await primary.callTool<{ jobId: string; next: { tool: string } }>('generation_manage', { action: 'start', request: generationRequest });
      expect(started).toMatchObject({ jobId: expect.stringMatching(/^generation-job_/), next: { tool: 'job_manage' } });
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy.mock.calls[0][1]).toMatchObject({ id: joined.actor.id, kind: 'agent' });
      expect(credentialGet).toHaveBeenCalledTimes(1);
      expect(providerFetch).not.toHaveBeenCalled();
      await expect(primary.callTool('job_manage', { action: 'inspect', jobId: started.jobId })).resolves.toMatchObject({ id: started.jobId, status: 'waiting-for-user', dependency: { type: 'user-approval' } });
      await expect(primary.callTool('job_manage', { action: 'cancel', jobId: started.jobId })).resolves.toMatchObject({ id: started.jobId, status: 'cancelled' });

      const variation = await primary.callTool<{ jobId: string }>('generation_manage', { action: 'variation', jobId: sourceJob.id, overrides: { seed: 42 } });
      expect(variation).toMatchObject({ jobId: expect.stringMatching(/^generation-job_/) });
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(startSpy.mock.calls[1][0]).toMatchObject({ projectId: project.id, seed: 42, prompt: generationRequest.prompt });
      expect(startSpy.mock.calls[1][1]).toMatchObject({ id: joined.actor.id, kind: 'agent' });
      expect(credentialGet).toHaveBeenCalledTimes(2);
      expect(providerFetch).not.toHaveBeenCalled();
      await expect(primary.callTool('job_manage', { action: 'cancel', jobId: variation.jobId })).resolves.toMatchObject({ id: variation.jobId, status: 'cancelled' });

      const beforeAcceptRevision = projects.getProject(project.id)!.revision;
      await expect(primary.callTool('generation_manage', { action: 'accept', jobId: sourceJob.id, candidateId: candidates[0].id, startTick: 960 })).resolves.toMatchObject({ status: 'committed', revision: beforeAcceptRevision + 1 });
      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(acceptSpy.mock.calls[0][4]).toMatchObject({ id: joined.actor.id, kind: 'agent' });
      const acceptedProject = projects.getProject(project.id)!;
      expect(acceptedProject).toMatchObject({ revision: beforeAcceptRevision + 1, lyrics: retainedLyrics });
      expect(acceptedProject.assets[candidates[0].asset.id]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id, source: 'generation' });
      expect(Object.values(acceptedProject.provenance)).toContainEqual(expect.objectContaining({ assetId: candidates[0].asset.id, createdBy: joined.actor.id, updatedBy: joined.actor.id, provider: 'elevenlabs' }));
      expect(Object.values(acceptedProject.clips)).toContainEqual(expect.objectContaining({ assetId: candidates[0].asset.id, startTick: 960, createdBy: joined.actor.id, updatedBy: joined.actor.id }));
      expect(acceptedProject.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, label: 'Accept generated music', status: 'committed' });
      expect(projects.getJob<GenerationJobResult>(sourceJob.id)!.result).toMatchObject({ acceptedCandidateIds: [candidates[0].id], rejectedCandidateIds: [] });

      await expect(primary.callTool('generation_manage', { action: 'accept', jobId: sourceJob.id, candidateId: candidates[0].id, startTick: 960 })).resolves.toMatchObject({ status: 'duplicate' });
      expect(acceptSpy).toHaveBeenCalledTimes(2);
      expect(projects.getProject(project.id)!.revision).toBe(beforeAcceptRevision + 1);
      expect(projects.getJob<GenerationJobResult>(sourceJob.id)!.result?.acceptedCandidateIds).toEqual([candidates[0].id]);

      await expect(primary.callTool('generation_manage', { action: 'reject', jobId: sourceJob.id, candidateId: candidates[1].id })).resolves.toMatchObject({ result: { rejectedCandidateIds: [candidates[1].id] } });
      await expect(primary.callTool('generation_manage', { action: 'reject', jobId: sourceJob.id, candidateId: candidates[1].id })).resolves.toMatchObject({ result: { rejectedCandidateIds: [candidates[1].id] } });
      expect(rejectSpy).toHaveBeenCalledTimes(2);
      expect(projects.getJob<GenerationJobResult>(sourceJob.id)!.result).toMatchObject({ acceptedCandidateIds: [candidates[0].id], rejectedCandidateIds: [candidates[1].id] });
      expect(projects.getProject(project.id)!.revision).toBe(beforeAcceptRevision + 1);
      expect(providerFetch).not.toHaveBeenCalled();

      await expect(authority.install({
        version: 1, id: 'generation-admission-runtime-policy', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxRuntimeMinutes: 10,
        budget: { currency: 'USD', maxSpendMinor: 1_000, maxGenerationRequests: 4, maxUnknownCostRequests: 4 },
        providers: { elevenlabs: { models: ['music_v1'], enabled: true } }, readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [],
        allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
      })).resolves.toEqual({ installed: true });
      vi.mocked(providerFetch).mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('Cancelled', 'AbortError'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      }));
      const running = await primary.callTool<{ jobId: string }>('generation_manage', { action: 'start', request: generationRequest });
      for (let attempt = 0; attempt < 100 && vi.mocked(providerFetch).mock.calls.length === 0; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(projects.getJob(running.jobId)).toMatchObject({ ownerActorId: joined.actor.id, projectId: project.id, status: 'running' });
      expect((host as unknown as { mutationScheduler: { status(): { active: number; queued: number } } }).mutationScheduler.status()).toMatchObject({ active: 0, queued: 0 });
      const overlapRevision = projects.getProject(project.id)!.revision;
      await expect(primary.callTool('project_apply', {
        projectId: project.id,
        clientOperationId: 'generation-provider-runtime-overlap',
        label: 'Commit while provider runtime remains pending',
        operations: [{ kind: 'lyrics.set', lyrics: 'Provider runtime did not occupy a mutation lane' }],
        commitMode: 'direct',
      })).resolves.toMatchObject({ status: 'committed', revision: overlapRevision + 1 });
      await expect(primary.callTool('job_manage', { action: 'cancel', jobId: running.jobId })).resolves.toMatchObject({ id: running.jobId, status: 'cancelled' });
      expect(audioStart).not.toHaveBeenCalled();
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
      startSpy.mockRestore();
      acceptSpy.mockRestore();
      rejectSpy.mockRestore();
    }
  });

  it('keeps owner cancellation terminal when a provider or candidate-cache write fulfills late', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'generation-late-fulfillment-token';
    const startedHost = await host.start(token);
    expect(startedHost.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const owner = await createClient(startedHost.url, token, 'Generation late-fulfillment owner');
    const foreign = await createClient(startedHost.url, token, 'Generation late-fulfillment observer');
    const project = projects.getActiveProject()!;
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Generation Owner', color: '#8b5cf6', projectId: project.id });
    await foreign.callTool('session_manage', { action: 'join', name: 'Foreign Generation Agent', color: '#06b6d4', projectId: project.id });
    await expect(authority.install({
      version: 1, id: 'generation-late-fulfillment-policy', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxRuntimeMinutes: 10,
      budget: { currency: 'USD', maxSpendMinor: 1_000, maxGenerationRequests: 4, maxUnknownCostRequests: 4 },
      providers: { elevenlabs: { models: ['music_v1'], enabled: true } }, readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [],
      allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    })).resolves.toEqual({ installed: true });

    const beforeGeneration = projects.getProject(project.id)!;
    const lateProviderBytes = Buffer.from('ID3\u0004late-provider-fixture');
    let fulfillProvider!: (response: Response) => void;
    vi.mocked(providerFetch).mockImplementationOnce(() => new Promise<Response>((resolvePromise) => { fulfillProvider = resolvePromise; }));
    const lateProvider = await owner.callTool<{ jobId: string }>('generation_manage', { action: 'start', request: request(project.id) });
    for (let attempt = 0; attempt < 100 && !fulfillProvider; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(projects.getJob(lateProvider.jobId)).toMatchObject({ ownerActorId: joined.actor.id, status: 'running' });

    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: lateProvider.jobId })).resolves.toMatchObject({
      id: lateProvider.jobId,
      status: 'cancelled',
      result: { candidates: [], partial: { provider: { submittedRequests: 1, fulfilledRequests: 0, lateFulfilledRequests: 0 }, candidateCache: 'unchanged', retainedCandidateCount: 0, project: 'unchanged' } },
      next: { guidance: expect.stringContaining('no provider request was retried automatically') },
    });
    expect((vi.mocked(providerFetch).mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: lateProvider.jobId })).resolves.toEqual({ error: 'job_not_found' });

    fulfillProvider(new Response(lateProviderBytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'song-id': 'late-provider-request' } }));
    for (let attempt = 0; attempt < 100 && projects.getJob<GenerationJobResult>(lateProvider.jobId)?.result?.partial?.provider.lateFulfilledRequests !== 1; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    await expect(owner.callTool('job_manage', { action: 'inspect', jobId: lateProvider.jobId })).resolves.toMatchObject({
      id: lateProvider.jobId,
      status: 'cancelled',
      result: { candidates: [], partial: { provider: { submittedRequests: 1, fulfilledRequests: 1, lateFulfilledRequests: 1 }, candidateCache: 'unchanged', retainedCandidateCount: 0, project: 'unchanged' } },
      next: { guidance: expect.stringContaining('fulfilled after cancellation') },
    });
    const lateProviderSha = createHash('sha256').update(lateProviderBytes).digest('hex');
    await expect(access(join(root, 'generation', project.id, `${lateProviderSha}.mp3`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(projects.getProject(project.id)).toEqual(beforeGeneration);
    expect(authority.snapshot().usage).toMatchObject({ generationRequests: 1, unknownCostRequests: 1, spentMinor: 0 });

    type PersistCandidate = (generationRequest: GenerationRequest, raw: unknown, actor: Actor) => Promise<GenerationCandidate>;
    const generationInternals = generation as unknown as { persistCandidate: PersistCandidate };
    const persistCandidate = generationInternals.persistCandidate.bind(generation);
    let reportPersisted!: (candidateValue: GenerationCandidate) => void;
    let releasePersistence!: () => void;
    const persisted = new Promise<GenerationCandidate>((resolvePromise) => { reportPersisted = resolvePromise; });
    const persistenceGate = new Promise<void>((resolvePromise) => { releasePersistence = resolvePromise; });
    const persistSpy = vi.spyOn(generationInternals, 'persistCandidate').mockImplementation(async (generationRequest, raw, actor) => {
      const candidateValue = await persistCandidate(generationRequest, raw, actor); reportPersisted(candidateValue); await persistenceGate; return candidateValue;
    });
    const retainedBytes = Buffer.from('ID3\u0004retained-candidate-fixture');
    vi.mocked(providerFetch).mockResolvedValueOnce(new Response(retainedBytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'song-id': 'retained-candidate-request' } }));
    const lateCandidate = await owner.callTool<{ jobId: string }>('generation_manage', { action: 'start', request: request(project.id) });
    const persistedCandidate = await persisted;
    await expect(access(persistedCandidate.managedPath)).resolves.toBeUndefined();
    expect(projects.getProject(project.id)).toEqual(beforeGeneration);

    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: lateCandidate.jobId })).resolves.toMatchObject({
      id: lateCandidate.jobId,
      status: 'cancelled',
      result: { candidates: [], partial: { provider: { submittedRequests: 1, fulfilledRequests: 1, lateFulfilledRequests: 0 }, candidateCache: 'may-be-partial', retainedCandidateCount: 0, project: 'unchanged' } },
      next: { guidance: expect.stringContaining('any retained effect may remain unconfirmed') },
    });
    await expect(foreign.callTool('generation_manage', { action: 'inspect', jobId: lateCandidate.jobId })).resolves.toEqual({ error: 'generation_job_not_found' });
    await expect(foreign.callTool('generation_manage', { action: 'accept', jobId: lateCandidate.jobId, candidateId: persistedCandidate.id })).resolves.toEqual({ error: 'generation_job_not_found' });

    releasePersistence();
    for (let attempt = 0; attempt < 100 && projects.getJob<GenerationJobResult>(lateCandidate.jobId)?.result?.candidates.length !== 1; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const retainedJob = await owner.callTool<AsyncJob<GenerationJobResult> & { next: { guidance: string } }>('generation_manage', { action: 'inspect', jobId: lateCandidate.jobId });
    expect(retainedJob).toMatchObject({
      id: lateCandidate.jobId,
      status: 'cancelled',
      result: { candidates: [{ id: persistedCandidate.id }], acceptedCandidateIds: [], rejectedCandidateIds: [], partial: { provider: { submittedRequests: 1, fulfilledRequests: 1, lateFulfilledRequests: 0 }, candidateCache: 'retained', retainedCandidateCount: 1, project: 'unchanged' } },
      next: { guidance: expect.stringContaining('later explicit acceptance is a separate project mutation') },
    });
    expect(retainedJob.result!.candidates[0]).toEqual(persistedCandidate);
    expect(projects.getProject(project.id)).toEqual(beforeGeneration);
    expect(authority.snapshot().usage).toMatchObject({ generationRequests: 2, unknownCostRequests: 2, spentMinor: 0 });
    expect(providerFetch).toHaveBeenCalledTimes(2);

    await expect(owner.callTool('generation_manage', { action: 'reject', jobId: lateCandidate.jobId, candidateId: persistedCandidate.id })).resolves.toMatchObject({ status: 'cancelled', result: { acceptedCandidateIds: [], rejectedCandidateIds: [persistedCandidate.id] } });
    expect(projects.getProject(project.id)).toEqual(beforeGeneration);
    const registerSourceSpy = vi.spyOn(projects, 'registerAssetSource');
    const applySpy = vi.spyOn(projects, 'apply');
    await expect(owner.callTool('generation_manage', { action: 'accept', jobId: lateCandidate.jobId, candidateId: persistedCandidate.id })).resolves.toMatchObject({ status: 'committed', revision: beforeGeneration.revision + 1 });
    expect(registerSourceSpy).toHaveBeenCalledWith(persistedCandidate.asset.id, persistedCandidate.managedPath);
    expect(registerSourceSpy.mock.invocationCallOrder[0]).toBeLessThan(applySpy.mock.invocationCallOrder[0]);
    expect(projects.getAssetSource(project.id, persistedCandidate.asset.id)).toBe(persistedCandidate.managedPath);
    const acceptedJob = projects.getJob<GenerationJobResult>(lateCandidate.jobId)!;
    expect(acceptedJob).toMatchObject({ status: 'cancelled', result: { candidates: [{ id: persistedCandidate.id }], acceptedCandidateIds: [persistedCandidate.id], rejectedCandidateIds: [], partial: { candidateCache: 'retained', project: 'unchanged' } } });
    expect(acceptedJob.result!.candidates[0]).toEqual(persistedCandidate);
    const acceptedProject = projects.getProject(project.id)!;
    expect(acceptedProject.assets[persistedCandidate.asset.id]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id, source: 'generation' });
    expect(Object.values(acceptedProject.provenance)).toContainEqual(expect.objectContaining({ assetId: persistedCandidate.asset.id, createdBy: joined.actor.id, updatedBy: joined.actor.id }));
    expect(Object.values(acceptedProject.clips)).toContainEqual(expect.objectContaining({ assetId: persistedCandidate.asset.id, createdBy: joined.actor.id, updatedBy: joined.actor.id }));
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(audioStart).not.toHaveBeenCalled();
  });
});
