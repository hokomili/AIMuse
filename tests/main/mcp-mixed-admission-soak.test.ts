import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  createId, entityBase, HUMAN_ACTOR, nowIso,
  type Actor, type AsyncJob, type Device, type MediaAsset, type ProjectOperation, type ProjectTransaction,
} from '@aimuse/core';
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

interface SoakClient {
  actor?: Actor;
  sessionId: string;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

type Family = 'direct' | 'history' | 'checkpoint' | 'generation' | 'plugin' | 'analysis' | 'render' | 'branch';

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((resolvePromise) => { resolve = resolvePromise; }), resolve };
}

function seededOrder(length: number, seed: number): number[] {
  let state = seed >>> 0;
  const values = Array.from({ length }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

describe('authenticated mixed-family fair-scheduler soak', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let media: MediaManager;
  let plugins: PluginManager;
  let generation: GenerationManager;
  let providerFetch: ReturnType<typeof vi.fn>;
  let host: McpHost;
  let sourceAsset: MediaAsset;
  let device: Device;
  let wav: Buffer;
  const clients: SoakClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mixed-admission-soak-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    media = new MediaManager(join(root, 'managed'), projects, authority);
    plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    providerFetch = vi.fn();
    const credentials: ProviderCredentials = {
      get: async () => 'fixture-provider-key',
      set: async () => undefined,
      status: async () => ({ elevenlabs: true, stability: false, lyria: false }),
    };
    generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials, providerFetch as unknown as typeof fetch);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '7'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
      cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports,
    });
    await projects.initialize();
    await plugins.initialize();

    const project = projects.getActiveProject()!;
    const track = Object.values(project.tracks).find((value) => value.kind !== 'master');
    if (!track) throw new Error('Expected a non-master fixture track.');
    device = {
      ...entityBase('device', HUMAN_ACTOR), trackId: track.id, format: 'builtin', builtinKind: 'utility', name: 'Soak Utility',
      bypassed: false, degraded: false, latencySamples: 0,
      parameters: { gain: { id: 'gain', name: 'Gain', value: 0.5, defaultValue: 0.5, min: 0, max: 1, unit: 'linear', automatable: true } },
    };
    const samples = new Float32Array(2_048);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(2 * Math.PI * 220 * index / 48_000) * 0.2;
    wav = encodeFloat32Wav([samples], 48_000);
    const sourcePath = join(root, 'soak-source.wav');
    await writeFile(sourcePath, wav);
    sourceAsset = {
      ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: 'Soak source.wav', mimeType: 'audio/wav',
      sha256: createHash('sha256').update(wav).digest('hex'), byteLength: wav.byteLength,
      storage: 'managed-cache', externalPath: sourcePath, sampleRate: 48_000, channels: 1,
      durationSamples: samples.length, source: 'import',
    };
    const fixture: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'mixed-admission-soak-fixture', projectId: project.id,
      actor: HUMAN_ACTOR, label: 'Create mixed admission soak fixtures', createdAt: nowIso(),
      operations: [{ kind: 'device.add', device }, { kind: 'asset.add', asset: sourceAsset }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(fixture, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });
    projects.registerAssetSource(sourceAsset.id, sourcePath);
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await host.stop();
    await audio.stop();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createClient(url: string, token: string, name: string): Promise<SoakClient> {
    let requestId = 0;
    let closed = false;
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
    const client: SoakClient = {
      sessionId: sessionId!, rpc,
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc<ToolCallResult>('tools/call', { name: toolName, arguments: args });
        expect(result.content).toHaveLength(1);
        return JSON.parse(result.content[0].text!) as T;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! } });
      },
    };
    clients.push(client);
    return client;
  }

  async function joinClients(url: string, token: string, prefix: string, count: number, projectId: string): Promise<SoakClient[]> {
    const values = await Promise.all(Array.from({ length: count }, (_, index) => createClient(url, token, `${prefix} ${index + 1}`)));
    await Promise.all(values.map(async (client, index) => {
      const joined = await client.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: `${prefix} ${index + 1}`, projectId });
      client.actor = joined.actor;
    }));
    return values;
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async function waitForJob(jobId: string, predicate: (job: AsyncJob) => boolean): Promise<AsyncJob> {
    await waitFor(() => Boolean(projects.getJob(jobId) && predicate(projects.getJob(jobId)!)), `job ${jobId}`);
    return projects.getJob(jobId)!;
  }

  function generationRequest(projectId: string): GenerationRequest {
    return {
      projectId, provider: 'elevenlabs', model: 'music_v1', kind: 'music',
      prompt: 'Deterministic fair-scheduler soak fixture', instrumental: true, durationMs: 3_000,
      resultCount: 1, referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', providerOptions: {},
    };
  }

  function createGenerationJob(actor: Actor, projectId: string, suffix: string): { job: AsyncJob<GenerationJobResult>; candidate: GenerationCandidate } {
    const asset: MediaAsset = {
      ...entityBase('asset', actor), kind: 'audio', name: `soak-candidate-${suffix}.mp3`, mimeType: 'audio/mpeg',
      sha256: createHash('sha256').update(suffix).digest('hex'), byteLength: 24,
      storage: 'managed-cache', externalPath: join(root, `candidate-${suffix}.mp3`), sampleRate: 48_000,
      channels: 2, durationSamples: 48_000, source: 'generation',
    };
    const candidate: GenerationCandidate = {
      id: createId('generation-candidate'), asset, managedPath: asset.externalPath!, requestId: `request-${suffix}`,
      providerMetadata: { modelVersion: 'music_v1', fixture: true },
    };
    const timestamp = nowIso();
    const job: AsyncJob<GenerationJobResult> = {
      id: createId('generation-job'), ownerActorId: actor.id, projectId, kind: 'generation', status: 'completed',
      progress: 1, message: 'Fixture generation completed.', createdAt: timestamp, updatedAt: timestamp, cancellable: true,
      result: { request: generationRequest(projectId), candidates: [candidate], acceptedCandidateIds: [], rejectedCandidateIds: [] },
    };
    projects.upsertJob(job);
    return { job, candidate };
  }

  function schedulerStatus(): { active: number; queued: number; queuedCost: number; actors: Record<string, { active: number; queued: number }> } {
    return (host as unknown as { mutationScheduler: { status(): ReturnType<typeof schedulerStatus> } }).mutationScheduler.status();
  }

  it('runs eight seeded mixed-family rounds with queued actor round-robin order, observation bypass, attribution, and contiguous project commits', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'mixed-family-soak-token-0123456789';
    const startedHost = await host.start(token);
    const project = projects.getActiveProject()!;
    const work = await joinClients(startedHost.url, token, 'Soak Work Actor', 4, project.id);
    const blockers = await joinClients(startedHost.url, token, 'Soak Lane Actor', 4, project.id);
    const [observer] = await joinClients(startedHost.url, token, 'Soak Observer', 1, project.id);
    const branch = await work[0].callTool<{ variantId: string }>('project_manage', { action: 'branch', projectId: project.id, name: 'Mixed soak branch' });

    const originalApply = projects.apply.bind(projects);
    const originalUndo = projects.undo.bind(projects);
    const originalCheckpoint = projects.createCheckpoint.bind(projects);
    const originalReject = generation.reject.bind(generation);
    const originalAnalyze = media.analyze.bind(media);
    const originalApplyBranch = projects.applyBranch.bind(projects);
    let blockLabel = '';
    let blockGate = deferred<void>();
    let blockersStarted = 0;
    let currentCycle = -1;
    let starts: Family[] = [];
    let branchActorId = '';
    vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (blockLabel && transaction.label.startsWith(blockLabel)) { blockersStarted += 1; await blockGate.promise; }
      if (currentCycle >= 0 && transaction.label === `Soak cycle ${currentCycle} direct`) starts.push('direct');
      if (currentCycle >= 0 && transaction.clientOperationId.startsWith('plugin-operation_')) starts.push('plugin');
      return originalApply(transaction, actor, skipCheckpoint);
    });
    vi.spyOn(projects, 'undo').mockImplementation(async (projectId, actor) => { if (currentCycle >= 0) starts.push('history'); return originalUndo(projectId, actor); });
    vi.spyOn(projects, 'createCheckpoint').mockImplementation(async (projectId, name, actor, automatic) => { if (currentCycle >= 0) starts.push('checkpoint'); return originalCheckpoint(projectId, name, actor, automatic); });
    vi.spyOn(generation, 'reject').mockImplementation((jobId, candidateId) => { if (currentCycle >= 0) starts.push('generation'); return originalReject(jobId, candidateId); });
    vi.spyOn(media, 'analyze').mockImplementation(async (projectId, assetId, actor) => { if (currentCycle >= 0) starts.push('analysis'); return originalAnalyze(projectId, assetId, actor); });
    vi.spyOn(projects, 'applyBranch').mockImplementation(async (variantId, transaction, actor) => { if (currentCycle >= 0) { starts.push('branch'); branchActorId = actor.id; } return originalApplyBranch(variantId, transaction, actor); });
    vi.spyOn(audio, 'render').mockImplementation(async (_renderProject, destination) => {
      if (currentCycle >= 0) starts.push('render');
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: [] };
    });

    const seeds = [0x18a2_0001, 0x18a2_0002, 0x18a2_0003, 0x18a2_0005, 0x18a2_0008, 0x18a2_000d, 0x18a2_0015, 0x18a2_0022];
    for (let cycle = 0; cycle < seeds.length; cycle += 1) {
      const seed = seeds[cycle];
      const assigned = seededOrder(4, seed).map((index) => work[index]);
      const [directActor, historyActor, checkpointActor, generationActor] = assigned.map((client) => client.actor!);
      const previousName = projects.getProject(project.id)!.name;
      await expect(assigned[1].callTool('project_apply', {
        projectId: project.id, clientOperationId: `soak-history-seed-${cycle}`, label: `Soak cycle ${cycle} history seed`,
        operations: [{ kind: 'project.rename', name: `Soak history target ${cycle}` }], commitMode: 'direct',
      })).resolves.toMatchObject({ status: 'committed' });
      const generationFixture = createGenerationJob(generationActor, project.id, `cycle-${cycle}`);
      const beforeRevision = projects.getProject(project.id)!.revision;
      const bypassed = cycle % 2 === 0;
      const pairs: Array<{ client: SoakClient; first: { name: Family; run(): Promise<Record<string, unknown>> }; second: { name: Family; run(): Promise<Record<string, unknown>> } }> = [
        { client: assigned[0], first: { name: 'direct', run: () => assigned[0].callTool('project_apply', { projectId: project.id, clientOperationId: `soak-direct-${cycle}`, label: `Soak cycle ${cycle} direct`, operations: [{ kind: 'lyrics.set', lyrics: `Seeded lyrics ${cycle}` }], commitMode: 'direct' }) }, second: { name: 'plugin', run: () => assigned[0].callTool('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed }) } },
        { client: assigned[1], first: { name: 'history', run: () => assigned[1].callTool('history_manage', { action: 'undo', projectId: project.id }) }, second: { name: 'analysis', run: () => assigned[1].callTool('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id }) } },
        { client: assigned[2], first: { name: 'checkpoint', run: () => assigned[2].callTool('project_manage', { action: 'checkpoint', projectId: project.id, name: `Soak checkpoint ${cycle}` }) }, second: { name: 'render', run: () => assigned[2].callTool('media_manage', { action: 'audition', projectId: project.id }) } },
        { client: assigned[3], first: { name: 'generation', run: () => assigned[3].callTool('generation_manage', { action: 'reject', jobId: generationFixture.job.id, candidateId: generationFixture.candidate.id }) }, second: { name: 'branch', run: () => assigned[3].callTool('project_apply', { projectId: project.id, variantId: branch.variantId, clientOperationId: `soak-branch-${cycle}`, label: `Soak cycle ${cycle} branch`, operations: [{ kind: 'project.rename', name: `Seeded branch ${cycle}` }], commitMode: 'branch' }) } },
      ];

      blockLabel = `Soak cycle ${cycle} blocker`;
      blockGate = deferred<void>(); blockersStarted = 0; starts = []; currentCycle = cycle; branchActorId = '';
      const blockerRequests = blockers.map((client, index) => client.callTool<Record<string, unknown>>('project_apply', {
        projectId: project.id, clientOperationId: `soak-blocker-${cycle}-${index}`, label: `${blockLabel} ${index}`,
        operations: [{ kind: 'lyrics.set', lyrics: `Blocker ${cycle}-${index}` }], commitMode: 'direct',
      }));
      await waitFor(() => blockersStarted === 4, `four active lanes in cycle ${cycle}`);

      const firstOrder = seededOrder(4, seed ^ 0x9e37_79b9);
      const pending: Array<{ name: Family; promise: Promise<Record<string, unknown>> }> = [];
      // The scheduler rotates actors in their actual first-queued arrival order.
      // Wait for each HTTP submission before issuing the next seed value so this
      // fixture establishes that order rather than assuming transport delivery.
      for (const index of firstOrder) {
        pending.push({ name: pairs[index].first.name, promise: pairs[index].first.run() });
        await waitFor(() => schedulerStatus().actors[pairs[index].client.actor!.id]?.queued === 1, `first queued actor in cycle ${cycle}`);
      }
      const secondOrder = seededOrder(4, seed ^ 0x85eb_ca6b);
      for (const index of secondOrder) {
        pending.push({ name: pairs[index].second.name, promise: pairs[index].second.run() });
        await waitFor(() => schedulerStatus().actors[pairs[index].client.actor!.id]?.queued === 2, `second queued actor in cycle ${cycle}`);
      }
      expect(schedulerStatus()).toMatchObject({ active: 4, queued: 8, queuedCost: 8 });

      const [observed, compared, capabilities, catalog, assets] = await Promise.all([
        observer.callTool<{ project: { id: string } }>('project_observe', { projectId: project.id }),
        observer.callTool<{ variantId: string }>('project_manage', { action: 'compare', variantId: branch.variantId }),
        observer.callTool<unknown[]>('generation_manage', { action: 'capabilities' }),
        observer.callTool<unknown[]>('plugin_manage', { action: 'catalog' }),
        observer.callTool<unknown[]>('media_manage', { action: 'list', projectId: project.id }),
      ]);
      expect(observed.project.id).toBe(project.id);
      expect(compared.variantId).toBe(branch.variantId);
      expect(capabilities.length).toBeGreaterThan(0);
      expect(catalog).toEqual([]);
      expect(assets.length).toBeGreaterThan(0);
      expect(schedulerStatus()).toMatchObject({ active: 4, queued: 8, queuedCost: 8 });

      blockGate.resolve();
      const [blockerResults, actionResults] = await Promise.all([
        Promise.all(blockerRequests),
        Promise.all(pending.map(async ({ name, promise }) => ({ name, result: await promise }))),
      ]);
      expect(blockerResults.every((result) => result.status === 'committed')).toBe(true);
      const results = new Map(actionResults.map(({ name, result }) => [name, result]));
      const renderJobId = String(results.get('render')?.jobId);
      const renderJob = await waitForJob(renderJobId, (job) => job.status === 'completed');
      const expectedStarts = [...firstOrder.map((index) => pairs[index].first.name), ...firstOrder.map((index) => pairs[index].second.name)];
      expect(starts).toEqual(expectedStarts);
      expect(results.get('direct')).toMatchObject({ status: 'committed' });
      expect(results.get('history')).toMatchObject({ status: 'committed' });
      expect(results.get('checkpoint')).toMatchObject({ checkpointId: expect.any(String) });
      expect(results.get('generation')).toMatchObject({ result: { rejectedCandidateIds: [generationFixture.candidate.id] } });
      expect(results.get('plugin')).toMatchObject({ status: 'committed' });
      expect(results.get('analysis')).toMatchObject({ analysisAssetId: expect.any(String), waveformAssetId: expect.any(String), spectrogramAssetId: expect.any(String) });
      expect(results.get('branch')).toMatchObject({ status: 'committed' });

      const completed = projects.getProject(project.id)!;
      expect(completed.revision).toBe(beforeRevision + 11);
      expect(completed.name).toBe(previousName);
      expect(completed.devices[device.id]).toMatchObject({ bypassed, updatedBy: directActor.id });
      const checkpointId = String(results.get('checkpoint')?.checkpointId);
      expect(completed.checkpoints[checkpointId]).toMatchObject({ createdBy: checkpointActor.id, updatedBy: checkpointActor.id });
      const analysisIds = ['analysisAssetId', 'waveformAssetId', 'spectrogramAssetId'].map((field) => String(results.get('analysis')?.[field]));
      expect(analysisIds.map((assetId) => completed.assets[assetId]?.createdBy)).toEqual([historyActor.id, historyActor.id, historyActor.id]);
      const renderAssetId = String((renderJob.result as { assetId?: unknown } | undefined)?.assetId);
      expect(completed.assets[renderAssetId]).toMatchObject({ kind: 'audition', createdBy: checkpointActor.id, updatedBy: checkpointActor.id });
      expect(projects.getJob<GenerationJobResult>(generationFixture.job.id)).toMatchObject({ ownerActorId: generationActor.id, result: { rejectedCandidateIds: [generationFixture.candidate.id] } });
      expect(branchActorId).toBe(generationActor.id);
      expect(completed.activity).toContainEqual(expect.objectContaining({ label: `Soak cycle ${cycle} direct`, actor: expect.objectContaining({ id: directActor.id }) }));
      expect(completed.activity).toContainEqual(expect.objectContaining({ label: `Undo Soak cycle ${cycle} history seed`, actor: expect.objectContaining({ id: historyActor.id }) }));
      expect(completed.activity.filter((entry) => entry.revision > beforeRevision).map((entry) => entry.revision)).toEqual(Array.from({ length: 11 }, (_, index) => beforeRevision + index + 1));
      expect(schedulerStatus()).toMatchObject({ active: 0, queued: 0, queuedCost: 0 });
      currentCycle = -1; blockLabel = '';
    }
    expect(audioStart).not.toHaveBeenCalled();
  }, 30_000);

  it('maps actor/global pressure plus project- and session-scoped mixed cancellation without starting any queued family effect', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'mixed-cancellation-soak-token-0123456789';
    const startedHost = await host.start(token);
    const project = projects.getActiveProject()!;
    const work = await joinClients(startedHost.url, token, 'Cancellation Work Actor', 5, project.id);
    const blockers = await joinClients(startedHost.url, token, 'Cancellation Lane Actor', 4, project.id);
    const branch = await work[0].callTool<{ variantId: string }>('project_manage', { action: 'branch', projectId: project.id, name: 'Cancellation soak branch' });
    await work[0].callTool('project_apply', { projectId: project.id, clientOperationId: 'cancellation-history-seed', label: 'Cancellation history seed', operations: [{ kind: 'project.rename', name: 'Cancellation history target' }], commitMode: 'direct' });
    const generationFixture = createGenerationJob(work[0].actor!, project.id, 'cancellation');

    const originalApply = projects.apply.bind(projects);
    let gate = deferred<void>();
    let blockerPrefix = '';
    let started = 0;
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (blockerPrefix && transaction.label.startsWith(blockerPrefix)) { started += 1; await gate.promise; }
      return originalApply(transaction, actor, skipCheckpoint);
    });
    const undoSpy = vi.spyOn(projects, 'undo');
    const checkpointSpy = vi.spyOn(projects, 'createCheckpoint');
    const rejectSpy = vi.spyOn(generation, 'reject');
    const analyzeSpy = vi.spyOn(media, 'analyze');
    const branchSpy = vi.spyOn(projects, 'applyBranch');
    const renderSpy = vi.spyOn(audio, 'render').mockImplementation(async (_renderProject, destination) => {
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: [] };
    });

    const startBlockers = async (phase: string): Promise<Array<Promise<Record<string, unknown>>>> => {
      gate = deferred<void>(); blockerPrefix = `Soak ${phase} blocker`; started = 0;
      const requests = blockers.map((client, index) => client.callTool<Record<string, unknown>>('project_apply', {
        projectId: project.id, clientOperationId: `${phase}-blocker-${index}`, label: `${blockerPrefix} ${index}`,
        operations: [{ kind: 'lyrics.set', lyrics: `${phase} blocker ${index}` }], commitMode: 'direct',
      }));
      await waitFor(() => started === 4, `${phase} active lanes`);
      return requests;
    };

    let active = await startBlockers('project-cancel');
    const beforeProjectCancellation = projects.getProject(project.id)!;
    const baselines = { undo: undoSpy.mock.calls.length, checkpoint: checkpointSpy.mock.calls.length, reject: rejectSpy.mock.calls.length, analyze: analyzeSpy.mock.calls.length, branch: branchSpy.mock.calls.length, render: renderSpy.mock.calls.length, apply: applySpy.mock.calls.length };
    const actorA = [
      work[0].callTool<Record<string, unknown>>('project_apply', { projectId: project.id, clientOperationId: 'cancel-direct', label: 'Cancelled direct', operations: [{ kind: 'lyrics.set', lyrics: 'must not commit' }], commitMode: 'direct' }),
      work[0].callTool<Record<string, unknown>>('history_manage', { action: 'undo', projectId: project.id }),
      work[0].callTool<Record<string, unknown>>('project_manage', { action: 'checkpoint', projectId: project.id, name: 'Cancelled checkpoint' }),
      work[0].callTool<Record<string, unknown>>('generation_manage', { action: 'reject', jobId: generationFixture.job.id, candidateId: generationFixture.candidate.id }),
    ];
    await waitFor(() => schedulerStatus().actors[work[0].actor!.id]?.queued === 4, 'actor queue saturation');
    await expect(work[0].callTool('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: true })).resolves.toMatchObject({
      status: 'busy', scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
      next: { guidance: expect.stringContaining('No plug-in bypass project transaction started') },
    });
    const actorB = [
      work[1].callTool<Record<string, unknown>>('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: true }),
      work[1].callTool<Record<string, unknown>>('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id }),
      work[1].callTool<Record<string, unknown>>('media_manage', { action: 'audition', projectId: project.id }),
      work[1].callTool<Record<string, unknown>>('project_apply', { projectId: project.id, variantId: branch.variantId, clientOperationId: 'cancel-branch', label: 'Cancelled branch', operations: [{ kind: 'project.rename', name: 'must not reach branch' }], commitMode: 'branch' }),
    ];
    await waitFor(() => schedulerStatus().actors[work[1].actor!.id]?.queued === 4, 'second mixed actor queue');
    expect(host.cancelQueuedMutations(project.id)).toBe(8);
    const cancelled = await Promise.all([...actorA, ...actorB]);
    expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
    expect(cancelled[0]).toMatchObject({ next: { guidance: expect.stringContaining('Re-observe the project before deciding whether to submit the cancelled intent again') } });
    expect(cancelled[1]).toMatchObject({ next: { guidance: expect.stringContaining('No undo mutation started') } });
    expect(cancelled[2]).toMatchObject({ next: { guidance: expect.stringContaining('No checkpoint creation started') } });
    expect(cancelled[3]).toMatchObject({ next: { guidance: expect.stringContaining('No candidate rejection, candidate disposition, or project mutation started') } });
    expect(cancelled[4]).toMatchObject({ next: { guidance: expect.stringContaining('No plug-in bypass project transaction started') } });
    expect(cancelled[5]).toMatchObject({ next: { guidance: expect.stringContaining('No media analysis source read, managed-cache output, or project transaction started') } });
    expect(cancelled[6]).toMatchObject({ next: { guidance: expect.stringContaining('No audition render job, cache output, or project transaction started') } });
    expect(cancelled[7]).toMatchObject({ next: { guidance: expect.stringContaining('Re-observe the project before deciding whether to submit the cancelled intent again') } });
    expect(projects.getProject(project.id)).toEqual(beforeProjectCancellation);
    expect({ undo: undoSpy.mock.calls.length, checkpoint: checkpointSpy.mock.calls.length, reject: rejectSpy.mock.calls.length, analyze: analyzeSpy.mock.calls.length, branch: branchSpy.mock.calls.length, render: renderSpy.mock.calls.length, apply: applySpy.mock.calls.length }).toEqual(baselines);
    gate.resolve(); await Promise.all(active);

    active = await startBlockers('global-pressure');
    const beforeGlobalCancellation = projects.getProject(project.id)!;
    const heavyOperations: ProjectOperation[] = Array.from({ length: 512 }, (_, index) => ({ kind: 'lyrics.set', lyrics: `Cancelled global operation ${index}` }));
    const globallyQueued = work.slice(0, 4).map((client, index) => client.callTool<Record<string, unknown>>('project_apply', {
      projectId: project.id, clientOperationId: `global-pressure-${index}`, label: `Cancelled global pressure ${index}`,
      operations: heavyOperations, commitMode: 'direct',
    }));
    await waitFor(() => schedulerStatus().queuedCost === 2_048, 'global queued cost 2048');
    await expect(work[4].callTool('media_manage', { action: 'audition', projectId: project.id })).resolves.toMatchObject({
      status: 'busy', scheduler: { code: 'global_queue_full', globalQueueDepth: 4 },
      next: { guidance: expect.stringContaining('No audition render job, cache output, or project transaction started') },
    });
    await expect(work[4].callTool('media_manage', { action: 'list', projectId: project.id })).resolves.toEqual(expect.any(Array));
    expect(host.cancelQueuedMutations(project.id)).toBe(4);
    expect((await Promise.all(globallyQueued)).every((result) => result.status === 'cancelled')).toBe(true);
    expect(projects.getProject(project.id)).toEqual(beforeGlobalCancellation);
    gate.resolve(); await Promise.all(active);

    const [closing] = await joinClients(startedHost.url, token, 'Closing Session Actor', 1, project.id);
    await closing.callTool('project_apply', { projectId: project.id, clientOperationId: 'session-cancel-history-seed', label: 'Session cancellation history seed', operations: [{ kind: 'project.rename', name: 'Session cancellation target' }], commitMode: 'direct' });
    active = await startBlockers('session-cancel');
    const beforeSessionCancellation = projects.getProject(project.id)!;
    const sessionBaselines = { undo: undoSpy.mock.calls.length, analyze: analyzeSpy.mock.calls.length, render: renderSpy.mock.calls.length };
    const closingRequests = [
      closing.callTool<Record<string, unknown>>('history_manage', { action: 'undo', projectId: project.id }),
      closing.callTool<Record<string, unknown>>('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id }),
      closing.callTool<Record<string, unknown>>('media_manage', { action: 'audition', projectId: project.id }),
    ];
    const closingSettlements = Promise.allSettled(closingRequests);
    await waitFor(() => schedulerStatus().actors[closing.actor!.id]?.queued === 3, 'closing session queue');
    await closing.close();
    await waitFor(() => !schedulerStatus().actors[closing.actor!.id], 'closing session scheduler removal');
    const closedSettlements = await closingSettlements;
    for (const settlement of closedSettlements) if (settlement.status === 'fulfilled') expect(settlement.value).toMatchObject({ status: 'cancelled' });
    expect(projects.getProject(project.id)).toEqual(beforeSessionCancellation);
    expect({ undo: undoSpy.mock.calls.length, analyze: analyzeSpy.mock.calls.length, render: renderSpy.mock.calls.length }).toEqual(sessionBaselines);
    expect(projects.getMcpInfo().sessions.some((presence) => presence.actor.id === closing.actor!.id)).toBe(false);
    gate.resolve(); await Promise.all(active);
    expect(schedulerStatus()).toMatchObject({ active: 0, queued: 0, queuedCost: 0 });
    expect(audioStart).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps human locks authoritative and does not starve attributed commits while injected generation and render jobs remain pending', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'mixed-pending-jobs-soak-token-0123456789';
    const startedHost = await host.start(token);
    const project = projects.getActiveProject()!;
    const work = await joinClients(startedHost.url, token, 'Pending Job Work Actor', 4, project.id);
    await expect(authority.install({
      version: 1, id: 'mixed-soak-generation-policy', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxRuntimeMinutes: 10,
      budget: { currency: 'USD', maxSpendMinor: 1_000, maxGenerationRequests: 4, maxUnknownCostRequests: 4 },
      providers: { elevenlabs: { models: ['music_v1'], enabled: true } }, readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [],
      allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    })).resolves.toEqual({ installed: true });

    const providerStarted = deferred<void>();
    providerFetch.mockImplementation((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      providerStarted.resolve();
      const abort = (): void => reject(new DOMException('Cancelled', 'AbortError'));
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    }));
    const renderStarted = deferred<void>();
    const renderGate = deferred<void>();
    vi.spyOn(audio, 'render').mockImplementation(async (_renderProject, destination) => {
      renderStarted.resolve(); await renderGate.promise;
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, wav);
      return { destination, durationSamples: 2_048, warnings: ['injected pending render'] };
    });

    const generationJob = await work[0].callTool<{ jobId: string }>('generation_manage', { action: 'start', request: generationRequest(project.id) });
    const renderJob = await work[1].callTool<{ jobId: string }>('media_manage', { action: 'audition', projectId: project.id });
    await Promise.all([providerStarted.promise, renderStarted.promise]);
    expect(projects.getJob(generationJob.jobId)).toMatchObject({ ownerActorId: work[0].actor!.id, status: 'running' });
    expect(projects.getJob(renderJob.jobId)).toMatchObject({ ownerActorId: work[1].actor!.id, status: 'running' });
    expect(schedulerStatus()).toMatchObject({ active: 0, queued: 0, queuedCost: 0 });
    await expect(work[2].callTool('job_manage', { action: 'inspect', jobId: generationJob.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(work[2].callTool('job_manage', { action: 'inspect', jobId: renderJob.jobId })).resolves.toEqual({ error: 'job_not_found' });

    const lockedValue = projects.getProject(project.id)!.devices[device.id].bypassed;
    const lock = projects.acquireLock({ projectId: project.id, entityIds: [device.id] });
    expect(lock).toMatchObject({ acquired: true, lock: { entityIds: [device.id] } });
    await expect(work[0].callTool('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: !lockedValue })).resolves.toMatchObject({
      status: 'locked', conflict: { entityId: device.id, retryable: true },
    });
    expect(projects.getProject(project.id)!.devices[device.id].bypassed).toBe(lockedValue);
    const observedLock = await work[3].callTool<{ editor: { locks: Array<{ id: string }> } }>('project_observe', { projectId: project.id, includeEditor: true });
    expect(observedLock.editor.locks).toContainEqual(expect.objectContaining({ id: lock.lockId }));
    const beforeCommits = projects.getProject(project.id)!.revision;
    await expect(work[1].callTool('project_apply', { projectId: project.id, clientOperationId: 'pending-jobs-unrelated-lock', label: 'Unrelated edit during human lock', operations: [{ kind: 'lyrics.set', lyrics: 'Human lock did not block unrelated work' }], commitMode: 'direct' })).resolves.toMatchObject({ status: 'committed', revision: beforeCommits + 1 });
    projects.releaseLock(lock.lockId!);
    await expect(work[0].callTool('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: !lockedValue })).resolves.toMatchObject({ status: 'committed', revision: beforeCommits + 2 });
    expect(projects.getProject(project.id)!.devices[device.id]).toMatchObject({ bypassed: !lockedValue, updatedBy: work[0].actor!.id });

    let expectedRevision = beforeCommits + 2;
    for (let round = 0; round < 6; round += 1) {
      const batch = work.map((client, index) => client.callTool<{ status: string; revision: number }>('project_apply', {
        projectId: project.id, clientOperationId: `pending-job-soak-${round}-${index}`, label: `Pending job soak ${round}-${index}`,
        operations: [{ kind: 'lyrics.set', lyrics: `Pending job soak ${round}-${index}` }], commitMode: 'direct',
      }));
      const results = await Promise.all(batch);
      expect(results.every((result) => result.status === 'committed')).toBe(true);
      expect(results.map((result) => result.revision).sort((left, right) => left - right)).toEqual(Array.from({ length: 4 }, () => ++expectedRevision));
      expect(schedulerStatus()).toMatchObject({ active: 0, queued: 0, queuedCost: 0 });
    }
    const completed = projects.getProject(project.id)!;
    expect(completed.revision).toBe(beforeCommits + 26);
    for (let round = 0; round < 6; round += 1) for (let index = 0; index < work.length; index += 1) {
      expect(completed.activity).toContainEqual(expect.objectContaining({ label: `Pending job soak ${round}-${index}`, actor: expect.objectContaining({ id: work[index].actor!.id }) }));
    }
    await expect(work[3].callTool('generation_manage', { action: 'capabilities' })).resolves.toEqual(expect.any(Array));
    await expect(work[3].callTool('plugin_manage', { action: 'catalog' })).resolves.toEqual([]);
    await expect(work[3].callTool('media_manage', { action: 'list', projectId: project.id })).resolves.toEqual(expect.any(Array));
    expect(projects.getJob(generationJob.jobId)?.status).toBe('running');
    expect(projects.getJob(renderJob.jobId)?.status).toBe('running');

    await expect(work[0].callTool('job_manage', { action: 'cancel', jobId: generationJob.jobId })).resolves.toMatchObject({ id: generationJob.jobId, status: 'cancelled' });
    const renderCancellation = await work[1].callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: renderJob.jobId });
    expect(renderCancellation).toMatchObject({ id: renderJob.jobId, status: 'cancelled', next: { tool: 'job_manage', guidance: expect.stringContaining('does not preempt the running render') } });
    renderGate.resolve();
    const settledRender = await waitForJob(renderJob.jobId, (job) => job.status === 'cancelled' && job.cancellable === false);
    expect(settledRender).toMatchObject({ result: { warnings: ['injected pending render'], partial: { cache: 'retained', project: 'unchanged' } } });
    const settledGeneration = await waitForJob(generationJob.jobId, (job) => job.status === 'cancelled' && job.message.includes('submitted provider request'));
    expect(settledGeneration).toMatchObject({ ownerActorId: work[0].actor!.id, status: 'cancelled' });
    expect(projects.getProject(project.id)!.revision).toBe(beforeCommits + 26);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(audioStart).not.toHaveBeenCalled();
  }, 30_000);
});
