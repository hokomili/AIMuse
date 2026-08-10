import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import type { AsyncJob, AuthorityPolicy } from '@aimuse/core';
import ts from 'typescript';
import type { GenerationJobResult, GenerationRequest } from '../../src/common/generation';
import type { WorkspaceEvent } from '../../src/common/contracts';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ProviderCredentialStore, type ProtectedStorage } from '../../src/main/credentials';
import { ExportManager } from '../../src/main/export-manager';
import { GenerationManager } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { McpHost } from '../../src/main/mcp-host';
import { MediaManager } from '../../src/main/media-manager';
import { PluginManager } from '../../src/main/plugin-manager';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

interface RpcMessage { result?: Record<string, unknown>; error?: Record<string, unknown> }

const PLAINTEXT_SENTINEL = 'GEN06_PROVIDER_PLAINTEXT_MUST_NEVER_REACH_A_CLIENT_7f36b20d';
const CIPHERTEXT_BYTES = Buffer.from('GEN06_ENCRYPTED_PROVIDER_SENTINEL_MUST_STAY_ON_DISK_65cbb5c2');
const ENCRYPTED_SENTINEL = CIPHERTEXT_BYTES.toString('base64');
const PROVIDER_SECRET_MEMBER = /provider.*(?:credential|secret|key)|(?:credential|secret|key).*provider/i;
const expectedProtectedStorageLabel = process.platform === 'win32'
  ? 'Windows protected storage'
  : process.platform === 'darwin'
    ? 'macOS Keychain-backed protected storage'
    : 'Operating-system protected storage';

