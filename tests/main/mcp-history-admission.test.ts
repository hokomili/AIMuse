import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';
import { createId, type Actor } from '@aimuse/core';
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

interface AdmissionClient {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

interface HttpClient extends AdmissionClient {
  initialization: Record<string, unknown>;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

interface RpcResultMessage {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

describe('headless MCP history admission', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let host: McpHost;
  const clients: AdmissionClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-history-admission-'));
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
    host = new McpHost({ appVersion: 'test', profileId: 'B'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports });
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

  async function createMemoryClient(name: string, color: string): Promise<AdmissionClient> {
    const actor: Actor = { id: createId('agent'), kind: 'agent', name, color };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const session = { actor, mcp: undefined as unknown as McpServer, transport: serverTransport, resourceSubscriptions: new Set<string>() };
    const server = (host as unknown as { buildServer(value: unknown): McpServer }).buildServer(session);
    session.mcp = server;

    let requestId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
    clientTransport.onmessage = (message: JSONRPCMessage) => {
      if (!('id' in message) || !('result' in message || 'error' in message) || typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      const response = message as RpcResultMessage;
      if (response.error) waiter.reject(new Error(`${response.error.code}: ${response.error.message}`));
      else waiter.resolve(response.result);
    };
    clientTransport.onerror = (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    await server.connect(serverTransport);
    await clientTransport.start();

    const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      requestId += 1;
      const response = new Promise<unknown>((resolvePromise, reject) => { pending.set(requestId, { resolve: resolvePromise, reject }); });
      await clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
      return response;
    };
    await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `${name} in-memory client`, version: '1' } });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const client: AdmissionClient = {
      callTool: async <T>(toolName: string, args: Record<string, unknown>): Promise<T> => {
        const result = await rpc('tools/call', { name: toolName, arguments: args }) as { content: Array<{ type: string; text?: string }> };
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
        return JSON.parse(result.content[0].text!) as T;
      },
      close: async () => { await server.close(); },
    };
    clients.push(client);
    return client;
  }

  async function createHttpClient(url: string, token: string, name: string): Promise<HttpClient> {
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

    const initialized = await request({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name, version: '1' } } });
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
    const client: HttpClient = {
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

  async function exerciseHistoryAdmission(historyClient: AdmissionClient, createBlocker: (name: string, color: string) => Promise<AdmissionClient>, prefix: string): Promise<void> {
    const project = projects.getActiveProject()!;
    const initialName = project.name;
    const joined = await historyClient.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'History Agent', color: '#8b5cf6', projectId: project.id });
    await expect(historyClient.callTool('project_apply', {
      projectId: project.id,
      clientOperationId: `${prefix}-history-admission-rename`,
      label: 'History admission rename',
      operations: [{ kind: 'project.rename', name: 'Queued history target' }],
      commitMode: 'direct',
    })).resolves.toMatchObject({ status: 'committed', revision: 1 });

    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createBlocker(`Lane Agent ${index + 1}`, `#0${index + 1}b6d4`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Lane Agent ${index + 1}`, color: `#0${index + 1}b6d4`, projectId: project.id })));
    const apply = projects.apply.bind(projects);
    let started = 0;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold scheduler lane')) {
        started += 1;
        await laneGate;
      }
      return apply(transaction, actor, skipCheckpoint);
    });
    const undoSpy = vi.spyOn(projects, 'undo');
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string }>('project_apply', {
      projectId: project.id,
      clientOperationId: `${prefix}-history-admission-blocker-${index + 1}`,
      label: `Hold scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && started < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(started).toBe(4);

      const queuedHistory = Array.from({ length: 4 }, () => historyClient.callTool<Record<string, unknown>>('history_manage', { action: 'undo', projectId: project.id }));
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ actor: { id: joined.actor.id }, projectId: project.id, queueDepth: 4, status: 'waiting' });
      expect(undoSpy).not.toHaveBeenCalled();
      expect(projects.getProject(project.id)).toMatchObject({ revision: 1, name: 'Queued history target' });

      await expect(historyClient.callTool('history_manage', { action: 'undo', projectId: project.id })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { tool: 'project_observe', arguments: { projectId: project.id }, guidance: expect.stringContaining('not idempotent') },
      });

      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelledHistory = await Promise.all(queuedHistory);
      expect(cancelledHistory).toHaveLength(4);
      expect(cancelledHistory.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelledHistory.every((result) => (result.scheduler as { code?: string }).code === 'cancelled')).toBe(true);
      expect(cancelledHistory.every((result) => (result.next as { tool?: string }).tool === 'project_observe')).toBe(true);
      expect(cancelledHistory.every((result) => String((result.next as { guidance?: string }).guidance).includes('Re-observe'))).toBe(true);
      expect(undoSpy).not.toHaveBeenCalled();
      expect(projects.getProject(project.id)).toMatchObject({ revision: 1, name: 'Queued history target' });

      releaseLanes();
      expect((await Promise.all(activeRequests)).every((result) => result.status === 'committed')).toBe(true);
      expect(projects.getProject(project.id)).toMatchObject({ revision: 5, name: 'Queued history target' });
      const retainedLyrics = projects.getProject(project.id)!.lyrics;

      await expect(historyClient.callTool('history_manage', { action: 'undo', projectId: project.id })).resolves.toMatchObject({ status: 'committed', revision: 6 });
      expect(projects.getProject(project.id)).toMatchObject({ name: initialName, lyrics: retainedLyrics });
      expect(projects.getProject(project.id)!.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, status: 'undo' });

      await expect(historyClient.callTool('history_manage', { action: 'redo', projectId: project.id })).resolves.toMatchObject({ status: 'committed', revision: 7 });
      expect(projects.getProject(project.id)).toMatchObject({ name: 'Queued history target', lyrics: retainedLyrics });
      expect(projects.getProject(project.id)!.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, status: 'redo' });
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
      undoSpy.mockRestore();
    }
  }

  it('cancels queued undo before start in memory, retains active commits, and later preserves attributed undo/redo', async () => {
    const historyClient = await createMemoryClient('History Agent', '#8b5cf6');
    await exerciseHistoryAdmission(historyClient, createMemoryClient, 'memory');
  });

  it('proves authenticated listener-backed history admission without starting audio', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = 'history-listener-token-0123456789';
    const started = await host.start(token);
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(audioStart).not.toHaveBeenCalled();

    const unauthorized = await fetch(started.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    expect(projects.getMcpInfo().sessions).toEqual([]);

    const historyClient = await createHttpClient(started.url, token, 'History listener client');
    expect(String(historyClient.initialization.instructions)).toContain('project_apply and history_manage mutation admission is fair and bounded');
    const listed = await historyClient.rpc<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'history_manage')).toMatchObject({
      description: expect.stringContaining('History actions are not idempotent.'),
      annotations: { idempotentHint: false },
    });
    const collaboration = await historyClient.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(collaboration.guidance).toContain('project_apply and actor undo/redo share four fair lanes');
    expect(collaboration.guidance).toContain('not idempotent');

    await exerciseHistoryAdmission(historyClient, (name) => createHttpClient(started.url, token, `${name} listener client`), 'listener');
    expect(audioStart).not.toHaveBeenCalled();
  });
});
