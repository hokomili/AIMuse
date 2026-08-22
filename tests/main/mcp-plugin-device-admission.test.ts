import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { createId, entityBase, HUMAN_ACTOR, nowIso, type Actor, type Device, type ProjectTransaction } from '@aimuse/core';
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

interface AdmissionClient {
  initialization: Record<string, unknown>;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

describe('headless MCP plug-in device admission', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let host: McpHost;
  const clients: AdmissionClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-device-admission-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    const authority = new AuthorityManager();
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({ appVersion: 'test', profileId: 'E'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, exports });
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

  it('fairly admits authenticated plug-in parameter, preset, bypass, and remove transactions with queued-only cancellation', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = Buffer.alloc(32, 0x3c).toString('base64url');
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

    const primary = await createClient(startedHost.url, token, 'Plug-in device listener client');
    expect(String(primary.initialization.instructions)).toContain('plug-in parameter, preset, bypass, and remove mutation admission shares those lanes');
    const listed = await primary.rpc<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'plugin_manage')).toMatchObject({
      description: expect.stringContaining('Parameter, preset, bypass, and remove use fair bounded project admission'),
      annotations: { destructiveHint: true, idempotentHint: false },
    });

    const project = projects.getActiveProject()!;
    const track = Object.values(project.tracks).find((value) => value.kind !== 'master');
    if (!track) throw new Error('Expected a non-master fixture track.');
    const device: Device = {
      ...entityBase('device', HUMAN_ACTOR), trackId: track.id, format: 'builtin', builtinKind: 'utility', name: 'Admission Utility',
      bypassed: false, degraded: false, latencySamples: 0,
      parameters: { gain: { id: 'gain', name: 'Gain', value: 0.5, defaultValue: 0.5, min: 0, max: 1, unit: 'linear', automatable: true } },
    };
    const fixtureTransaction: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'plugin-device-admission-fixture', projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Create plug-in admission fixture', createdAt: nowIso(), operations: [{ kind: 'device.add', device }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(fixtureTransaction, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });

