import type { Readable, Writable } from 'node:stream';
import process from 'node:process';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  prepareMcpRuntimeStateRoot,
  readPreparedMcpRuntimeState,
  sameMcpRuntimeAuthority,
  type McpRuntimePrivacyDependencies,
  type McpRuntimeState,
  type PreparedMcpRuntimeStateLocation,
} from './mcp-runtime-state';

const HTTP_CONTROL_TIMEOUT_MS = 2_000;
// job_manage.wait can deliberately hold its response for 30 seconds. Keep
// forwarded requests bounded, with time for admission and response delivery.
const HTTP_REQUEST_TIMEOUT_MS = 35_000;

interface DownstreamSession {
  state: McpRuntimeState;
  sessionId: string;
  events?: AbortController;
}

interface DownstreamResponse {
  messages: JSONRPCMessage[];
  sessionId?: string;
}

export interface McpStdioBridgeOptions {
  userDataPath: string;
  expectedProfileId: string;
  input?: Readable;
  output?: Writable;
  pollMs?: number;
  fetchImplementation?: typeof globalThis.fetch;
  processAlive?: (pid: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  runtimePrivacy?: McpRuntimePrivacyDependencies;
  log?: (message: string) => void;
}

class DownstreamHttpError extends Error {
  constructor(readonly status: number) { super(`AIMuse engine returned HTTP ${status}.`); }
}

class DownstreamTimeoutError extends Error {}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => globalThis.setTimeout(resolveWait, milliseconds));
}

function healthUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = '/health';
  return url.toString();
}

function parseHttpMessages(text: string, contentType: string | null): JSONRPCMessage[] {
  if (!text.trim()) return [];
  if (!contentType?.includes('text/event-stream')) return [parseJSONRPCMessage(JSON.parse(text))];
  const messages: JSONRPCMessage[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (data) messages.push(parseJSONRPCMessage(JSON.parse(data)));
  }
  return messages;
}

function isInitialize(message: JSONRPCMessage): message is JSONRPCRequest {
  return isJSONRPCRequest(message) && message.method === 'initialize';
}

function isInitialized(message: JSONRPCMessage): message is JSONRPCNotification {
  return isJSONRPCNotification(message) && message.method === 'notifications/initialized';
}

