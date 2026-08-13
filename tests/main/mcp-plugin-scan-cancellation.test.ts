import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { type Actor, type AsyncJob, type AuthorityPolicy, type PluginDescriptor } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
import { GenerationManager, type ProviderCredentials } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { McpHost } from '../../src/main/mcp-host';
import { MediaManager } from '../../src/main/media-manager';
import { PluginManager, type PluginScanJobResult, type PluginScannerOutput } from '../../src/main/plugin-manager';
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolvePromise!: (value: T) => void; let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('headless authenticated plug-in scan terminality', () => {
  let root: string;
  let audio: AudioEngineController;
  let audioStart: ReturnType<typeof vi.spyOn>;
  let projects: ProjectService;
  let plugins: PluginManager;
  let host: McpHost;
  let url: string;
  let firstCandidate: string;
  let lastCandidate: string;
  let findCandidates: ReturnType<typeof vi.fn<(roots: string[]) => Promise<string[]>>>;
  let scanModule: ReturnType<typeof vi.fn<(executable: string, pluginPath: string, timeoutMs: number) => Promise<PluginScannerOutput[]>>>;
  let persistCatalog: ReturnType<typeof vi.fn<(catalogPath: string, payload: string) => Promise<void>>>;
  const token = 'plugin-scan-cancellation-token-0123456789';
  const clients: TestClient[] = [];
  const retainedPlugin: PluginDescriptor = {
    id: 'clap:retained-catalog', format: 'clap', name: 'Retained Catalog Plug-in', vendor: 'Fixture', version: '1',
    path: '/fixture/retained.clap', sha256: 'a'.repeat(64), categories: ['Fx'], instrument: false, quarantined: false, parameters: [],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-plugin-scan-cancellation-'));
    firstCandidate = join(root, 'first.clap'); lastCandidate = join(root, 'last.clap');
    await writeFile(firstCandidate, 'first injected candidate\n'); await writeFile(lastCandidate, 'last injected candidate\n');
    await chmod(firstCandidate, 0o755); await chmod(lastCandidate, 0o755);
    const catalogPath = join(root, 'plugins.json');
    await writeFile(catalogPath, `${JSON.stringify({ version: 1, scannedAt: new Date(0).toISOString(), plugins: [retainedPlugin], quarantine: [] }, null, 2)}\n`);
    audio = new AudioEngineController(); audioStart = vi.spyOn(audio, 'start');
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    const authority = new AuthorityManager();
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'plugin-scan-cancellation-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      budget: { currency: 'USD', maxSpendMinor: 0, maxGenerationRequests: 0, maxUnknownCostRequests: 0 }, providers: {}, readRoots: [root], writeRoots: [], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    findCandidates = vi.fn(async () => []);
    scanModule = vi.fn(async () => []);
    persistCatalog = vi.fn(async (path, payload) => { await writeFile(path, payload); });
    plugins = new PluginManager(catalogPath, 'injected-scanner-never-executed', projects, authority, {
      scannerAvailable: async () => true, findCandidates, scanModule, persistCatalog,
    });
    const credentials: ProviderCredentials = {
      get: async () => undefined,
      set: async () => undefined,
      status: async () => ({ elevenlabs: false, stability: false, lyria: false }),
    };
    const generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({
      appVersion: 'test', profileId: '7'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'),
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

  async function waitForJob(jobId: string, predicate: (job: AsyncJob<PluginScanJobResult>) => boolean): Promise<AsyncJob<PluginScanJobResult>> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = projects.getJob<PluginScanJobResult>(jobId); if (job && predicate(job)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    throw new Error(`Timed out waiting for plug-in scan job ${jobId}.`);
  }

  async function joinedClients(): Promise<{ owner: TestClient; foreign: TestClient; actor: Actor }> {
    const owner = await createClient('Plug-in scan owner'); const foreign = await createClient('Plug-in scan foreign');
    const joined = await owner.callTool<{ actor: Actor }>('session_manage', { action: 'join', name: 'Plug-in Scan Owner' });
    await foreign.callTool('session_manage', { action: 'join', name: 'Plug-in Scan Foreign' }); return { owner, foreign, actor: joined.actor };
  }

  it('keeps an empty-result scan cancelled with the old catalog, while an uncancelled empty scan replaces it exactly', async () => {
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unauthorized', version: '1' } } }),
    });
    expect(unauthorized.status).toBe(401);
    const { owner, foreign, actor } = await joinedClients();
    const tools = await owner.rpc<{ tools: Array<{ name: string; description?: string }> }>('tools/list', {});
    expect(tools.tools.find((tool) => tool.name === 'plugin_manage')?.description).toContain('Scan returns a jobId');
    const discovery = deferred<string[]>(); findCandidates.mockImplementationOnce(() => discovery.promise);
    const queued = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'scan', roots: [root] });
    await waitForJob(queued.jobId, (job) => job.status === 'running' && job.result?.partial.discovery === 'may-have-completed');
    expect(projects.getJob(queued.jobId)).toMatchObject({ ownerActorId: actor.id, kind: 'plugin-scan' });
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(foreign.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    await expect(owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId })).resolves.toMatchObject({
      status: 'cancelled',
      result: { partial: { discovery: 'may-have-completed', nativeHelper: 'not-started', candidateResults: 'none', catalog: 'unchanged' } },
      next: { guidance: expect.stringContaining('existing catalog remains active') },
    });
    discovery.resolve([]);
    const settled = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.cancellable === false && job.result?.partial.discovery === 'completed');
    expect(settled).toMatchObject({
      status: 'cancelled', message: 'Cancelled after discovery found no candidates. The existing catalog remains available.',
      result: { discoveredCandidates: 0, processedCandidates: 0, pluginCount: 0, quarantined: 0, partial: { nativeHelper: 'not-started', candidateResults: 'none', catalog: 'unchanged' } },
    });
    expect(plugins.list()).toEqual([retainedPlugin]); expect(projects.listPlugins()).toEqual([retainedPlugin]);
    expect(scanModule).not.toHaveBeenCalled(); expect(persistCatalog).not.toHaveBeenCalled();

    const completed = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'scan', roots: [root] });
    const empty = await waitForJob(completed.jobId, (job) => job.status === 'completed');
    expect(empty).toMatchObject({
      status: 'completed', progress: 1, cancellable: false,
      result: { discoveredCandidates: 0, processedCandidates: 0, pluginCount: 0, quarantined: 0, partial: { discovery: 'completed', nativeHelper: 'not-started', candidateResults: 'none', catalog: 'replaced' } },
    });
    expect(plugins.list()).toEqual([]); expect(projects.listPlugins()).toEqual([]); expect(persistCatalog).toHaveBeenCalledTimes(1);
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('never publishes partial candidate work when cancellation overlaps the last injected scanner result', async () => {
    const { owner, foreign } = await joinedClients();
    const last = deferred<PluginScannerOutput[]>();
    findCandidates.mockResolvedValueOnce([firstCandidate, lastCandidate]);
    scanModule.mockImplementationOnce(async () => [{ pluginUid: 'first', name: 'First Candidate', vendor: 'Fixture', version: '1', parameters: [] }]);
    scanModule.mockImplementationOnce(() => last.promise);
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'scan', roots: [root] });
    await waitForJob(queued.jobId, (job) => job.result?.processedCandidates === 1 && job.result.partial.nativeHelper === 'unconfirmed');
    expect(plugins.list()).toEqual([retainedPlugin]); expect(projects.listPlugins()).toEqual([retainedPlugin]);
    await expect(foreign.callTool('job_manage', { action: 'inspect', jobId: queued.jobId })).resolves.toEqual({ error: 'job_not_found' });
    const cancelled = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: queued.jobId });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      result: { discoveredCandidates: 2, processedCandidates: 1, pluginCount: 1, partial: { nativeHelper: 'unconfirmed', candidateResults: 'partial', catalog: 'unchanged' } },
      next: { guidance: expect.stringContaining('Some candidate results were computed privately, but no partial catalog was published') },
    });
    last.resolve([{ pluginUid: 'last', name: 'Last Candidate', vendor: 'Fixture', version: '1', parameters: [] }]);
    const settled = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.cancellable === false && job.result?.processedCandidates === 2);
    expect(settled).toMatchObject({
      status: 'cancelled',
      result: { discoveredCandidates: 2, processedCandidates: 2, pluginCount: 2, quarantined: 0, partial: { nativeHelper: 'settled', candidateResults: 'complete', catalog: 'unchanged' } },
    });
    expect(plugins.list()).toEqual([retainedPlugin]); expect(projects.listPlugins()).toEqual([retainedPlugin]); expect(persistCatalog).not.toHaveBeenCalled();
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('completed');
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('retains a complete catalog replacement when cancellation overlaps its successful injected atomic write', async () => {
    const { owner } = await joinedClients();
    const write = deferred<void>(); persistCatalog.mockImplementationOnce(() => write.promise);
    findCandidates.mockResolvedValueOnce([firstCandidate]);
    scanModule.mockResolvedValueOnce([{ pluginUid: 'replacement', name: 'Replacement Plug-in', vendor: 'Fixture', version: '2', parameters: [] }]);
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'scan', roots: [root] });
    await waitForJob(queued.jobId, (job) => job.result?.partial.catalog === 'write-may-have-completed');
    const cancelled = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'cancel', jobId: queued.jobId });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      result: { processedCandidates: 1, pluginCount: 1, partial: { nativeHelper: 'settled', candidateResults: 'complete', catalog: 'write-may-have-completed' } },
      next: { tool: 'job_manage', guidance: expect.stringContaining('atomic replacement-catalog write may have completed') },
    });
    expect(plugins.list()).toEqual([retainedPlugin]); expect(projects.listPlugins()).toEqual([retainedPlugin]);
    write.resolve();
    const retained = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.cancellable === false && job.result?.partial.catalog === 'replaced');
    expect(retained).toMatchObject({
      status: 'cancelled', message: 'Cancelled while finalizing the scan. The complete replacement catalog remains available.',
      result: { discoveredCandidates: 1, processedCandidates: 1, pluginCount: 1, quarantined: 0, partial: { discovery: 'completed', nativeHelper: 'settled', candidateResults: 'complete', catalog: 'replaced' } },
    });
    expect(plugins.list()).toEqual([expect.objectContaining({ id: 'clap:replacement', name: 'Replacement Plug-in' })]);
    expect(projects.listPlugins()).toEqual(plugins.list());
    const inspected = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'inspect', jobId: queued.jobId });
    expect(inspected).toMatchObject({ status: 'cancelled', next: { tool: 'plugin_manage', arguments: { action: 'catalog' }, guidance: expect.stringContaining('complete replacement catalog became globally observable') } });
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('completed');
    expect(audioStart).not.toHaveBeenCalled();
  });

  it('does not resurrect a cancelled final catalog write as failed when the injected atomic writer rejects without replacement', async () => {
    const { owner } = await joinedClients();
    const write = deferred<void>(); persistCatalog.mockImplementationOnce(() => write.promise);
    findCandidates.mockResolvedValueOnce([firstCandidate]);
    scanModule.mockResolvedValueOnce([{ pluginUid: 'not-published', name: 'Not Published', parameters: [] }]);
    const upsert = vi.spyOn(projects, 'upsertJob');
    const queued = await owner.callTool<{ jobId: string }>('plugin_manage', { action: 'scan', roots: [root] });
    await waitForJob(queued.jobId, (job) => job.result?.partial.catalog === 'write-may-have-completed');
    await owner.callTool('job_manage', { action: 'cancel', jobId: queued.jobId }); write.reject(new Error('Injected catalog writer rejected late.'));
    const settled = await waitForJob(queued.jobId, (job) => job.status === 'cancelled' && job.cancellable === false);
    expect(settled).toMatchObject({
      status: 'cancelled',
      result: { pluginCount: 1, partial: { nativeHelper: 'settled', candidateResults: 'complete', catalog: 'unchanged' } },
    });
    expect(settled).not.toHaveProperty('error');
    expect(plugins.list()).toEqual([retainedPlugin]); expect(projects.listPlugins()).toEqual([retainedPlugin]);
    const inspected = await owner.callTool<Record<string, unknown>>('job_manage', { action: 'inspect', jobId: queued.jobId });
    expect(inspected).toMatchObject({ status: 'cancelled', next: { guidance: expect.stringContaining('existing catalog remains active') } });
    expect(upsert.mock.calls.map(([job]) => job).filter((job) => job.id === queued.jobId).map((job) => job.status)).not.toContain('failed');
    expect(audioStart).not.toHaveBeenCalled();
  });
});
