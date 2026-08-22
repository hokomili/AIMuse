import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { Actor } from '@aimuse/core';
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

describe('headless MCP checkpoint and variant admission', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let host: McpHost;
  const clients: AdmissionClient[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-checkpoint-variant-admission-'));
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
    host = new McpHost({ appVersion: 'test', profileId: 'C'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, exports });
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

  it('fairly admits authenticated checkpoint/variant mutations and cancels queued compound work before any write', async () => {
    const audioStart = vi.spyOn(audio, 'start');
    const token = Buffer.alloc(32, 0x3e).toString('base64url');
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

    const primary = await createClient(startedHost.url, token, 'Checkpoint variant listener client');
    expect(String(primary.initialization.instructions)).toContain('checkpoint/variant project_manage mutation admission shares the same lanes');
    const listed = await primary.rpc<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }>('tools/list', {});
    expect(listed.tools.find((tool) => tool.name === 'project_manage')).toMatchObject({
      description: expect.stringContaining('Checkpoint/variant create, merge, and discard mutations use fair bounded admission'),
      annotations: { idempotentHint: false },
    });

    const project = projects.getActiveProject()!;
    const joined = await primary.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Checkpoint Variant Agent', color: '#8b5cf6', projectId: project.id });
    const collaboration = await primary.callTool<{ guidance: string }>('aimuse_help', { topic: 'collaboration' });
    expect(collaboration.guidance).toContain('checkpoint/variant create/merge/discard actions share those four fair lanes');
    expect(collaboration.guidance).toContain('not idempotent');

    const mergeCandidate = await primary.callTool<{ variantId: string; checkpointId: string }>('project_manage', { action: 'branch', projectId: project.id, name: 'Merge candidate' });
    const discardCandidate = await primary.callTool<{ variantId: string; checkpointId: string }>('project_manage', { action: 'branch', projectId: project.id, name: 'Discard candidate' });
    expect(projects.getProject(project.id)!.variants[mergeCandidate.variantId]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id, status: 'active' });
    expect(projects.getProject(project.id)!.variants[discardCandidate.variantId]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id, status: 'active' });

    await expect(primary.callTool('project_apply', {
      projectId: project.id,
      variantId: mergeCandidate.variantId,
      clientOperationId: 'checkpoint-variant-merge-edit',
      label: 'Prepare merge candidate',
      operations: [{ kind: 'project.rename', name: 'Merged checkpoint variant' }],
      commitMode: 'branch',
    })).resolves.toMatchObject({ status: 'committed' });

    const blockerClients = await Promise.all(Array.from({ length: 4 }, (_, index) => createClient(startedHost.url, token, `Checkpoint lane client ${index + 1}`)));
    await Promise.all(blockerClients.map((client, index) => client.callTool('session_manage', { action: 'join', name: `Checkpoint Lane Agent ${index + 1}`, color: `#0${index + 1}b6d4`, projectId: project.id })));
    const apply = projects.apply.bind(projects);
    let activeLanes = 0;
    let releaseLanes!: () => void;
    const laneGate = new Promise<void>((resolvePromise) => { releaseLanes = resolvePromise; });
    const applySpy = vi.spyOn(projects, 'apply').mockImplementation(async (transaction, actor, skipCheckpoint) => {
      if (transaction.label.startsWith('Hold checkpoint scheduler lane')) {
        activeLanes += 1;
        await laneGate;
      }
      return apply(transaction, actor, skipCheckpoint);
    });
    const checkpointSpy = vi.spyOn(projects, 'createCheckpoint');
    const branchSpy = vi.spyOn(projects, 'createBranch');
    const mergeSpy = vi.spyOn(projects, 'mergeBranch');
    const discardSpy = vi.spyOn(projects, 'discardBranch');
    const activeRequests = blockerClients.map((client, index) => client.callTool<{ status: string; revision?: number }>('project_apply', {
      projectId: project.id,
      clientOperationId: `checkpoint-variant-blocker-${index + 1}`,
      label: `Hold checkpoint scheduler lane ${index + 1}`,
      operations: [{ kind: 'lyrics.set', lyrics: `Retained lane ${index + 1}` }],
      commitMode: 'direct',
    }));

    try {
      for (let attempt = 0; attempt < 100 && activeLanes < 4; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      expect(activeLanes).toBe(4);
      const beforeCancellation = projects.getProject(project.id)!;
      const checkpointFilesBefore = (await readdir(join(root, 'checkpoints'))).sort();

      const queuedMutations = [
        primary.callTool<Record<string, unknown>>('project_manage', { action: 'checkpoint', projectId: project.id, name: 'Cancelled checkpoint' }),
        primary.callTool<Record<string, unknown>>('project_manage', { action: 'branch', projectId: project.id, name: 'Cancelled branch' }),
        primary.callTool<Record<string, unknown>>('project_manage', { action: 'merge', variantId: mergeCandidate.variantId }),
        primary.callTool<Record<string, unknown>>('project_manage', { action: 'discard-branch', variantId: discardCandidate.variantId }),
      ];
      let queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      for (let attempt = 0; attempt < 100 && queuedPresence?.queueDepth !== 4; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        queuedPresence = projects.getMcpInfo().sessions.find((presence) => presence.actor.id === joined.actor.id);
      }
      expect(queuedPresence).toMatchObject({ actor: { id: joined.actor.id }, projectId: project.id, queueDepth: 4, status: 'waiting' });
      expect(checkpointSpy).not.toHaveBeenCalled();
      expect(branchSpy).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(discardSpy).not.toHaveBeenCalled();

      await expect(primary.callTool('project_manage', { action: 'checkpoint', projectId: project.id, name: 'Overflow checkpoint' })).resolves.toMatchObject({
        status: 'busy',
        conflict: { retryable: true, retryAfterMs: expect.any(Number) },
        scheduler: { code: 'actor_queue_full', actorQueueDepth: 4 },
        next: { tool: 'project_observe', arguments: { projectId: project.id }, guidance: expect.stringContaining('not idempotent') },
      });

      await expect(primary.callTool('project_manage', { action: 'compare', variantId: mergeCandidate.variantId })).resolves.toMatchObject({ variantId: mergeCandidate.variantId, conflicts: [] });
      expect(host.cancelQueuedMutations(project.id)).toBe(4);
      const cancelled = await Promise.all(queuedMutations);
      expect(cancelled).toHaveLength(4);
      expect(cancelled.every((result) => result.status === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => (result.scheduler as { code?: string }).code === 'cancelled')).toBe(true);
      expect(cancelled.every((result) => (result.next as { tool?: string }).tool === 'project_observe')).toBe(true);
      expect(cancelled.every((result) => String((result.next as { guidance?: string }).guidance).includes('Re-observe'))).toBe(true);
      expect(checkpointSpy).not.toHaveBeenCalled();
      expect(branchSpy).not.toHaveBeenCalled();
      expect(mergeSpy).not.toHaveBeenCalled();
      expect(discardSpy).not.toHaveBeenCalled();
      expect(projects.getProject(project.id)).toEqual(beforeCancellation);
      expect((await readdir(join(root, 'checkpoints'))).sort()).toEqual(checkpointFilesBefore);

      releaseLanes();
      const activeResults = await Promise.all(activeRequests);
      expect(activeResults.every((result) => result.status === 'committed')).toBe(true);
      expect(activeResults.map((result) => result.revision).sort((left, right) => Number(left) - Number(right))).toEqual(Array.from({ length: 4 }, (_, index) => beforeCancellation.revision + index + 1));
      expect(projects.getProject(project.id)!.revision).toBe(beforeCancellation.revision + 4);
      const retainedLyrics = projects.getProject(project.id)!.lyrics;

      const checkpoint = await primary.callTool<{ checkpointId: string }>('project_manage', { action: 'checkpoint', projectId: project.id, name: 'Admitted checkpoint' });
      expect(checkpointSpy).toHaveBeenCalledTimes(1);
      expect(projects.getProject(project.id)!.checkpoints[checkpoint.checkpointId]).toMatchObject({ name: 'Admitted checkpoint', createdBy: joined.actor.id, updatedBy: joined.actor.id });

      const branch = await primary.callTool<{ variantId: string; checkpointId: string }>('project_manage', { action: 'branch', projectId: project.id, name: 'Admitted branch' });
      expect(branchSpy).toHaveBeenCalledTimes(1);
      expect(checkpointSpy).toHaveBeenCalledTimes(2);
      expect(projects.getProject(project.id)!.variants[branch.variantId]).toMatchObject({ name: 'Admitted branch', createdBy: joined.actor.id, updatedBy: joined.actor.id, status: 'active' });
      expect(projects.getProject(project.id)!.checkpoints[branch.checkpointId]).toMatchObject({ createdBy: joined.actor.id, updatedBy: joined.actor.id });

      await expect(primary.callTool('project_manage', { action: 'merge', variantId: mergeCandidate.variantId })).resolves.toMatchObject({ status: 'committed' });
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(projects.getProject(project.id)).toMatchObject({ name: 'Merged checkpoint variant', lyrics: retainedLyrics });
      expect(projects.getProject(project.id)!.variants[mergeCandidate.variantId]).toMatchObject({ status: 'merged', updatedBy: joined.actor.id });
      expect(projects.getProject(project.id)!.activity.find((entry) => entry.label === 'Merge branch: Merge candidate')).toMatchObject({ actor: { id: joined.actor.id }, status: 'committed' });

      await expect(primary.callTool('project_manage', { action: 'discard-branch', variantId: discardCandidate.variantId })).resolves.toMatchObject({ status: 'committed' });
      expect(discardSpy).toHaveBeenCalledTimes(1);
      expect(projects.getProject(project.id)!.variants[discardCandidate.variantId]).toMatchObject({ status: 'discarded', updatedBy: joined.actor.id });
      expect(projects.getProject(project.id)!.activity.at(-1)).toMatchObject({ actor: { id: joined.actor.id }, label: 'Discard branch: Discard candidate', status: 'committed' });
      expect(audioStart).not.toHaveBeenCalled();
    } finally {
      host.cancelQueuedMutations(project.id);
      releaseLanes();
      await Promise.allSettled(activeRequests);
      applySpy.mockRestore();
      checkpointSpy.mockRestore();
      branchSpy.mockRestore();
      mergeSpy.mockRestore();
      discardSpy.mockRestore();
    }
  });
});