    const joined = await primary.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Plug-in Device Agent', color: '#8b5cf6', projectId: project.id });
    const collaboration = await primary.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(collaboration.guidance).toContain('plug-in parameter/preset/bypass/remove actions share those four fair lanes');
    expect(collaboration.guidance).toContain('queued plug-in device cancellation invokes no project transaction');
    expect(collaboration.guidance).toContain('catalog, scan, and authority-gated instantiate keep their separate discovery/job/approval contracts');

    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createClient(startedHost.url, token, `Plug-in lane client ${index + 1}`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Plug-in Lane Agent ${index + 1}`, color: `#0${index + 1}b6d4`, projectId: project.id })));
    const apply = projects.apply.bind(projects);
    let activeLanes = 0;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold plug-in scheduler lane')) {
        activeLanes += 1;
        await laneGate;
      }
      return apply(transaction, actor, skipCheckpoint);
    });
    const pluginTransactions = (): ProjectTransaction[] => applySpy.mock.calls.map(([transaction]) => transaction).filter((transaction) => transaction.clientOperationId.startsWith('plugin-operation_'));
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string; revision?: number }>('project_apply', {
      projectId: project.id,
      clientOperationId: `plugin-device-admission-blocker-${index + 1}`,
      label: `Hold plug-in scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Retained plug-in lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && activeLanes < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(activeLanes).toBe(4);
      const beforeCancellation = projects.getProject(project.id)!;

      const queuedMutations = [
        primary.callTool<Record<string, unknown>>('plugin_manage', { action: 'set-parameter', projectId: project.id, deviceId: device.id, parameterId: 'gain', value: 0.75 }),
        primary.callTool<Record<string, unknown>>('plugin_manage', { action: 'set-preset', projectId: project.id, deviceId: device.id, presetName: 'Cancelled preset' }),
        primary.callTool<Record<string, unknown>>('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: true }),
        primary.callTool<Record<string, unknown>>('plugin_manage', { action: 'remove', projectId: project.id, deviceId: device.id }),
      ];
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ actor: { id: joined.actor.id }, projectId: project.id, queueDepth: 4, status: 'waiting' });
      expect(pluginTransactions()).toEqual([]);

      await expect(primary.callTool('plugin_manage', { action: 'set-parameter', projectId: project.id, deviceId: device.id, parameterId: 'gain', value: 0.8 })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { tool: 'project_observe', arguments: { projectId: project.id }, guidance: expect.stringContaining('No plug-in set-parameter project transaction started') },
      });
      await expect(primary.callTool('plugin_manage', { action: 'catalog' })).resolves.toEqual([]);

      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelled = await Promise.all(queuedMutations);
      expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => (result.scheduler as { code?: string }).code === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => (result.next as { tool?: string }).tool === 'project_observe')).toBe(true);
      expect(cancelled.every((result) => String((result.next as { guidance?: string }).guidance).includes('Re-observe the device and project'))).toBe(true);
      expect(pluginTransactions()).toEqual([]);
      expect(projects.getProject(project.id)).toEqual(beforeCancellation);

      releaseLanes();
      const activeResults = await Promise.all(activeRequests);
      expect(activeResults.every((result) => result.status === 'committed')).toBe(true);
      expect(activeResults.map((result) => result.revision).sort((left, right) => Number(left) - Number(right))).toEqual(Array.from({ length: 4 }, (_, index) => beforeCancellation.revision + index + 1));
      const retainedLyrics = projects.getProject(project.id)!.lyrics;

      const lock = projects.acquireLock({ projectId: project.id, entityIds: [device.id] });
      expect(lock).toMatchObject({ acquired: true, lock: { entityIds: [device.id] } });
      await expect(primary.callTool('plugin_manage', { action: 'set-parameter', projectId: project.id, deviceId: device.id, parameterId: 'gain', value: 0.75 })).resolves.toMatchObject({ status: 'locked', conflict: { entityId: device.id, retryable: true } });
      expect(projects.getProject(project.id)!.devices[device.id].parameters.gain.value).toBe(0.5);
      projects.releaseLock(lock.lockId!);
      expect(projects.snapshot().locks).toEqual([]);

      let revision = projects.getProject(project.id)!.revision;
      await expect(primary.callTool('plugin_manage', { action: 'set-parameter', projectId: project.id, deviceId: device.id, parameterId: 'gain', value: 0.75 })).resolves.toMatchObject({ status: 'committed', revision: ++revision });
      expect(projects.getProject(project.id)!.devices[device.id]).toMatchObject({ revision: 1, updatedBy: joined.actor.id, parameters: { gain: { value: 0.75 } } });

      await expect(primary.callTool('plugin_manage', { action: 'set-preset', projectId: project.id, deviceId: device.id, presetName: 'Admitted preset' })).resolves.toMatchObject({ status: 'committed', revision: ++revision });
      expect(projects.getProject(project.id)!.devices[device.id]).toMatchObject({ revision: 2, updatedBy: joined.actor.id, presetName: 'Admitted preset' });

      await expect(primary.callTool('plugin_manage', { action: 'bypass', projectId: project.id, deviceId: device.id, bypassed: true })).resolves.toMatchObject({ status: 'committed', revision: ++revision });
      expect(projects.getProject(project.id)!.devices[device.id]).toMatchObject({ revision: 3, updatedBy: joined.actor.id, bypassed: true });

      await expect(primary.callTool('plugin_manage', { action: 'remove', projectId: project.id, deviceId: device.id })).resolves.toMatchObject({ status: 'committed', revision: ++revision });
      const removed = projects.getProject(project.id)!;
      expect(removed.devices[device.id]).toBeUndefined();
      expect(removed).toMatchObject({ revision, lyrics: retainedLyrics });
      expect(removed.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, label: `remove: ${device.name}`, status: 'committed' });
      expect(pluginTransactions()).toHaveLength(5);

      await expect(primary.callTool('plugin_manage', { action: 'remove', projectId: project.id, deviceId: device.id })).resolves.toEqual({ error: 'device_not_found' });
      expect(pluginTransactions()).toHaveLength(5);
      expect(audioStart).not.toHaveBeenCalled();
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
    }
  });
});
