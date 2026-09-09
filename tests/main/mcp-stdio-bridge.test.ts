import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentClientSetup } from '../../src/common/agent-clients';
import { EngineRuntime } from '../../src/main/engine-runtime';
import { buildMcpBridgeLaunch } from '../../src/main/mcp-bridge-entry';
import { mcpRuntimeStateLocation, publishMcpRuntimeState, readMcpRuntimeState, type McpRuntimeState } from '../../src/main/mcp-runtime-state';
import { McpStdioBridge } from '../../src/main/mcp-stdio-bridge';
import { profileIdForPath } from '../../src/main/profile-identity';

interface RpcMessage { jsonrpc: '2.0'; id?: string | number; method?: string; result?: Record<string, unknown>; error?: Record<string, unknown> }

class StaticStdioClient {
  readonly messages: RpcMessage[] = [];
  private pending = '';

  constructor(private readonly input: PassThrough, output: PassThrough) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.pending += chunk;
      const lines = this.pending.split(/\r?\n/u);
      this.pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.messages.push(JSON.parse(line) as RpcMessage);
    });
  }

  send(message: JSONRPCMessage): void { this.input.write(`${JSON.stringify(message)}\n`); }

  async response(id: string | number, timeoutMs = 5_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 5));
    }
    throw new Error(`Timed out waiting for stdio MCP response ${String(id)}.`);
  }
}

async function directInitialize(url: string, token: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stale-session-fixture', version: '1' } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
  const sessionId = response.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId!;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bridge test condition.');
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 5));
  }
}

function fakeRuntimeState(profileId: string): McpRuntimeState {
  return {
    version: 1,
    transport: 'streamable-http',
    authorityLifetime: 'engine',
    pid: process.pid,
    instanceId: randomUUID(),
    profileId,
    url: 'http://127.0.0.1:49152/mcp',
    token: Buffer.alloc(32, 0x51).toString('base64url'),
    startedAt: new Date().toISOString(),
  };
}

function healthResponse(state: McpRuntimeState): Response {
  return Response.json({ status: 'ok', pid: state.pid, instanceId: state.instanceId, profileId: state.profileId });
}

function initializeResponse(id: string | number | null, sessionId: string): Response {
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'AIMuse test engine', version: '1' } },
  }, { headers: { 'mcp-session-id': sessionId } });
}

