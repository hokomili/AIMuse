import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  createId, entityBase, HUMAN_ACTOR, nowIso,
  type Actor, type MediaAsset, type ProjectTransaction,
} from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
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
  initialization: Record<string, unknown>;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

describe('headless MCP media-analysis admission', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let media: MediaManager;
  let host: McpHost;
  const clients: AdmissionClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-media-analysis-admission-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: 'F'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'),
      cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, exports,
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
      initialization: initialized.message?.result as Record<string, unknown>,
      rpc,
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc<ToolCallResult>('tools/call', { name: toolName, arguments: args });
        expect(result.isError).not.toBe(true);
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

  it('fairly admits WAV analysis with zero-effect queued cancellation and literal cache-before-commit failure behavior', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const audioRender = vi.spyOn(audio, 'render');
    const token = Buffer.alloc(32, 0x33).toString('base64url');
    const startedHost = await host.start(token);
    expect(startedHost.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(audioStart).not.toHaveBeenCalled();

    const unauthorized = await fetch(startedHost.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } },
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(projects.getMcpInfo().sessions).toEqual([]);

    const primary = await createClient(startedHost.url, token, 'Media analysis listener client');
    expect(String(primary.initialization.instructions)).toContain('WAV media analysis shares those lanes');
    const listed = await primary.rpc<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'media_manage')).toMatchObject({
      description: expect.stringContaining('WAV analysis uses fair bounded admission'),
      annotations: { idempotentHint: false, openWorldHint: true },
    });

    const project = projects.getActiveProject()!;
    const samples = new Float32Array(4_096);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(2 * Math.PI * 220 * index / 48_000) * 0.2;
    const wav = encodeFloat32Wav([samples], 48_000);
    const sourcePath = join(root, 'analysis-fixture.wav');
    await writeFile(sourcePath, wav);
    const sourceAsset: MediaAsset = {
      ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: 'Analysis fixture.wav', mimeType: 'audio/wav',
      sha256: createHash('sha256').update(wav).digest('hex'), byteLength: wav.byteLength,
      storage: 'managed-cache', externalPath: sourcePath, sampleRate: 48_000, channels: 1,
      durationSamples: samples.length, source: 'import',
    };
    const fixtureTransaction: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'media-analysis-admission-fixture', projectId: project.id,
      actor: HUMAN_ACTOR, label: 'Create media analysis fixture', createdAt: nowIso(),
      operations: [{ kind: 'asset.add', asset: sourceAsset }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(fixtureTransaction, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });
    projects.registerAssetSource(sourceAsset.id, sourcePath);

    const joined = await primary.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Media Analysis Agent', color: '#14b8a6', projectId: project.id });
    const collaboration = await primary.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(collaboration.guidance).toContain('WAV media analysis shares those four fair lanes');
    expect(collaboration.guidance).toContain('queued WAV analysis performs no source read, managed-cache write, or project transaction');
    expect(collaboration.guidance).toContain('Running WAV analysis can leave content-addressed cache outputs before a failed atomic asset-registration transaction');

    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createClient(startedHost.url, token, `Media lane client ${index + 1}`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Media Lane Agent ${index + 1}`, color: `#0${index + 1}b6d4`, projectId: project.id })));
    const apply = projects.apply.bind(projects);
    let activeLanes = 0;
    let failAnalysisCommit = false;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold media scheduler lane')) {
        activeLanes += 1;
        await laneGate;
      }
      if (transaction.label.startsWith('Analyze ') && failAnalysisCommit) {
        failAnalysisCommit = false;
        return { status: 'conflict', message: 'Injected analysis commit failure.', conflict: { retryable: true } };
      }
      return apply(transaction, actor, skipCheckpoint);
    });
    const analyzeSpy = vi.spyOn(media, 'analyze');
    const authorityFile = vi.spyOn(authority, 'file');
    const analysisTransactions = (): ProjectTransaction[] => applySpy.mock.calls.map(([transaction]) => transaction).filter((transaction) => transaction.label.startsWith('Analyze '));
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string; revision?: number }>('project_apply', {
      projectId: project.id,
      clientOperationId: `media-analysis-admission-blocker-${index + 1}`,
      label: `Hold media scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Retained media lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && activeLanes < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(activeLanes).toBe(4);
      const beforeCancellation = projects.getProject(project.id)!;
      const queuedAnalyses = Array.from({ length: 4 }, () => primary.callTool<Record<string, unknown>>('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id }));
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ actor: { id: joined.actor.id }, projectId: project.id, queueDepth: 4, status: 'waiting' });
      expect(analyzeSpy).not.toHaveBeenCalled();

      await expect(primary.callTool('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { tool: 'project_observe', arguments: { projectId: project.id }, guidance: expect.stringContaining('No media analysis source read, managed-cache output, or project transaction started') },
      });

      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelled = await Promise.all(queuedAnalyses);
      expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => String((result.next as { guidance?: string }).guidance).includes('Re-observe the asset and project'))).toBe(true);
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(analysisTransactions()).toEqual([]);
      expect(projects.getProject(project.id)).toEqual(beforeCancellation);
      await expect(access(join(root, 'managed', 'analysis'))).rejects.toThrow();

      releaseLanes();
      const activeResults = await Promise.all(activeRequests);
      expect(activeResults.every((result) => result.status === 'committed')).toBe(true);
      expect(activeResults.map((result) => result.revision).sort((left, right) => Number(left) - Number(right))).toEqual(Array.from({ length: 4 }, (_, index) => beforeCancellation.revision + index + 1));
      const retainedLyrics = projects.getProject(project.id)!.lyrics;

      failAnalysisCommit = true;
      const beforeFailedCommit = projects.getProject(project.id)!;
      const failed = await primary.rpc<ToolCallResult>('tools/call', { name: 'media_manage', arguments: { action: 'analyze', projectId: project.id, assetId: sourceAsset.id } });
      expect(failed.isError).toBe(true);
      expect(failed.content[0]?.text).toContain('Injected analysis commit failure');
      expect(projects.getProject(project.id)).toEqual(beforeFailedCommit);
      const analysisRoot = join(root, 'managed', 'analysis');
      expect(await readdir(analysisRoot)).toHaveLength(3);
      expect(analysisTransactions()).toHaveLength(1);

      const revision = projects.getProject(project.id)!.revision;
      const analyzed = await primary.callTool<{ analysisAssetId: string; waveformAssetId: string; spectrogramAssetId: string }>('media_manage', { action: 'analyze', projectId: project.id, assetId: sourceAsset.id });
      const outputIds = [analyzed.analysisAssetId, analyzed.waveformAssetId, analyzed.spectrogramAssetId];
      const completed = projects.getProject(project.id)!;
      expect(completed).toMatchObject({ revision: revision + 1, lyrics: retainedLyrics });
      expect(outputIds.map((assetId) => completed.assets[assetId])).toEqual(outputIds.map(() => expect.objectContaining({ kind: 'analysis', createdBy: joined.actor.id, updatedBy: joined.actor.id, source: 'system' })));
      expect(completed.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, label: `Analyze ${sourceAsset.name}`, status: 'committed' });
      expect(outputIds.every((assetId) => projects.getAssetSource(project.id, assetId)?.startsWith(analysisRoot))).toBe(true);
      expect(await readdir(analysisRoot)).toHaveLength(3);
      expect(analysisTransactions()).toHaveLength(2);
      expect(analyzeSpy).toHaveBeenCalledTimes(2);
      expect(authorityFile).not.toHaveBeenCalled();
      expect(audioRender).not.toHaveBeenCalled();
      expect(audioStart).not.toHaveBeenCalled();
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
    }
  });
});