function memberName(member: ts.TypeElement | ts.ObjectLiteralElementLike, source: ts.SourceFile): string | undefined {
  const named = member as { name?: ts.PropertyName };
  return named.name?.getText(source).replace(/^['"]|['"]$/g, '');
}

function findNode<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T | undefined {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

async function sourceFile(path: string, kind: ts.ScriptKind): Promise<ts.SourceFile> {
  const text = await readFile(path, 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

async function rpc(url: string, token: string, body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcMessage }> {
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
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as RpcMessage);
    return { response, message: messages.at(-1) };
  }
  return { response, message: JSON.parse(text) as RpcMessage };
}

function toolData(message?: RpcMessage): Record<string, unknown> {
  const content = message?.result?.content as Array<{ text: string }> | undefined;
  expect(content).toHaveLength(1);
  return JSON.parse(content![0].text) as Record<string, unknown>;
}

describe('provider credential renderer and public-surface isolation', () => {
  let root: string | undefined;
  let audio: AudioEngineController | undefined;
  let host: McpHost | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await host?.stop();
    await audio?.stop();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined; audio = undefined; host = undefined;
  });

  it('keeps the declared and frozen preload provider-credential surface setter-only with an acknowledgement-only result', async () => {
    const contracts = await sourceFile(resolve('src', 'common', 'contracts.ts'), ts.ScriptKind.TS);
    const desktopApi = findNode(contracts, (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'AIMuseDesktopAPI');
    expect(desktopApi).toBeDefined();
    const credentialMembers = desktopApi!.members.filter((member) => PROVIDER_SECRET_MEMBER.test(memberName(member, contracts) ?? ''));
    expect(credentialMembers.map((member) => memberName(member, contracts))).toEqual(['setProviderCredential']);
    const declaredSetter = credentialMembers[0];
    if (!declaredSetter || !ts.isMethodSignature(declaredSetter)) throw new Error('setProviderCredential must remain a method signature.');
    const setterType = declaredSetter.type;
    expect(setterType?.getText(contracts).replace(/\s+/g, ' ')).toBe('Promise<{ saved: boolean }>');

    const preload = await sourceFile(resolve('src', 'preload', 'preload.ts'), ts.ScriptKind.TS);
    const apiDeclaration = findNode(preload, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(preload) === 'api' && Boolean(node.initializer && ts.isObjectLiteralExpression(node.initializer)));
    const api = apiDeclaration!.initializer as ts.ObjectLiteralExpression;
    const preloadCredentialMembers = api.properties.filter((member) => PROVIDER_SECRET_MEMBER.test(memberName(member, preload) ?? ''));
    expect(preloadCredentialMembers.map((member) => memberName(member, preload))).toEqual(['setProviderCredential']);
    const preloadSetter = preloadCredentialMembers[0];
    expect(preloadSetter.getText(preload).replace(/\s+/g, ' ')).toContain('ipcRenderer.invoke(IPC.setProviderCredential, provider, value)');
    const exposure = findNode(preload, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(preload) === 'contextBridge.exposeInMainWorld');
    expect(exposure?.arguments[1]?.getText(preload)).toBe('Object.freeze(api)');

    const main = await sourceFile(resolve('src', 'main', 'main.ts'), ts.ScriptKind.TS);
    const handler = findNode(main, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(main) === 'handle' && node.arguments[0]?.getText(main) === 'IPC.setProviderCredential');
    expect(handler).toBeDefined();
    const callback = handler!.arguments[1];
    expect(callback.getText(main).replace(/\s+/g, ' ')).toContain('await runtime.generation.setCredential(provider, value)');
    const result = findNode(callback, (node): node is ts.ReturnStatement => ts.isReturnStatement(node) && Boolean(node.expression && ts.isObjectLiteralExpression(node.expression)));
    const acknowledgement = result!.expression as ts.ObjectLiteralExpression;
    expect(acknowledgement.properties.map((property) => memberName(property, main))).toEqual(['saved']);
    expect(acknowledgement.properties[0].getText(main).replace(/\s+/g, '')).toBe('saved:true');
  });

  it('redacts mock credential failures across bootstrap, capabilities, events, MCP, errors, logs, and serialized renderer state', async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-provider-leakage-'));
    const credentialPath = join(root, 'credentials', 'providers.json');
    let protectedPlaintext: string | undefined;
    let encryptionThrows = false;
    const storage: ProtectedStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => {
        if (encryptionThrows) throw new Error(`unsafe protected-storage diagnostic: ${value} / ${ENCRYPTED_SENTINEL}`);
        protectedPlaintext = value;
        return Buffer.from(CIPHERTEXT_BYTES);
      },
      decryptString: (value) => {
        if (!value.equals(CIPHERTEXT_BYTES) || protectedPlaintext === undefined) throw new Error('test cipher mismatch');
        return protectedPlaintext;
      },
    };
    const credentials = new ProviderCredentialStore(credentialPath, storage);
    await credentials.set('elevenlabs', PLAINTEXT_SENTINEL);
    expect(await credentials.get('elevenlabs')).toBe(PLAINTEXT_SENTINEL);
    const persisted = await readFile(credentialPath, 'utf8');
    expect(persisted).toContain(ENCRYPTED_SENTINEL);
    expect(persisted).not.toContain(PLAINTEXT_SENTINEL);

    encryptionThrows = true;
    const storageFailure = await credentials.set('elevenlabs', PLAINTEXT_SENTINEL).then(() => undefined, (error: unknown) => error as Error);
    expect(storageFailure?.message).toBe(`${expectedProtectedStorageLabel} could not encrypt the credential.`);
    expect(await readFile(credentialPath, 'utf8')).toBe(persisted);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    audio = new AudioEngineController();
    const projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    const workspaceEvents: WorkspaceEvent[] = [];
    projects.on('event', (event) => workspaceEvents.push(structuredClone(event)));
    const authority = new AuthorityManager();
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'provider-leakage-policy', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      budget: { currency: 'USD', maxSpendMinor: 100, maxGenerationRequests: 1, maxUnknownCostRequests: 0 },
      providers: { elevenlabs: { enabled: true, models: ['music_v1'] } }, readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [],
      allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });
    const fetcher = vi.fn(async () => new Response(`provider diagnostic echoed ${PLAINTEXT_SENTINEL}`, { status: 500 }));
    const generation = new GenerationManager(join(root, 'generation'), projects, authority, credentials, fetcher as typeof fetch);
    const media = new MediaManager(join(root, 'managed'), projects, authority);
    const plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    const exports = new ExportManager(projects, audio, authority);
    host = new McpHost({ appVersion: 'test', profileId: 'B'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, generation, exports });
    await audio.start();
    await projects.initialize();
    await plugins.initialize();
    const token = 'test-provider-leakage-mcp-token';
    const connection = await host.start(token);
    projects.setMcpInfo({ running: true, ...connection });

    let requestId = 0;
    const initialize = await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Credential leakage contract', version: '1' } } });
    expect(initialize.response.status).toBe(200);
    const sessionId = initialize.response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await rpc(connection.url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
    await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Credential Isolation Agent' } } }, sessionId!);

    const projectId = projects.getActiveProjectId()!;
    const generationRequest: GenerationRequest = {
      projectId, provider: 'elevenlabs', model: 'music_v1', kind: 'music', prompt: 'Test-owned instrumental', instrumental: true,
      durationMs: 3_000, resultCount: 1, referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', estimatedCostMinor: 1, currency: 'USD', providerOptions: {},
    };
    const started = await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'generation_manage', arguments: { action: 'start', request: generationRequest } } }, sessionId!);
    const jobId = String(toolData(started.message).jobId);
    let failed: AsyncJob<GenerationJobResult> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      failed = projects.getJob<GenerationJobResult>(jobId);
      if (failed?.status === 'failed') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'http-500', message: expect.stringContaining('[provider credential redacted]') } });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const publicObservations: unknown[] = [
      initialize.message,
      await (await fetch(connection.url.replace('/mcp', '/health'))).json(),
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/list', params: {} }, sessionId!)).message,
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'resources/list', params: {} }, sessionId!)).message,
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'resources/templates/list', params: {} }, sessionId!)).message,
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'generation_manage', arguments: { action: 'capabilities' } } }, sessionId!)).message,
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'generation_manage', arguments: { action: 'inspect', jobId } } }, sessionId!)).message,
      (await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'project_observe', arguments: { projectId, includeEditor: true, includeFileAudit: true, assetIds: [] } } }, sessionId!)).message,
    ];
    for (const uri of [
      'aimuse://projects', 'aimuse://sessions', 'aimuse://plugins', 'aimuse://guide', `aimuse://projects/${projectId}/manifest`,
      `aimuse://projects/${projectId}/snapshot`, `aimuse://projects/${projectId}/changes/0`, `aimuse://projects/${projectId}/trace`, `aimuse://jobs/${jobId}`,
    ]) publicObservations.push((await rpc(connection.url, token, { jsonrpc: '2.0', id: ++requestId, method: 'resources/read', params: { uri } }, sessionId!)).message);

    const providerStatus = await credentials.status();
    const capabilities = await generation.capabilities();
    expect(providerStatus).toEqual({ elevenlabs: true, stability: false, lyria: false });
    expect(capabilities.find((entry) => entry.provider === 'elevenlabs')?.configured).toBe(true);
    expect(workspaceEvents.some((event) => event.type === 'workspace')).toBe(true);
    expect(workspaceEvents.some((event) => event.type === 'job' && event.job.id === jobId && event.job.status === 'failed')).toBe(true);
    const rendererVisibleState = JSON.stringify({
      bootstrap: projects.snapshot(), providerStatus, capabilities, workspaceEvents, publicObservations,
      errors: storageFailure && { name: storageFailure.name, message: storageFailure.message, stack: storageFailure.stack },
      logs: [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls],
    });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(rendererVisibleState).not.toContain(PLAINTEXT_SENTINEL);
    expect(rendererVisibleState).not.toContain(ENCRYPTED_SENTINEL);
  });
});