describe('stable AIMuse stdio bridge lifecycle', () => {
  let root: string | undefined;
  let firstRuntime: EngineRuntime | undefined;
  let competingRuntime: EngineRuntime | undefined;
  let secondRuntime: EngineRuntime | undefined;
  let bridge: McpStdioBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    await secondRuntime?.stop();
    await competingRuntime?.stop();
    await firstRuntime?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['running', 'completed'] as const)('preserves an owned job wait beyond two seconds and returns %s on the same session', async (status) => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-bridge-job-wait-'));
    const profileId = profileIdForPath(root);
    firstRuntime = new EngineRuntime({ userDataPath: root, profileId, appVersion: 'test', mode: 'headless' });
    await firstRuntime.start();
    const input = new PassThrough();
    const output = new PassThrough();
    bridge = new McpStdioBridge({ userDataPath: root, expectedProfileId: profileId, input, output, pollMs: 5, log: () => undefined });
    await bridge.start();
    const client = new StaticStdioClient(input, output);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'long-job-wait', version: '1' } } });
    expect(await client.response(1)).not.toHaveProperty('error');
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Long Job Owner' } } });
    const joined = await client.response(2);
    const actorId = (joined.result?.structuredContent as { data: { actor: { id: string } } }).data.actor.id;
    const timestamp = new Date().toISOString();
    const job = {
      id: 'bridge-long-job', ownerActorId: actorId, projectId: firstRuntime.projects.getActiveProject()!.id,
      kind: 'render' as const, status: 'running' as const, progress: 0.4, message: 'Controlled long job',
      createdAt: timestamp, updatedAt: timestamp, cancellable: true,
    };
    firstRuntime.projects.upsertJob(job);
    const finish = status === 'completed' ? setTimeout(() => {
      firstRuntime!.projects.upsertJob({ ...job, status: 'completed', progress: 1, result: { output: 'finished-once' } });
    }, 2_500) : undefined;
    try {
      const started = Date.now();
      client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'wait', jobId: job.id, timeoutMs: 30_000 } } });
      const waited = await client.response(3, 35_000);
      expect(waited.error).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(status === 'completed' ? 2_400 : 30_000);
      expect(waited.result?.structuredContent).toMatchObject({ data: { id: job.id, status } });
      // Re-observation must retain the authenticated owner, not allocate a new session.
      client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'inspect', jobId: job.id } } });
      expect((await client.response(4)).result?.structuredContent).toMatchObject({ data: { id: job.id, status } });
      expect(firstRuntime.projects.getJob(job.id)?.ownerActorId).toBe(actorId);
    } finally {
      clearTimeout(finish);
    }
  }, 45_000);

  it('reports an uncertain timed-out mutation without replaying it or replacing its session', async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-bridge-post-timeout-'));
    const profileId = profileIdForPath(root);
    const state = fakeRuntimeState(profileId);
    await publishMcpRuntimeState(root, state);
    const postSessionIds: string[] = [];
    let writes = 0;
    const fetchImplementation: typeof fetch = async (input, init = {}) => {
      if (new URL(String(input)).pathname === '/health') return healthResponse(state);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const message = JSON.parse(String(init.body)) as RpcMessage;
      postSessionIds.push(new Headers(init.headers).get('mcp-session-id') ?? '');
      if (message.method === 'initialize') return initializeResponse(message.id ?? null, 'slow-engine-session');
      if (message.method === 'tools/call') {
        writes += 1;
        throw new DOMException('Private transport details must not escape.', 'TimeoutError');
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    };
    const input = new PassThrough();
    const output = new PassThrough();
    bridge = new McpStdioBridge({ userDataPath: root, expectedProfileId: profileId, input, output, fetchImplementation, pollMs: 5, log: () => undefined });
    await bridge.start();
    const client = new StaticStdioClient(input, output);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'uncertain-timeout', version: '1' } } });
    await client.response(1);
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project_manage', arguments: { action: 'new', name: 'Only once' } } });
    expect((await client.response(2)).error).toEqual({ code: -32_000, message: 'The AIMuse engine response timed out. The request may still be running; inspect its job or project before retrying.' });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect(await client.response(3)).not.toHaveProperty('error');
    expect(writes).toBe(1);
    expect(postSessionIds).toEqual(['', 'slow-engine-session', 'slow-engine-session']);
  });

  it('uses one no-secret setup before launch and reconnects across fresh engine authority without mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-bridge-'));
    const profileId = profileIdForPath(root);
    const staticSetup = buildAgentClientSetup('generic', buildMcpBridgeLaunch({
      executablePath: '/installed/AIMuse', appPath: '/installed/app.asar', packaged: true, targetProfilePath: root,
    })).setupSnippet;
    const clientConfig = join(root, 'static-client-config.json');
    await writeFile(clientConfig, staticSetup);

    const input = new PassThrough();
    const output = new PassThrough();
    bridge = new McpStdioBridge({ userDataPath: root, expectedProfileId: profileId, input, output, pollMs: 5, log: () => undefined });
    await bridge.start();
    const client = new StaticStdioClient(input, output);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'static-client-fixture', version: '1' } } });
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 25));
    expect(client.messages.some((message) => message.id === 1)).toBe(false);

    firstRuntime = new EngineRuntime({ userDataPath: root, profileId, appVersion: 'test', mode: 'headless' });
    await firstRuntime.start();
    expect(firstRuntime.projects.getMcpInfo()).toMatchObject({ running: true, connectionMode: 'stdio-bridge' });
    expect(await client.response(1)).not.toHaveProperty('error');
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const firstTools = await client.response(2);
    expect(firstTools.error).toBeUndefined();
    expect(JSON.stringify(firstTools.result)).toContain('aimuse_help');

    const firstAuthority = firstRuntime.mcp.connection();
    expect(firstAuthority.url).toBeTruthy();
    const firstState = await readMcpRuntimeState(root, profileId);
    expect(firstState).toMatchObject({ pid: process.pid, instanceId: firstAuthority.instanceId, url: firstAuthority.url, token: firstAuthority.token });
    competingRuntime = new EngineRuntime({ userDataPath: root, profileId, appVersion: 'test', mode: 'headless' });
    await competingRuntime.start();
    expect(competingRuntime.projects.getMcpInfo()).toMatchObject({ running: false, message: expect.stringMatching(/another live AIMuse engine/iu) });
    expect(await readMcpRuntimeState(root, profileId)).toEqual(firstState);
    await competingRuntime.stop();
    competingRuntime = undefined;
    const staleSessionId = await directInitialize(firstAuthority.url!, firstAuthority.token);

    await firstRuntime.stop();
    await expect(access(mcpRuntimeStateLocation(root).path)).rejects.toThrow();

    secondRuntime = new EngineRuntime({ userDataPath: root, profileId, appVersion: 'test', mode: 'headless' });
    await secondRuntime.start();
    const secondAuthority = secondRuntime.mcp.connection();
    expect(secondAuthority.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(secondAuthority.token).not.toBe(firstAuthority.token);
    expect(secondAuthority.instanceId).not.toBe(firstAuthority.instanceId);

    const staleAuthority = await fetch(secondAuthority.url!, {
      method: 'POST', headers: { authorization: `Bearer ${firstAuthority.token}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(staleAuthority.status).toBe(401);
    const staleSession = await fetch(secondAuthority.url!, {
      method: 'POST',
      headers: { authorization: `Bearer ${secondAuthority.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': staleSessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/list', params: {} }),
    });
    expect(staleSession.status).toBe(404);

    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const restartedTools = await client.response(3);
    expect(restartedTools.error).toBeUndefined();
    expect(JSON.stringify(restartedTools.result)).toContain('aimuse_help');

    expect(await readFile(clientConfig, 'utf8')).toBe(staticSetup);
    expect(staticSetup).not.toContain(firstAuthority.token);
    expect(staticSetup).not.toContain(secondAuthority.token);
    expect(staticSetup).not.toContain(firstAuthority.instanceId);
    expect(staticSetup).not.toContain(secondAuthority.instanceId);
    expect(staticSetup).not.toMatch(/https?:|bearer|authorization|token|"pid"/iu);
  }, 15_000);

  it.each(['clean EOF', 'stream error'] as const)('restarts a %s notification stream exactly once on the next same-session message', async (failureMode) => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-bridge-events-'));
    const profileId = profileIdForPath(root);
    const state = fakeRuntimeState(profileId);
    await publishMcpRuntimeState(root, state);
    const eventSessionIds: string[] = [];
    const postSessionIds: string[] = [];
    const logs: string[] = [];
    let eventGets = 0;
    const fetchImplementation: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (url.pathname === '/health') return healthResponse(state);
      if (method === 'GET') {
        eventGets += 1;
        eventSessionIds.push(headers.get('mcp-session-id') ?? '');
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (failureMode === 'clean EOF') controller.close();
            else controller.error(new Error('injected event-stream failure'));
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const message = JSON.parse(String(init.body)) as RpcMessage;
      postSessionIds.push(headers.get('mcp-session-id') ?? '');
      if (message.method === 'initialize') return initializeResponse(message.id ?? null, 'same-engine-session');
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    };

    const input = new PassThrough();
    const output = new PassThrough();
    bridge = new McpStdioBridge({ userDataPath: root, expectedProfileId: profileId, input, output, fetchImplementation, pollMs: 5, log: (message) => logs.push(message) });
    await bridge.start();
    const client = new StaticStdioClient(input, output);
    client.send({ jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'event-recovery-fixture', version: '1' } } });
    await client.response(11);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await waitUntil(() => eventGets === 1 && logs.length === 1);
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 20));
    expect(eventGets).toBe(1);

    client.send({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} });
    await client.response(12);
    await waitUntil(() => eventGets === 2 && logs.length === 2);
    expect(eventGets).toBe(2);
    expect(eventSessionIds).toEqual(['same-engine-session', 'same-engine-session']);
    expect(postSessionIds).toEqual(['', 'same-engine-session', 'same-engine-session']);
  });

  it('deletes a remote session whose deferred initialize completes after close', async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-bridge-close-race-'));
    const profileId = profileIdForPath(root);
    const state = fakeRuntimeState(profileId);
    await publishMcpRuntimeState(root, state);
    let initializeStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { initializeStarted = resolveStarted; });
    let resolveInitialize!: (response: Response) => void;
    const deferredInitialize = new Promise<Response>((resolveResponse) => { resolveInitialize = resolveResponse; });
    const deletedSessions: string[] = [];
    let initializeSignal: AbortSignal | null | undefined;
    const fetchImplementation: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (url.pathname === '/health') return healthResponse(state);
      if (method === 'DELETE') {
        deletedSessions.push(headers.get('mcp-session-id') ?? '');
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(String(init.body)) as RpcMessage;
      if (message.method !== 'initialize') throw new Error('Unexpected close-race request.');
      initializeSignal = init.signal;
      initializeStarted();
      return deferredInitialize;
    };

    const input = new PassThrough();
    const output = new PassThrough();
    bridge = new McpStdioBridge({ userDataPath: root, expectedProfileId: profileId, input, output, fetchImplementation, pollMs: 5, log: () => undefined });
    await bridge.start();
    const client = new StaticStdioClient(input, output);
    client.send({ jsonrpc: '2.0', id: 21, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'close-race-fixture', version: '1' } } });
    await started;
    let closeSettled = false;
    const closing = bridge.close().then(() => { closeSettled = true; });
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 10));
    expect(closeSettled).toBe(false);
    expect(initializeSignal?.aborted).toBe(false);
    resolveInitialize(initializeResponse(21, 'late-created-session'));
    await closing;
    expect(deletedSessions).toEqual(['late-created-session']);
    expect(client.messages.some((message) => message.id === 21)).toBe(false);
  });
});