function responseMatches(message: JSONRPCMessage, request: JSONRPCRequest): boolean {
  return (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id === request.id;
}

function bridgeErrorMessage(error: unknown): string {
  if (error instanceof DownstreamTimeoutError) return 'The AIMuse engine response timed out. The request may still be running; inspect its job or project before retrying.';
  if (error instanceof DownstreamHttpError && error.status === 401) return 'The engine replaced its MCP authority before the request was accepted.';
  if (error instanceof DownstreamHttpError && error.status === 404) return 'The engine replaced the MCP session before the request was accepted.';
  return 'AIMuse could not establish a private connection to the current engine.';
}

/**
 * Stable stdio facade for a changing engine-scoped HTTP session. The client sees
 * only stdio; engine URL, PID, instance identity, and bearer stay inside AIMuse.
 */
export class McpStdioBridge {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly processAlive: (pid: number) => boolean;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly log: (message: string) => void;
  private transport?: StdioServerTransport;
  private location?: PreparedMcpRuntimeStateLocation;
  private downstream?: DownstreamSession;
  private initializeRequest?: JSONRPCRequest;
  private initializedNotification?: JSONRPCNotification;
  private inboundTail = Promise.resolve();
  private readonly bridgeAbort = new AbortController();
  private lifecycleGeneration = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private finish!: () => void;
  readonly finished: Promise<void>;

  constructor(private readonly options: McpStdioBridgeOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.sleep = options.sleep ?? defaultSleep;
    this.pollMs = options.pollMs ?? 100;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.finished = new Promise((resolveFinished) => { this.finish = resolveFinished; });
  }

  async start(): Promise<void> {
    if (this.transport) throw new Error('AIMuse MCP bridge is already started.');
    this.location = await prepareMcpRuntimeStateRoot(this.options.userDataPath, this.options.runtimePrivacy);
    const transport = new StdioServerTransport(this.input, this.output, { maxBufferSize: 4 * 1024 * 1024 });
    this.transport = transport;
    transport.onerror = () => { this.log('AIMuse MCP bridge received an invalid stdio message.'); };
    transport.onmessage = (message) => {
      this.inboundTail = this.inboundTail.then(() => this.forward(message)).catch(() => undefined);
    };
    const close = () => { void this.close(); };
    this.input.once('end', close);
    this.input.once('close', close);
    await transport.start();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.lifecycleGeneration += 1;
    this.bridgeAbort.abort();
    const transport = this.transport;
    this.transport = undefined;
    if (transport) transport.onmessage = undefined;
    this.closePromise = (async () => {
      await this.inboundTail.catch(() => undefined);
      await this.discardDownstream(true);
      if (transport) await transport.close().catch(() => undefined);
      this.finish();
    })();
    return this.closePromise;
  }

  private async forward(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    const lifecycleGeneration = this.lifecycleGeneration;
    try {
      if (isInitialize(message)) {
        this.initializeRequest = structuredClone(message);
        this.initializedNotification = undefined;
        await this.discardDownstream(true);
        this.assertCurrentLifecycle(lifecycleGeneration);
        const downstream = await this.openSession(message);
        await this.adoptDownstream(downstream.session, lifecycleGeneration);
        for (const response of downstream.messages) await this.transport?.send(response);
        return;
      }
      const session = await this.ensureSession(lifecycleGeneration);
      const response = await this.postWithSafeSessionRetry(session, message, lifecycleGeneration);
      this.assertCurrentLifecycle(lifecycleGeneration);
      if (isInitialized(message)) {
        this.initializedNotification = structuredClone(message);
        if (this.downstream) this.ensureEventStream(this.downstream);
      }
      for (const responseMessage of response.messages) await this.transport?.send(responseMessage);
    } catch (error) {
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return;
      if (isJSONRPCRequest(message)) {
        await this.transport?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: bridgeErrorMessage(error) } });
      } else {
        this.log('AIMuse MCP bridge could not forward a notification to the engine.');
      }
    }
  }

  private async discoverEngine(): Promise<McpRuntimeState> {
    if (!this.location) throw new Error('AIMuse MCP bridge is not started.');
    while (!this.closed) {
      try {
        const state = await readPreparedMcpRuntimeState(this.location, this.options.expectedProfileId, this.options.runtimePrivacy);
        if (state && this.processAlive(state.pid) && await this.healthMatches(state)) {
          const confirmed = await readPreparedMcpRuntimeState(this.location, this.options.expectedProfileId, this.options.runtimePrivacy);
          if (confirmed && sameMcpRuntimeAuthority(confirmed, state)) return state;
        }
      } catch { /* A missing, stale, or invalid run-state never grants authority. */ }
      await this.sleep(this.pollMs);
    }
    throw new Error('AIMuse MCP bridge closed before an engine became ready.');
  }

  private async healthMatches(state: McpRuntimeState): Promise<boolean> {
    try {
      const response = await this.fetchImplementation(healthUrl(state.url), {
        method: 'GET',
        headers: { authorization: `Bearer ${state.token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([this.bridgeAbort.signal, AbortSignal.timeout(HTTP_CONTROL_TIMEOUT_MS)]),
      });
      if (!response.ok) return false;
      const body = await response.json() as Record<string, unknown>;
      return body.status === 'ok' && body.pid === state.pid && String(body.instanceId).toLowerCase() === state.instanceId && String(body.profileId).toUpperCase() === state.profileId;
    } catch { return false; }
  }

  private isCurrentLifecycle(generation: number): boolean {
    return !this.closed && generation === this.lifecycleGeneration;
  }

  private assertCurrentLifecycle(generation: number): void {
    if (!this.isCurrentLifecycle(generation)) throw new Error('AIMuse MCP bridge lifecycle changed.');
  }

  private async adoptDownstream(session: DownstreamSession, generation: number): Promise<void> {
    if (!this.isCurrentLifecycle(generation)) {
      await this.closeRemoteSession(session);
      throw new Error('AIMuse MCP bridge closed while creating an engine session.');
    }
    this.downstream = session;
  }

  private async ensureSession(lifecycleGeneration: number): Promise<DownstreamSession> {
    this.assertCurrentLifecycle(lifecycleGeneration);
    if (!this.initializeRequest) throw new Error('The MCP client must initialize before sending other messages.');
    const state = await this.discoverEngine();
    this.assertCurrentLifecycle(lifecycleGeneration);
    if (this.downstream && sameMcpRuntimeAuthority(this.downstream.state, state)) {
      if (this.initializedNotification) this.ensureEventStream(this.downstream);
      return this.downstream;
    }
    await this.discardDownstream(false);
    this.assertCurrentLifecycle(lifecycleGeneration);
    const opened = await this.openSession(this.initializeRequest, state);
    if (!opened.messages.some((message) => responseMatches(message, this.initializeRequest!))) {
      await this.closeRemoteSession(opened.session);
      throw new Error('The current engine did not complete MCP initialization.');
    }
    await this.adoptDownstream(opened.session, lifecycleGeneration);
    if (this.initializedNotification) {
      await this.post(opened.session, this.initializedNotification);
      this.assertCurrentLifecycle(lifecycleGeneration);
      this.ensureEventStream(opened.session);
    }
    return opened.session;
  }

  private async openSession(initialize: JSONRPCRequest, discovered?: McpRuntimeState): Promise<{ session: DownstreamSession; messages: JSONRPCMessage[] }> {
    const state = discovered ?? await this.discoverEngine();
    const response = await this.post({ state, sessionId: '' }, initialize);
    if (!response.sessionId) throw new Error('The current engine did not issue an MCP session.');
    return { session: { state, sessionId: response.sessionId }, messages: response.messages };
  }

  private async postWithSafeSessionRetry(session: DownstreamSession, message: JSONRPCMessage, lifecycleGeneration: number): Promise<DownstreamResponse> {
    try { return await this.post(session, message); }
    catch (error) {
      if (!(error instanceof DownstreamHttpError) || ![401, 404].includes(error.status)) throw error;
      this.assertCurrentLifecycle(lifecycleGeneration);
      await this.discardDownstream(false);
      const replacement = await this.ensureSession(lifecycleGeneration);
      return this.post(replacement, message);
    }
  }

  private async post(session: DownstreamSession, message: JSONRPCMessage): Promise<DownstreamResponse> {
    const signal = AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImplementation(session.state.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.state.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
        },
        body: JSON.stringify(message),
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new DownstreamHttpError(response.status);
      const text = await response.text();
      return { messages: parseHttpMessages(text, response.headers.get('content-type')), sessionId: response.headers.get('mcp-session-id') ?? undefined };
    } catch (error) {
      // A timeout says nothing about whether an admitted operation completed.
      // Never replay it through the 401/404-only session retry path.
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new DownstreamTimeoutError();
      throw error;
    }
  }

  private ensureEventStream(session: DownstreamSession): void {
    if (this.closed || this.downstream !== session || session.events) return;
    const controller = new AbortController();
    session.events = controller;
    void this.consumeEvents(session, controller).then(
      () => this.eventStreamSettled(session, controller),
      () => this.eventStreamSettled(session, controller),
    );
  }

  private eventStreamSettled(session: DownstreamSession, controller: AbortController): void {
    if (session.events !== controller) return;
    session.events = undefined;
    if (!controller.signal.aborted && this.downstream === session && !this.closed) this.log('AIMuse MCP bridge notification stream closed; it will reconnect on the next client message.');
  }

  private async consumeEvents(session: DownstreamSession, controller: AbortController): Promise<void> {
    const response = await this.fetchImplementation(session.state.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${session.state.token}`, accept: 'text/event-stream', 'mcp-session-id': session.sessionId },
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, this.bridgeAbort.signal]),
    });
    if (!response.ok || !response.body) throw new DownstreamHttpError(response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const consume = async (chunk: string): Promise<void> => {
      pending += chunk;
      const events = pending.split(/\r?\n\r?\n/u);
      pending = events.pop() ?? '';
      for (const event of events) {
        const data = event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && this.downstream === session && !this.closed) await this.transport?.send(parseJSONRPCMessage(JSON.parse(data)));
      }
    };
    while (!controller.signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      await consume(decoder.decode(next.value, { stream: true }));
    }
    await consume(`${decoder.decode()}\n\n`);
  }

  private async discardDownstream(closeRemote: boolean): Promise<void> {
    const session = this.downstream;
    this.downstream = undefined;
    if (!session) return;
    if (closeRemote) await this.closeRemoteSession(session);
    else {
      session.events?.abort();
      session.events = undefined;
    }
  }

  private async closeRemoteSession(session: DownstreamSession): Promise<void> {
    session.events?.abort();
    session.events = undefined;
    await this.fetchImplementation(session.state.url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.state.token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': session.sessionId },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_CONTROL_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}

export async function runMcpStdioBridge(options: McpStdioBridgeOptions): Promise<void> {
  const bridge = new McpStdioBridge(options);
  await bridge.start();
  await bridge.finished;
}
