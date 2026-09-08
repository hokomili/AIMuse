import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { createId, entityBase, HUMAN_ACTOR, nowIso, type AsyncJob, type AuthorityPolicy, type GenerationProvenance, type MediaAsset, type MidiClip, type ProjectTransaction } from '@aimuse/core';
import { decodeWav } from '../../src/main/wav';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { ExportManager } from '../../src/main/export-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { McpHost, type McpSessionLifecycleHooks } from '../../src/main/mcp-host';
import { MediaManager } from '../../src/main/media-manager';
import { saveProjectFolder } from '../../src/main/persistence';
import { PluginManager } from '../../src/main/plugin-manager';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';
import { sha256Json } from '../../src/main/trace-replay-audit';
import type { WorkspaceEvent } from '../../src/common/contracts';

interface RpcResponse { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: Record<string, unknown> }
interface NotificationStream { messages: RpcResponse[]; done: Promise<void>; abort: () => void; failure: () => unknown }
interface RawHttpResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

describe('authenticated localhost MCP contract', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let authority: AuthorityManager;
  let media: MediaManager;
  let plugins: PluginManager;
  let exports: ExportManager;
  let host: McpHost;
  let url: string;
  const token = Buffer.alloc(32, 0x74).toString('base64url');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    authority = new AuthorityManager();
    media = new MediaManager(join(root, 'managed'), projects, authority);
    plugins = new PluginManager(join(root, 'plugins.json'), undefined, projects, authority);
    exports = new ExportManager(projects, audio, authority);
    host = new McpHost({ appVersion: 'test', profileId: 'A'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'), projects, audio, authority, media, plugins, exports });
    await audio.start();
    await projects.initialize();
    await plugins.initialize();
    url = (await host.start(token)).url;
  });

  afterEach(async () => {
    await host.stop();
    await audio.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function request(body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcResponse }> {
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
      const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as RpcResponse);
      return { response, message: messages.at(-1) };
    }
    return { response, message: JSON.parse(text) as RpcResponse };
  }

  function getHealth(): Promise<Response> {
    return fetch(url.replace('/mcp', '/health'), { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  }

  async function initialize(): Promise<{ sessionId: string; message: RpcResponse }> {
    const initialized = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'AIMuse contract test', version: '1' } } });
    expect(initialized.response.status).toBe(200);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
    return { sessionId: sessionId!, message: initialized.message! };
  }

  async function restartHostWithLifecycleHooks(sessionLifecycleHooks: McpSessionLifecycleHooks): Promise<void> {
    await host.stop();
    host = new McpHost({
      appVersion: 'test', profileId: 'A'.repeat(64), portSettingsPath: join(root, 'mcp-port.json'), cacheRoot: join(root, 'managed'),
      projects, audio, authority, media, plugins, exports, sessionLifecycleHooks,
    });
    url = (await host.start(token)).url;
  }

  function beginChunkedPost(target: string, authority: string, firstChunk: string, sessionId?: string): { request: ClientRequest; response: Promise<RawHttpResponse> } {
    let clientRequest!: ClientRequest;
    const response = new Promise<RawHttpResponse>((resolvePromise, reject) => {
      clientRequest = httpRequest(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authority}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          connection: 'close',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        incoming.once('end', () => resolvePromise({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      clientRequest.once('error', reject);
    });
    clientRequest.write(firstChunk);
    return { request: clientRequest, response };
  }

  async function openHistoricalProvenanceProject(): Promise<{ projectId: string; provenanceId: string }> {
    const project = projects.getActiveProject()!;
    const source = join(root, 'historical-generated.wav');
    const bytes = Buffer.from('historical generated MCP fixture\n');
    await writeFile(source, bytes);
    const asset: MediaAsset = {
      ...entityBase('asset', HUMAN_ACTOR), kind: 'audio', name: 'Historical generated asset', mimeType: 'audio/wav', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength,
      storage: 'linked', externalPath: source, source: 'generation',
    };
    const provenance: GenerationProvenance = {
      ...entityBase('provenance', HUMAN_ACTOR), assetId: asset.id, provider: 'stability', model: 'legacy-model', kind: 'music',
      prompt: 'Legacy MCP compatibility metadata', referenceAssetIds: [], rightsDeclaration: 'original', transformations: ['authored-before-removal'], experimental: false,
    };
    project.assets[asset.id] = asset;
    project.provenance[provenance.id] = provenance;
    const saved = await saveProjectFolder(project, join(root, 'historical-mcp-provenance'), { appVersion: 'test' });
    await expect(projects.open([saved.projectPath])).resolves.toEqual({ opened: [project.id], warnings: [] });
    expect(projects.getActiveProject()!.provenance[provenance.id]).toEqual(provenance);
    return { projectId: project.id, provenanceId: provenance.id };
  }

  async function openNotificationStream(sessionId: string): Promise<NotificationStream> {
    const controller = new AbortController();
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': sessionId },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.body).toBeTruthy();
    const messages: RpcResponse[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let streamFailure: unknown;
    const consume = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data) messages.push(JSON.parse(data) as RpcResponse);
      }
    };
    const done = (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          consume(decoder.decode(next.value, { stream: true }));
        }
        consume(decoder.decode());
      } catch (error) {
        if (!controller.signal.aborted) streamFailure = error;
      }
    })();
    return { messages, done, abort: () => controller.abort(), failure: () => streamFailure };
  }

  async function waitForMessages(stream: NotificationStream, count: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (stream.messages.length < count && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(stream.messages).toHaveLength(count);
  }

  async function closeSession(sessionId: string, stream: NotificationStream): Promise<void> {
    const response = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId } });
    expect([200, 202, 204]).toContain(response.status);
    await stream.done;
    expect(stream.failure()).toBeUndefined();
  }

  let sequence = 0;
  function createRequestId(): number { sequence += 1; return sequence; }

  it('lets a cold client compose and render using only public help payloads and nested tool schemas', async () => {
    const { sessionId } = await initialize();
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: arguments_ } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      return response.message?.result as { isError?: boolean; structuredContent?: { data: Record<string, unknown> }; content: Array<{ text: string }> };
    };
    const joined = await call('session_manage', { action: 'join', name: 'Cold composer' });
    const actor = joined.structuredContent!.data.actor as { id: string };
    const observed = await call('project_observe', {});
    const project = observed.structuredContent!.data.project as { id: string };
    const help = await call('aimuse_help', { topic: 'composition' });
    const example = help.structuredContent!.data.example as Record<string, unknown>;
    const instruments = await call('aimuse_help', { topic: 'instruments' });
    expect((instruments.structuredContent!.data.library as { presets: unknown[] }).presets).toHaveLength(287);
    expect(JSON.stringify(example)).toContain('generaluser-gs-2.0.3');
    expect(example.projectId).toBe(project.id);
    const contract = await call('aimuse_help', { topic: 'operation-schemas', operationKind: 'midi.note.add' });
    expect(JSON.stringify(contract.structuredContent!.data.schemas)).toContain('releaseVelocity');
    const rendering = await call('aimuse_help', { topic: 'rendering' });
    expect(JSON.stringify(rendering.structuredContent!.data)).toContain('Sampler/drum-rack');
    const listed = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/list', params: {} }, sessionId);
    const apply = (listed.message?.result?.tools as Array<{ name: string; inputSchema: unknown }>).find((tool) => tool.name === 'project_apply')!;
    const schemaText = JSON.stringify(apply.inputSchema);
    expect(schemaText).toContain('sourceDurationSamples'); expect(schemaText).toContain('releaseVelocity'); expect(schemaText).toContain('parameters');
    expect(schemaText).not.toContain('provenance.register');
    const committed = await call('project_apply', example); expect(committed.structuredContent!.data.status).toBe('committed');
    const after = await call('project_observe', {}); const state = after.structuredContent!.data.project as { tracks: Record<string, { createdBy: string; name: string }> };
    expect(Object.values(state.tracks).find((track) => track.name === 'Help melody')?.createdBy).toBe(actor.id);
    const duplicate = await call('project_apply', example); expect(duplicate.structuredContent!.data.status).toBe('duplicate');
    const soundfontId = (example.operations as Array<{ kind: string; device?: { id: string; builtinKind?: string } }>).find((operation) => operation.device?.builtinKind === 'soundfont')!.device!.id;
    const selected = await call('plugin_manage', { action: 'set-preset', projectId: project.id, deviceId: soundfontId, presetName: 'Fast Strings' });
    expect(selected.structuredContent!.data.status).toBe('committed');
    const selectedProject = (await call('project_observe', {})).structuredContent!.data.project as { devices: Record<string, { soundfont: { program: number } }> };
    expect(selectedProject.devices[soundfontId].soundfont.program).toBe(48);
    const missing = await call('plugin_manage', { action: 'set-preset', projectId: project.id, deviceId: soundfontId, presetName: 'Not a real preset' });
    expect(missing.structuredContent!.data.status).toBe('conflict');
    // File authority is test setup; composition itself consumes only public responses.
    await authority.install({ version: 1, id: createId('policy'), issuedAt: nowIso(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxRuntimeMinutes: 5, readRoots: [root], writeRoots: [root], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false });
    const exported = await call('export_manage', { projectId: project.id, kind: 'master', destination: join(root, 'cold-composition.wav'), format: 'wav' });
    const jobId = exported.structuredContent!.data.jobId;
    expect(typeof jobId).toBe('string');
    let job: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) { const result = await call('job_manage', { action: 'wait', jobId, timeoutMs: 100 }); job = result.structuredContent!.data; if (['completed', 'failed', 'waiting-for-user'].includes(String(job.status))) break; }
    expect(job.status).toBe('completed');
    const wav = decodeWav(await readFile(join(root, 'cold-composition.wav')));
    expect(wav.data[0].some((sample) => Math.abs(sample) > 0.01)).toBe(true);
  });

  it('rejects unauthenticated and malformed requests before creating state', async () => {
    const { instanceId, profileId } = host.connection();
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(profileId).toBe('A'.repeat(64));
    const unauthenticatedHealth = await fetch(url.replace('/mcp', '/health'));
    expect(unauthenticatedHealth.status).toBe(401);
    const health = await getHealth();
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ name: 'AIMuse Engine', status: 'ok', pid: process.pid, instanceId, profileId, uiRequired: false });

    const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');

    const malformed = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{broken' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: 'invalid_json' });

    const oversized = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(4 * 1024 * 1024) }) });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: 'body_too_large' });
  });

  it('discards engine-scoped MCP authority when the listener stops', async () => {
    expect(host.connection()).toMatchObject({ url, token });
    const portSettings = await readFile(join(root, 'mcp-port.json'), 'utf8');
    expect(portSettings).not.toContain(token);
    expect(JSON.parse(portSettings)).toMatchObject({ version: 1, preferredPort: expect.any(Number) });
    await host.stop();
    expect(host.connection()).toMatchObject({ url: undefined, token: '' });
  });

  it('does not make the listener depend on persisted port preferences', async () => {
    await host.stop();
    const blockedParent = join(root, 'not-a-directory');
    await writeFile(blockedParent, 'blocks preference persistence\n');
    const secondToken = Buffer.alloc(32, 0x75).toString('base64url');
    const secondary = new McpHost({
      appVersion: 'test', profileId: 'B'.repeat(64), portSettingsPath: join(blockedParent, 'mcp-port.json'), cacheRoot: join(root, 'secondary-managed'),
      projects, audio, authority,
      media: new MediaManager(join(root, 'secondary-managed'), projects, authority),
      plugins: new PluginManager(join(root, 'secondary-plugins.json'), undefined, projects, authority),
      exports: new ExportManager(projects, audio, authority),
    });
    try {
      const started = await secondary.start(secondToken);
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      expect(secondary.connection()).toMatchObject({ url: started.url, token: secondToken });
      await expect(access(join(blockedParent, 'mcp-port.json'))).rejects.toThrow();
    } finally {
      await secondary.stop();
    }
  });

  it('rejects authenticated MCP deletion of historical provenance without changing its bytes or meaning', async () => {
    const { projectId, provenanceId } = await openHistoricalProvenanceProject();
    const beforeProject = projects.getActiveProject()!;
    const before = structuredClone(beforeProject.provenance);
    const beforeBytes = JSON.stringify(before);
    const { sessionId } = await initialize();
    const joined = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Legacy Boundary Agent' } } }, sessionId);
    expect(joined.message?.error).toBeUndefined();

    const applied = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'project_apply', arguments: {
      projectId, clientOperationId: 'reject-mcp-provenance-delete', label: 'Reject MCP provenance deletion', commitMode: 'direct',
      operations: [{ kind: 'provenance.delete', provenanceId, expectedRevision: before[provenanceId].revision }],
    } } }, sessionId);
    expect(applied.message?.error).toBeUndefined();
    expect(applied.message?.result?.isError).not.toBe(true);
    const content = applied.message?.result?.content as Array<{ text: string }>;
    expect(JSON.parse(content[0].text)).toMatchObject({
      status: 'conflict', message: expect.stringMatching(/provenance\.delete.*historical generation provenance is read-only/i),
    });
    const afterProject = projects.getActiveProject()!;
    expect(afterProject.revision).toBe(beforeProject.revision);
    expect(afterProject.provenance).toEqual(before);
    expect(JSON.stringify(afterProject.provenance)).toBe(beforeBytes);
  });

  it('reports MIDI input capture unavailable before authority, approval, or transport can imply a backend', async () => {
    const { sessionId } = await initialize();
    const transport = vi.spyOn(audio, 'transport');
    const callMidiRecord = async () => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'transport_manage', arguments: { action: 'record', recordingSource: 'midi-input' } } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      const content = response.message?.result?.content as Array<{ text: string }>;
      return JSON.parse(content[0].text) as Record<string, unknown>;
    };

    const beforeJobs = projects.listJobs();
    await expect(callMidiRecord()).resolves.toMatchObject({ error: 'midi_input_unavailable', retryable: false, next: { guidance: expect.stringContaining('Do not treat transport recording state as MIDI capture') } });
    expect(transport).not.toHaveBeenCalled();
    expect(projects.listJobs()).toEqual(beforeJobs);

    const now = Date.now();
    await expect(authority.install({
      version: 1, id: 'midi-input-authorized-without-backend', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: true, allowMidiOutput: false,
    })).resolves.toEqual({ installed: true });
    await expect(callMidiRecord()).resolves.toMatchObject({ error: 'midi_input_unavailable', retryable: false });
    expect(transport).not.toHaveBeenCalled();
    expect(projects.listJobs()).toEqual(beforeJobs);
  });

  it('publishes credential-free receiver acknowledgements and poisons duplicate request IDs', async () => {
    const requestId = '33333333-3333-4333-8333-333333333333';
    const { instanceId, profileId } = host.connection();
    expect(host.beginShowAcknowledgement(requestId)).toBe(true);
    const pending = await (await getHealth()).json() as { showAcknowledgements: Array<Record<string, unknown>> };
    expect(pending.showAcknowledgements).toEqual([expect.objectContaining({ requestId, status: 'pending', pid: process.pid, instanceId, profileId, attempts: 1 })]);
    expect(pending.showAcknowledgements[0]).not.toHaveProperty('acknowledgedAt');
    expect(host.completeShowAcknowledgement(requestId, 'accepted')).toBe(true);
    const accepted = await (await getHealth()).json() as { showAcknowledgements: Array<Record<string, unknown>> };
    expect(accepted.showAcknowledgements).toEqual([expect.objectContaining({ requestId, status: 'accepted', pid: process.pid, instanceId, profileId, attempts: 1 })]);
    expect(JSON.stringify(accepted.showAcknowledgements)).not.toContain(token);

    expect(host.beginShowAcknowledgement(requestId)).toBe(false);
    const duplicated = await (await getHealth()).json() as { showAcknowledgements: Array<Record<string, unknown>> };
    expect(duplicated.showAcknowledgements).toEqual([expect.objectContaining({ requestId, status: 'rejected', reason: 'duplicate-request', attempts: 2 })]);
    expect(host.completeShowAcknowledgement(requestId, 'accepted')).toBe(false);
    expect(host.beginShowAcknowledgement('malformed')).toBe(false);
    expect(host.showAcknowledgements()).toHaveLength(1);

    for (let index = 0; index < 63; index += 1) expect(host.beginShowAcknowledgement(`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)).toBe(true);
    expect(host.showAcknowledgements()).toHaveLength(64);
    expect(host.beginShowAcknowledgement('ffffffff-ffff-4fff-8fff-ffffffffffff')).toBe(false);
    expect(host.showAcknowledgements()).toHaveLength(64);
    expect(host.showAcknowledgements()).toContainEqual(expect.objectContaining({ requestId, status: 'rejected', attempts: 2, reason: 'duplicate-request' }));
  });

  it('negotiates resource subscriptions and reads every public resource shape', async () => {
    const { sessionId, message } = await initialize();
    expect(message.result).toMatchObject({ capabilities: { resources: { subscribe: true, listChanged: true } } });
    const joined = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Resource Owner' } } }, sessionId);
    const actorId = (JSON.parse((((joined.message?.result?.content as Array<{ text: string }>)[0]).text)) as { actor: { id: string } }).actor.id;

    const project = projects.getActiveProject()!;
    const mediaBytes = Buffer.from('{"fixture":"analysis-resource"}\n');
    const mediaPath = join(root, 'analysis-resource.json');
    await writeFile(mediaPath, mediaBytes);
    const asset: MediaAsset = {
      ...entityBase('asset', HUMAN_ACTOR),
      kind: 'analysis',
      name: 'analysis-resource.json',
      mimeType: 'application/json',
      sha256: createHash('sha256').update(mediaBytes).digest('hex'),
      byteLength: mediaBytes.byteLength,
      storage: 'managed-cache',
      externalPath: mediaPath,
      source: 'system',
    };
    const transaction: ProjectTransaction = {
      id: createId('tx'), clientOperationId: 'mcp-resource-fixture', projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Register MCP resource fixture', createdAt: nowIso(), operations: [{ kind: 'asset.add', asset }], checkpointPolicy: 'none',
    };
    await expect(projects.apply(transaction, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });
    projects.registerAssetSource(asset.id, mediaPath);
    const timestamp = nowIso();
    const job: AsyncJob = { id: 'job-resource-fixture', ownerActorId: actorId, projectId: project.id, kind: 'render', status: 'completed', progress: 1, message: 'Resource fixture complete.', createdAt: timestamp, updatedAt: timestamp, cancellable: false, result: { assetId: asset.id } };
    projects.upsertJob(job);

    const list = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'resources/list', params: {} }, sessionId);
    expect(list.message?.error).toBeUndefined();
    expect((list.message?.result?.resources as Array<{ uri: string }>).map((resource) => resource.uri).sort()).toEqual(['aimuse://guide', 'aimuse://plugins', 'aimuse://projects', 'aimuse://sessions']);
    const templates = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'resources/templates/list', params: {} }, sessionId);
    expect(templates.message?.error).toBeUndefined();
    expect((templates.message?.result?.resourceTemplates as Array<{ uriTemplate: string }>).map((resource) => resource.uriTemplate).sort()).toEqual([
      'aimuse://jobs/{id}',
      'aimuse://projects/{id}/changes/{revision}',
      'aimuse://projects/{id}/manifest',
      'aimuse://projects/{id}/snapshot',
      'aimuse://projects/{id}/trace',
      'aimuse://projects/{projectId}/media/{assetId}',
    ]);

    const readResource = async (uri: string) => {
      const read = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'resources/read', params: { uri } }, sessionId);
      expect(read.message?.error).toBeUndefined();
      const contents = read.message?.result?.contents as Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
      expect(contents).toHaveLength(1);
      expect(contents[0].uri).toBe(uri);
      return contents[0];
    };

    const projectList = JSON.parse((await readResource('aimuse://projects')).text!) as Array<{ id: string }>;
    expect(projectList.map((value) => value.id)).toContain(project.id);
    const sessions = JSON.parse((await readResource('aimuse://sessions')).text!) as { presence: unknown[]; jobs: Array<{ id: string }> };
    expect(sessions).toMatchObject({ presence: [expect.objectContaining({ actor: expect.objectContaining({ id: actorId }) })], jobs: [expect.objectContaining({ id: job.id })] });
    expect(JSON.parse((await readResource('aimuse://plugins')).text!)).toEqual([]);
    const guide = (await readResource('aimuse://guide')).text!;
    expect(guide).toContain('a human must allow or deny');
    expect(guide).toContain('trace_replay');

    const manifest = JSON.parse((await readResource(`aimuse://projects/${project.id}/manifest`)).text!) as Record<string, unknown>;
    expect(manifest).toMatchObject({ id: project.id, revision: 1, assets: 1 });
    const snapshot = JSON.parse((await readResource(`aimuse://projects/${project.id}/snapshot`)).text!) as { id: string; assets: Record<string, unknown> };
    expect(snapshot.id).toBe(project.id);
    expect(snapshot.assets).toHaveProperty(asset.id);
    const changes = JSON.parse((await readResource(`aimuse://projects/${project.id}/changes/0`)).text!) as Array<{ revision: number }>;
    expect(changes).toEqual([expect.objectContaining({ revision: 1 })]);
    const trace = (await readResource(`aimuse://projects/${project.id}/trace`)).text!;
    expect(trace.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ transaction: expect.objectContaining({ clientOperationId: transaction.clientOperationId }) })]);
    expect(JSON.parse((await readResource(`aimuse://jobs/${job.id}`)).text!)).toMatchObject({ id: job.id, status: 'completed', result: { assetId: asset.id } });
    const media = await readResource(`aimuse://projects/${project.id}/media/${asset.id}`);
    expect(media.mimeType).toBe(asset.mimeType);
    expect(Buffer.from(media.blob!, 'base64')).toEqual(mediaBytes);
  });

  it('teaches a cold tools-only client conditional contracts, workflow, privacy, polling, and human boundaries', async () => {
    const { sessionId, message } = await initialize();
    expect(String(message.result?.instructions)).toContain('Call aimuse_help(getting-started)');
    expect(String(message.result?.instructions)).toContain('Human approvals cannot be granted through MCP');
    expect(String(message.result?.instructions)).toContain('trace_replay');

    const listed = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/list', params: {} }, sessionId);
    expect(listed.message?.error).toBeUndefined();
    type ToolContract = { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, boolean> };
    const tools = listed.message?.result?.tools as ToolContract[];
    expect(tools).toHaveLength(12);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(30);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.outputSchema).toMatchObject({ type: 'object', properties: { data: { description: expect.any(String) }, next: { description: expect.any(String) } } });
    }

    const contract = (name: string) => tools.find((tool) => tool.name === name)!;
    const branch = (name: string, action: string) => (contract(name).inputSchema.oneOf as Array<{ properties: { action: { const: string } }; required: string[] }>).find((value) => value.properties.action.const === action)!;
    expect(branch('session_manage', 'join').required).toEqual(['action', 'name']);
    expect(branch('project_manage', 'open').required).toEqual(['action', 'path']);
    expect(branch('project_manage', 'unpack').required).toEqual(['action', 'path', 'destination']);
    expect(branch('transport_manage', 'seek').required).toEqual(['action', 'tick']);
    expect(branch('media_manage', 'import').required).toEqual(['action', 'paths']);
    expect(branch('plugin_manage', 'set-parameter').required).toEqual(['action', 'deviceId', 'parameterId', 'value']);
    expect(branch('job_manage', 'wait').required).toEqual(['action', 'jobId']);
    expect((contract('project_manage').inputSchema.properties as Record<string, { description?: string }>).destination.description).toContain('authority');
    expect((contract('project_apply').inputSchema.properties as Record<string, { description?: string }>).clientOperationId.description).toContain('idempotency');
    expect(contract('trace_replay').inputSchema).toMatchObject({ required: ['projectId', 'transactionId'] });
    expect(contract('trace_replay').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(JSON.stringify(contract('job_manage').inputSchema)).not.toContain('approve');

    const help = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'aimuse_help', arguments: { topic: 'jobs-and-approvals' } } }, sessionId);
    const helpText = JSON.parse((((help.message?.result?.content as Array<{ text: string }>)[0]).text)) as Record<string, unknown>;
    expect(helpText).toMatchObject({ topic: 'jobs-and-approvals', fullGuideResource: 'aimuse://guide' });
    expect(String(helpText.guidance)).toContain('human must decide');
    expect(help.message?.result?.structuredContent).toMatchObject({ data: helpText });

    for (const [name, args] of [
      ['project_manage', { action: 'open' }],
      ['project_manage', { action: 'list', path: join(root, 'not-allowed') }],
      ['project_apply', { projectId: projects.getActiveProjectId(), clientOperationId: 'missing-branch-id', label: 'Invalid branch', operations: [{ kind: 'project.rename', name: 'No mutation' }], commitMode: 'branch' }],
      ['job_manage', { action: 'approve', jobId: 'not-a-job' }],
    ] as const) {
      const rejected = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(rejected.message?.error).toBeUndefined();
      expect(rejected.message?.result?.isError).toBe(true);
    }
    expect(projects.getActiveProject()).toMatchObject({ name: 'New Song', revision: 0 });
  });

  it('routes exact resource updates only to subscribed live sessions', async () => {
    const first = await initialize();
    const second = await initialize();
    const project = projects.getActiveProject()!;
    const manifest = `aimuse://projects/${project.id}/manifest`;
    const snapshot = `aimuse://projects/${project.id}/snapshot`;
    const changes = (revision: number) => `aimuse://projects/${project.id}/changes/${revision}`;
    const subscription = async (sessionId: string, method: 'resources/subscribe' | 'resources/unsubscribe', uri: string) => {
      const result = await request({ jsonrpc: '2.0', id: createRequestId(), method, params: { uri } }, sessionId);
      expect(result.message?.error).toBeUndefined();
      expect(result.message?.result).toEqual({});
    };
    const rename = async (name: string, clientOperationId: string, revision: number) => {
      const transaction: ProjectTransaction = { id: createId('tx'), clientOperationId, projectId: project.id, actor: HUMAN_ACTOR, label: name, createdAt: nowIso(), operations: [{ kind: 'project.rename', name }], checkpointPolicy: 'none' };
      await expect(projects.apply(transaction, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision });
    };
    const updatedUris = (stream: NotificationStream) => stream.messages.map((message) => {
      expect(message.method).toBe('notifications/resources/updated');
      return message.params?.uri;
    });
    const streams: NotificationStream[] = [];

    try {
      await subscription(first.sessionId, 'resources/subscribe', manifest);
      await subscription(first.sessionId, 'resources/subscribe', changes(0));
      await subscription(second.sessionId, 'resources/subscribe', snapshot);
      const firstStream = await openNotificationStream(first.sessionId); streams.push(firstStream);
      const secondStream = await openNotificationStream(second.sessionId); streams.push(secondStream);

      await rename('Subscription revision 1', 'subscription-revision-1', 1);
      await waitForMessages(firstStream, 2);
      await waitForMessages(secondStream, 1);
      expect(updatedUris(firstStream).sort()).toEqual([changes(0), manifest].sort());
      expect(updatedUris(secondStream)).toEqual([snapshot]);

      firstStream.messages.length = 0; secondStream.messages.length = 0;
      await subscription(first.sessionId, 'resources/subscribe', changes(1));
      await subscription(first.sessionId, 'resources/unsubscribe', manifest);
      await subscription(first.sessionId, 'resources/unsubscribe', changes(0));
      await subscription(first.sessionId, 'resources/unsubscribe', changes(1));
      await rename('Subscription revision 2', 'subscription-revision-2', 2);
      await waitForMessages(secondStream, 1);
      expect(firstStream.messages).toEqual([]);
      expect(updatedUris(secondStream)).toEqual([snapshot]);

      firstStream.messages.length = 0; secondStream.messages.length = 0;
      await subscription(first.sessionId, 'resources/subscribe', manifest);
      await subscription(first.sessionId, 'resources/subscribe', snapshot);
      await subscription(first.sessionId, 'resources/subscribe', changes(2));
      await closeSession(first.sessionId, firstStream);
      const stale = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': first.sessionId } });
      expect(stale.status).toBe(404);

      const third = await initialize();
      await subscription(third.sessionId, 'resources/subscribe', manifest);
      await subscription(third.sessionId, 'resources/subscribe', changes(2));
      const thirdStream = await openNotificationStream(third.sessionId); streams.push(thirdStream);
      await rename('Subscription revision 3', 'subscription-revision-3', 3);
      await waitForMessages(secondStream, 1);
      await waitForMessages(thirdStream, 2);
      expect(firstStream.messages).toEqual([]);
      expect(updatedUris(secondStream)).toEqual([snapshot]);
      expect(updatedUris(thirdStream).sort()).toEqual([changes(2), manifest].sort());

      await closeSession(second.sessionId, secondStream);
      await closeSession(third.sessionId, thirdStream);
    } finally {
      for (const stream of streams) stream.abort();
      await Promise.all(streams.map((stream) => stream.done));
    }
  });

  it('publishes the twelve tool-first contracts and applies edits with server-authenticated attribution', async () => {
    const { sessionId, message } = await initialize();
    expect(message.result).toMatchObject({ protocolVersion: LATEST_PROTOCOL_VERSION, serverInfo: { name: 'aimuse', version: 'test' } });

    const listed = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/list', params: {} }, sessionId);
    const tools = (listed.message?.result?.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(tools).toEqual(['aimuse_help', 'export_manage', 'history_manage', 'job_manage', 'media_manage', 'plugin_manage', 'project_apply', 'project_manage', 'project_observe', 'session_manage', 'trace_replay', 'transport_manage']);

    const joined = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Composer Agent', client: { product: 'contract-test', model: 'fixture' } } } }, sessionId);
    const joinPayload = JSON.parse((((joined.message?.result?.content as Array<{ text: string }>)[0]).text)) as { actor: { id: string } };
    const project = projects.getActiveProject()!;
    const applied = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'project_apply', arguments: { projectId: project.id, clientOperationId: 'contract-rename-1', label: 'Rename through MCP', operations: [{ kind: 'project.rename', name: 'MCP Song' }], commitMode: 'direct' } } }, sessionId);
    const applyPayload = JSON.parse((((applied.message?.result?.content as Array<{ text: string }>)[0]).text)) as { status: string; revision: number };
    expect(applyPayload).toMatchObject({ status: 'committed', revision: 1 });
    expect(projects.getActiveProject()).toMatchObject({ name: 'MCP Song', activity: [{ actor: { id: joinPayload.actor.id, kind: 'agent' } }] });

    const duplicate = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'project_apply', arguments: { projectId: project.id, clientOperationId: 'contract-rename-1', label: 'Rename through MCP', operations: [{ kind: 'project.rename', name: 'MCP Song' }], commitMode: 'direct' } } }, sessionId);
    expect(JSON.parse((((duplicate.message?.result?.content as Array<{ text: string }>)[0]).text))).toMatchObject({ status: 'duplicate', revision: 1 });
  });

  it('replays a selected durable trace through authenticated MCP with a deterministic non-mutating receipt', async () => {
    const { sessionId } = await initialize();
    const callTool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      const content = response.message?.result?.content as Array<{ text: string }>;
      expect(content).toHaveLength(1);
      return JSON.parse(content[0].text) as T;
    };
    await callTool('session_manage', { action: 'join', name: 'Trace Replay Agent' });
    const project = projects.getActiveProject()!;
    const applied = await callTool<{ status: string; revision: number; transactionId: string }>('project_apply', {
      projectId: project.id,
      clientOperationId: 'public-trace-replay-fixture',
      label: 'Rename for public trace replay',
      operations: [{ kind: 'project.rename', name: 'Replay receipt song' }],
      commitMode: 'direct',
    });
    expect(applied).toMatchObject({ status: 'committed', revision: 1, transactionId: expect.stringMatching(/^tx_/) });
    const canonicalBefore = projects.getProject(project.id)!;
    const replayEvents: WorkspaceEvent[] = [];
    const onEvent = (event: WorkspaceEvent) => { if (event.type === 'trace-replay') replayEvents.push(structuredClone(event)); };
    projects.on('event', onEvent);

    try {
      const replay = await callTool<{
        version: number; status: string; projectId: string; transactionId: string; auditSha256: string;
        source: { resource: string; revision: number; outcome: string; operationCount: number; operationKinds: string[]; entrySha256: string; transactionSha256: string };
        replay: { mode: string; appliedOperations: number; progressEventCount: number; steps: Array<Record<string, unknown>> };
        canonical: { beforeRevision: number; afterRevision: number; beforeSha256: string; afterSha256: string; unchanged: boolean };
      }>('trace_replay', { projectId: project.id, transactionId: applied.transactionId });
      expect(replay).toMatchObject({
        version: 1,
        status: 'completed',
        projectId: project.id,
        transactionId: applied.transactionId,
        source: {
          resource: `aimuse://projects/${project.id}/trace`, revision: 1, outcome: 'committed',
          operationCount: 1, operationKinds: ['project.rename'], entrySha256: expect.stringMatching(/^[0-9a-f]{64}$/), transactionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        replay: {
          mode: 'non-mutating-visualization', appliedOperations: 0, progressEventCount: 2,
          steps: [{ index: 0, kind: 'project.rename', progressStart: 0, progressEnd: 1 }],
        },
        canonical: { beforeRevision: 1, afterRevision: 1, unchanged: true },
        auditSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(replay.canonical.beforeSha256).toBe(replay.canonical.afterSha256);
      expect(JSON.stringify(replay)).not.toContain('Replay receipt song');
      const { auditSha256, ...audit } = replay;
      expect(auditSha256).toBe(sha256Json(audit));
      expect(projects.getProject(project.id)).toEqual(canonicalBefore);
      const repeated = await callTool<typeof replay>('trace_replay', { projectId: project.id, transactionId: applied.transactionId });
      expect(repeated).toEqual(replay);
      expect(projects.getProject(project.id)).toEqual(canonicalBefore);
      expect(replayEvents).toEqual([
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 0, status: 'playing' },
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 1, status: 'completed' },
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 0, status: 'playing' },
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 1, status: 'completed' },
      ]);

      const missing = await callTool<{ error: string; projectId: string; transactionId: string }>('trace_replay', { projectId: project.id, transactionId: 'tx_missing_trace' });
      expect(missing).toMatchObject({ error: 'trace_transaction_not_found', projectId: project.id, transactionId: 'tx_missing_trace' });
      expect(replayEvents).toHaveLength(4);
      const closed = await callTool<{ error: string; projectId: string }>('trace_replay', { projectId: 'project_not_open', transactionId: applied.transactionId });
      expect(closed).toEqual({ error: 'no_open_project', projectId: 'project_not_open', next: { tool: 'project_manage', arguments: { action: 'list' }, guidance: 'List projects, then activate, open, or create one before retrying.' } });

      const invalid = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name: 'trace_replay', arguments: { projectId: project.id, transactionId: applied.transactionId, action: 'hidden-route' } } }, sessionId);
      expect(invalid.message?.error).toBeUndefined();
      expect(invalid.message?.result?.isError).toBe(true);
      expect(projects.getProject(project.id)).toEqual(canonicalBefore);

      replayEvents.length = 0;
      const findTrace = projects.findTrace.bind(projects);
      let traceReads = 0;
      const findSpy = vi.spyOn(projects, 'findTrace').mockImplementation(async (projectId, transactionId) => {
        const found = await findTrace(projectId, transactionId);
        traceReads += 1;
        return traceReads === 3 && found ? { ...found, label: 'injected trace drift' } : found;
      });
      try {
        const drifted = await callTool<{ error: string; projectId: string; transactionId: string }>('trace_replay', { projectId: project.id, transactionId: applied.transactionId });
        expect(drifted).toEqual({ error: 'trace_changed_during_replay', projectId: project.id, transactionId: applied.transactionId });
      } finally {
        findSpy.mockRestore();
      }
      expect(replayEvents).toEqual([
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 0, status: 'playing' },
        { type: 'trace-replay', projectId: project.id, transactionId: applied.transactionId, progress: 1, status: 'completed' },
      ]);
      expect(projects.getProject(project.id)).toEqual(canonicalBefore);
    } finally {
      projects.off('event', onEvent);
    }
  });

  it('enforces human entity and time-range locks across authenticated sessions without blocking unrelated work', async () => {
    const first = await initialize();
    const second = await initialize();
    const callTool = async (sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      const content = response.message?.result?.content as Array<{ text: string }>;
      expect(content).toHaveLength(1);
      return JSON.parse(content[0].text) as unknown;
    };
    const joinSession = async (sessionId: string, name: string) => {
      const payload = await callTool(sessionId, 'session_manage', { action: 'join', name }) as { actor: { id: string } };
      return payload.actor.id;
    };
    const firstActorId = await joinSession(first.sessionId, 'Locked Region Agent');
    const secondActorId = await joinSession(second.sessionId, 'Unrelated Edit Agent');
    expect(firstActorId).not.toBe(secondActorId);

    const project = projects.getActiveProject()!;
    const timelineTrack = project.tracks[project.trackOrder[0]];
    const masterTrack = project.tracks[project.trackOrder[1]];
    const clip: MidiClip = {
      ...entityBase('clip', HUMAN_ACTOR), kind: 'midi', trackId: timelineTrack.id, name: 'Lock range fixture', color: '#8b5cf6', startTick: 0, durationTicks: 960,
      muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'linear' }, fadeOut: { durationTicks: 0, curve: 'linear' },
      loopEnabled: false, notes: {}, noteOrder: [], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
    };
    await expect(projects.apply({
      id: createId('tx'), clientOperationId: 'mcp-lock-fixture', projectId: project.id, actor: HUMAN_ACTOR,
      label: 'Seed lock fixture', createdAt: nowIso(), operations: [{ kind: 'clip.add', clip }], checkpointPolicy: 'none',
    }, HUMAN_ACTOR)).resolves.toMatchObject({ status: 'committed', revision: 1 });

    const entityLock = projects.acquireLock({ projectId: project.id, entityIds: [masterTrack.id] });
    const rangeLock = projects.acquireLock({ projectId: project.id, range: { trackId: timelineTrack.id, startTick: 960, endTick: 1_920 } });
    expect(entityLock).toMatchObject({ acquired: true, lockId: expect.any(String) });
    expect(rangeLock).toMatchObject({ acquired: true, lockId: expect.any(String) });
    expect(projects.holdLock(rangeLock.lockId!)).toMatchObject({ held: true, expiresAt: expect.any(String) });

    try {
      const observed = await callTool(first.sessionId, 'project_observe', { projectId: project.id, includeEditor: true }) as { editor: { locks: Array<Record<string, unknown>> } };
      expect(observed.editor.locks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: rangeLock.lockId, projectId: project.id, phase: 'grace', range: { trackId: timelineTrack.id, startTick: 960, endTick: 1_920 }, expiresAt: expect.any(String) }),
      ]));
      const entityConflict = await callTool(first.sessionId, 'project_apply', {
        projectId: project.id, clientOperationId: 'mcp-entity-lock-conflict', label: 'Conflicting master edit', commitMode: 'direct',
        operations: [{ kind: 'track.update', trackId: masterTrack.id, changes: { gainDb: -3 }, expectedRevision: masterTrack.revision }],
      });
      expect(entityConflict).toEqual({
        status: 'locked', message: 'A human is actively editing this entity or timeline range.',
        conflict: { entityId: masterTrack.id, retryable: true },
      });

      const rangeConflict = await callTool(first.sessionId, 'project_apply', {
        projectId: project.id, clientOperationId: 'mcp-range-lock-conflict', label: 'Conflicting clip move', commitMode: 'direct',
        operations: [{ kind: 'clip.move', clipId: clip.id, trackId: timelineTrack.id, startTick: 1_200, expectedRevision: clip.revision }],
      });
      expect(rangeConflict).toEqual({
        status: 'locked', message: 'A human is actively editing this entity or timeline range.',
        conflict: { retryable: true },
      });

      const unrelated = await callTool(second.sessionId, 'project_apply', {
        projectId: project.id, clientOperationId: 'mcp-lock-unrelated-edit', label: 'Unrelated track edit', commitMode: 'direct',
        operations: [{ kind: 'track.update', trackId: timelineTrack.id, changes: { gainDb: -2 }, expectedRevision: timelineTrack.revision }],
      });
      expect(unrelated).toMatchObject({ status: 'committed', revision: 2 });
      expect(projects.getActiveProject()).toMatchObject({
        revision: 2,
        tracks: {
          [timelineTrack.id]: { gainDb: -2, revision: 1, updatedBy: secondActorId },
          [masterTrack.id]: { gainDb: masterTrack.gainDb, revision: masterTrack.revision },
        },
        clips: { [clip.id]: { startTick: clip.startTick, revision: clip.revision } },
      });
    } finally {
      projects.releaseLock(entityLock.lockId!);
      projects.releaseLock(rangeLock.lockId!);
    }
    const afterRelease = await callTool(first.sessionId, 'session_manage', { action: 'inspect' }) as { locks: unknown[] };
    expect(afterRelease.locks).toEqual([]);
  });

  it('keeps job payloads and cancellation authority scoped to the owning session', async () => {
    const first = await initialize();
    const second = await initialize();
    const callTool = async (sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      const content = response.message?.result?.content as Array<{ text: string }>;
      expect(content).toHaveLength(1);
      return JSON.parse(content[0].text) as unknown;
    };
    const joinSession = async (sessionId: string, name: string) => {
      const payload = await callTool(sessionId, 'session_manage', { action: 'join', name }) as { actor: { id: string } };
      return payload.actor.id;
    };
    const firstActorId = await joinSession(first.sessionId, 'Job Owner A');
    await joinSession(second.sessionId, 'Job Observer B');
    const timestamp = nowIso();
    const projectId = projects.getActiveProject()!.id;
    const ownerOnly = 'owner-a-private-payload-sentinel';
    const cancellable: AsyncJob = { id: 'job-owner-cancellable', ownerActorId: firstActorId, projectId, kind: 'analysis', status: 'running', progress: 0.4, message: 'Owner job running.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, result: { ownerOnly } };
    const completed: AsyncJob = { id: 'job-owner-completed', ownerActorId: firstActorId, projectId, kind: 'analysis', status: 'completed', progress: 1, message: 'Owner job complete.', createdAt: timestamp, updatedAt: timestamp, cancellable: false, result: { ownerOnly, output: 'analysis-result' } };
    const approval: AsyncJob = { id: 'job-owner-approval', ownerActorId: firstActorId, projectId, kind: 'approval', status: 'waiting-for-user', progress: 0, message: 'Owner approval required.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, approval: { kind: 'file-read', summary: 'Read owner fixture', request: { ownerOnly, path: join(root, 'owner-fixture.wav') }, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    projects.upsertJob(cancellable); projects.upsertJob(completed); projects.upsertJob(approval);

    const foreignList = await callTool(second.sessionId, 'job_manage', { action: 'list' });
    const foreignInspect = await callTool(second.sessionId, 'job_manage', { action: 'inspect', jobId: completed.id });
    const foreignWait = await callTool(second.sessionId, 'job_manage', { action: 'wait', jobId: cancellable.id, timeoutMs: 1 });
    const foreignDependency = await callTool(second.sessionId, 'job_manage', { action: 'approval-dependency', jobId: approval.id });
    const beforeForeignCancel = projects.getJob(cancellable.id);
    const foreignCancel = await callTool(second.sessionId, 'job_manage', { action: 'cancel', jobId: cancellable.id });
    expect(foreignList).toEqual([]);
    expect(foreignInspect).toEqual({ error: 'job_not_found' });
    expect(foreignWait).toEqual({ error: 'job_not_found' });
    expect(foreignDependency).toEqual({ error: 'job_not_found' });
    expect(foreignCancel).toEqual({ error: 'job_not_found' });
    expect(JSON.stringify([foreignList, foreignInspect, foreignWait, foreignDependency, foreignCancel])).not.toContain(ownerOnly);
    expect(projects.getJob(cancellable.id)).toEqual(beforeForeignCancel);

    const ownerList = await callTool(first.sessionId, 'job_manage', { action: 'list' }) as Array<{ id: string }>;
    expect(ownerList.map((job) => job.id).sort()).toEqual([approval.id, cancellable.id, completed.id].sort());
    const ownerInspect = await callTool(first.sessionId, 'job_manage', { action: 'inspect', jobId: completed.id });
    expect(ownerInspect).toMatchObject({ id: completed.id, status: 'completed', result: { ownerOnly, output: 'analysis-result' } });
    const ownerDependency = await callTool(first.sessionId, 'job_manage', { action: 'approval-dependency', jobId: approval.id });
    expect(ownerDependency).toMatchObject({ id: approval.id, status: 'waiting-for-user', dependency: { type: 'user-approval', approval: { request: { ownerOnly } } } });
    const ownerWait = await callTool(first.sessionId, 'job_manage', { action: 'wait', jobId: cancellable.id, timeoutMs: 0 });
    expect(ownerWait).toMatchObject({ id: cancellable.id, status: 'running' });
    const ownerCancel = await callTool(first.sessionId, 'job_manage', { action: 'cancel', jobId: cancellable.id });
    expect(ownerCancel).toMatchObject({ id: cancellable.id, status: 'cancelled', message: 'Cancelled.' });
    expect(projects.getJob(cancellable.id)).toMatchObject({ status: 'cancelled' });
    expect(await callTool(second.sessionId, 'job_manage', { action: 'list' })).toEqual([]);
  });

  it('keeps file approvals owner-private and records an authorized save as durable non-undoable actor audit', async () => {
    const allowedRoot = join(root, 'file-authority', 'allowed');
    const outsideRoot = join(root, 'file-authority', 'outside');
    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const now = Date.now();
    const policy: AuthorityPolicy = {
      version: 1, id: 'mcp-file-authority', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [], writeRoots: [allowedRoot], overwritePaths: [], pluginAllowlist: [], allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
    };
    await expect(authority.install(policy)).resolves.toEqual({ installed: true });

    const first = await initialize();
    const second = await initialize();
    const callTool = async (sessionId: string, name: string, args: Record<string, unknown>) => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      expect(response.message?.result?.isError).not.toBe(true);
      const content = response.message?.result?.content as Array<{ text: string }>;
      return { payload: JSON.parse(content[0].text) as Record<string, unknown>, result: response.message?.result };
    };
    const joinSession = async (sessionId: string, name: string) => ((await callTool(sessionId, 'session_manage', { action: 'join', name })).payload.actor as { id: string }).id;
    const firstActorId = await joinSession(first.sessionId, 'File Approval Owner');
    const secondActorId = await joinSession(second.sessionId, 'Authorized Saver');
    expect(firstActorId).not.toBe(secondActorId);

    const project = projects.getActiveProject()!;
    const initialRevision = project.revision;
    const initialActivity = project.activity;
    const privateSentinel = 'owner-only-outside-save-sentinel';
    const outsideTarget = join(outsideRoot, privateSentinel);
    const queued = (await callTool(first.sessionId, 'project_manage', { action: 'save', projectId: project.id, path: outsideTarget })).payload;
    const jobId = String(queued.jobId);
    expect(queued).toMatchObject({ jobId: expect.any(String), status: 'waiting-for-user', dependency: { type: 'user-approval', approval: { kind: 'file-write', request: { action: 'save', projectId: project.id, path: expect.stringContaining(privateSentinel) } } }, next: { tool: 'job_manage', humanRequired: true } });
    expect(projects.listJobs()).toHaveLength(1);
    expect(projects.listJobs(firstActorId)).toEqual([expect.objectContaining({ id: jobId, ownerActorId: firstActorId, status: 'waiting-for-user' })]);
    expect(projects.listJobs(secondActorId)).toEqual([]);
    expect(projects.snapshot().jobs).toEqual([expect.objectContaining({ id: jobId, approval: expect.any(Object) })]);
    expect(projects.snapshot(secondActorId).jobs).toEqual([]);
    await expect(access(outsideTarget)).rejects.toThrow();
    await expect(access(`${outsideTarget}.aimuse`)).rejects.toThrow();

    const ownerWait = (await callTool(first.sessionId, 'job_manage', { action: 'wait', jobId, timeoutMs: 0 })).payload;
    expect(ownerWait).toMatchObject({ id: jobId, status: 'waiting-for-user', dependency: { type: 'user-approval' }, next: { tool: 'job_manage', humanRequired: true } });
    const foreignTool = (await callTool(second.sessionId, 'job_manage', { action: 'inspect', jobId })).payload;
    expect(foreignTool).toEqual({ error: 'job_not_found' });

    const readJsonResource = async (sessionId: string, uri: string) => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'resources/read', params: { uri } }, sessionId);
      const content = response.message?.result?.contents as Array<{ text: string }> | undefined;
      return { response, value: content ? JSON.parse(content[0].text) as unknown : undefined };
    };
    const ownerSessions = await readJsonResource(first.sessionId, 'aimuse://sessions');
    const foreignSessions = await readJsonResource(second.sessionId, 'aimuse://sessions');
    expect(ownerSessions.value).toMatchObject({ jobs: [expect.objectContaining({ id: jobId, dependency: expect.objectContaining({ type: 'user-approval' }) })] });
    expect(foreignSessions.value).toMatchObject({ jobs: [] });
    expect(JSON.stringify(foreignSessions.value)).not.toContain(privateSentinel);
    expect(JSON.stringify(foreignSessions.value)).not.toContain(jobId);

    const ownerResource = await readJsonResource(first.sessionId, `aimuse://jobs/${jobId}`);
    expect(ownerResource.value).toMatchObject({ id: jobId, dependency: { approval: { request: { path: expect.stringContaining(privateSentinel) } } } });
    const foreignResource = await readJsonResource(second.sessionId, `aimuse://jobs/${jobId}`);
    const missingResource = await readJsonResource(second.sessionId, 'aimuse://jobs/job-does-not-exist');
    expect(foreignResource.response.message?.error).toMatchObject({ code: missingResource.response.message?.error?.code, message: missingResource.response.message?.error?.message });
    expect(JSON.stringify(foreignResource.response.message?.error)).not.toContain(privateSentinel);
    expect(JSON.stringify(foreignResource.response.message?.error)).not.toContain(jobId);

    const approvedTarget = join(allowedRoot, 'session-b-owned-save');
    const saved = (await callTool(second.sessionId, 'project_manage', { action: 'save', projectId: project.id, path: approvedTarget })).payload;
    expect(saved).toMatchObject({ projectPath: expect.stringMatching(/session-b-owned-save\.aimuse$/i), warnings: [], audit: { version: 1, type: 'file.saved', projectId: project.id, actor: { id: secondActorId, kind: 'agent', name: 'Authorized Saver' }, outcome: 'succeeded', recordedAt: expect.any(String) } });
    const savedPath = String(saved.projectPath);
    await expect(access(join(savedPath, 'project.json'))).resolves.toBeUndefined();
    const persistedAudit = JSON.parse((await readFile(join(savedPath, 'activity', 'file-audit.jsonl'), 'utf8')).trim()) as Record<string, unknown>;
    expect(persistedAudit).toEqual(saved.audit);
    expect(JSON.stringify(persistedAudit)).not.toContain(savedPath);
    expect(JSON.stringify(persistedAudit)).not.toContain(privateSentinel);
    expect(projects.getActiveProject()).toMatchObject({ revision: initialRevision, dirty: false, activity: initialActivity });
    expect(projects.snapshot(secondActorId).canUndo).toBe(false);

    const observed = (await callTool(second.sessionId, 'project_observe', { projectId: project.id, includeFileAudit: true })).payload;
    expect(observed).toMatchObject({ revision: initialRevision, fileAudit: [persistedAudit] });
    expect(JSON.stringify(observed.fileAudit)).not.toContain(savedPath);
    expect(JSON.stringify(observed.fileAudit)).not.toContain(privateSentinel);
    expect(projects.listJobs()).toEqual([expect.objectContaining({ id: jobId, ownerActorId: firstActorId, status: 'waiting-for-user' })]);
    await expect(access(outsideTarget)).rejects.toThrow();
    await expect(access(`${outsideTarget}.aimuse`)).rejects.toThrow();
  });

  it('serializes approval-capable requests across actors without creating or leaking a competing job', async () => {
    const first = await initialize();
    const second = await initialize();
    const callTool = async (sessionId: string, name: string, args: Record<string, unknown>) => {
      const response = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'tools/call', params: { name, arguments: args } }, sessionId);
      expect(response.message?.error).toBeUndefined();
      const content = response.message?.result?.content as Array<{ text: string }>;
      return JSON.parse(content[0].text) as Record<string, unknown>;
    };
    await callTool(first.sessionId, 'session_manage', { action: 'join', name: 'Approval Owner A' });
    await callTool(second.sessionId, 'session_manage', { action: 'join', name: 'Approval Requester B' });
    const projectId = projects.getActiveProjectId()!;
    const firstDestination = join(root, 'approval-owner-private-midi');
    const rejectedDestination = join(root, 'approval-requester-private-dawproject');
    const laterDestination = join(root, 'approval-later-dawproject');
    const finalDestination = join(root, 'approval-final-stems');
    let maxWaiting = 0;
    projects.on('event', (event: WorkspaceEvent) => { if (event.type === 'job') maxWaiting = Math.max(maxWaiting, projects.listJobs().filter((job) => job.status === 'waiting-for-user').length); });

    const started = await callTool(first.sessionId, 'export_manage', { projectId, kind: 'midi', destination: firstDestination, overwrite: false });
    const firstJobId = String(started.jobId);
    expect(firstJobId).toMatch(/^export-/);
    const beforeRejectedCount = projects.listJobs().length;
    const rejected = await callTool(second.sessionId, 'export_manage', { projectId, kind: 'dawproject', destination: rejectedDestination, overwrite: false });
    expect(rejected).toMatchObject({ error: 'approval_pending', retryable: true, next: { humanRequired: true } });
    expect(rejected).not.toHaveProperty('jobId');
    expect(projects.listJobs()).toHaveLength(beforeRejectedCount);
    expect(JSON.stringify(rejected)).not.toContain(firstJobId);
    expect(JSON.stringify(rejected)).not.toContain(firstDestination);
    expect(JSON.stringify(rejected)).not.toContain(rejectedDestination);
    const crossToolRejected = await callTool(second.sessionId, 'transport_manage', { action: 'record', recordingSource: 'microphone' });
    expect(crossToolRejected).toMatchObject({ error: 'approval_pending', retryable: true, next: { humanRequired: true } });
    expect(crossToolRejected).not.toHaveProperty('jobId');
    expect(projects.listJobs()).toHaveLength(beforeRejectedCount);
    expect(JSON.stringify(crossToolRejected)).not.toContain(firstJobId);
    expect(JSON.stringify(crossToolRejected)).not.toContain(firstDestination);

    const waiting = await callTool(first.sessionId, 'job_manage', { action: 'wait', jobId: firstJobId, timeoutMs: 5_000 });
    expect(waiting).toMatchObject({ id: firstJobId, status: 'waiting-for-user', dependency: { type: 'user-approval' } });
    expect(projects.listJobs().filter((job) => job.status === 'waiting-for-user')).toHaveLength(1);
    expect(maxWaiting).toBe(1);

    expect(projects.resolveJob(firstJobId, 'allow-once')).toMatchObject({ status: 'queued' });
    const completed = await callTool(first.sessionId, 'job_manage', { action: 'wait', jobId: firstJobId, timeoutMs: 5_000 });
    expect(completed).toMatchObject({ id: firstJobId, status: 'completed' });
    await expect(access(`${firstDestination}.mid`)).resolves.toBeUndefined();

    const later = await callTool(second.sessionId, 'export_manage', { projectId, kind: 'dawproject', destination: laterDestination, overwrite: false });
    const laterJobId = String(later.jobId);
    expect(await callTool(second.sessionId, 'job_manage', { action: 'wait', jobId: laterJobId, timeoutMs: 5_000 })).toMatchObject({ id: laterJobId, status: 'waiting-for-user' });
    expect(await callTool(second.sessionId, 'job_manage', { action: 'cancel', jobId: laterJobId })).toMatchObject({ id: laterJobId, status: 'cancelled' });
    await expect(access(laterDestination)).rejects.toThrow();
    await expect(access(`${laterDestination}.dawproject`)).rejects.toThrow();

    const afterCancellation = await callTool(first.sessionId, 'export_manage', { projectId, kind: 'stems', destination: finalDestination, overwrite: false });
    const finalJobId = String(afterCancellation.jobId);
    expect(await callTool(first.sessionId, 'job_manage', { action: 'wait', jobId: finalJobId, timeoutMs: 5_000 })).toMatchObject({ id: finalJobId, status: 'waiting-for-user' });
    expect(await callTool(first.sessionId, 'job_manage', { action: 'cancel', jobId: finalJobId })).toMatchObject({ id: finalJobId, status: 'cancelled' });
    expect(maxWaiting).toBe(1);
    await expect(access(finalDestination)).rejects.toThrow();
  });

  it('reserves the 32-session capacity across genuinely parallel initializes and recovers it after MCP DELETE', async () => {
    const closes = new Map<string, number>();
    await restartHostWithLifecycleHooks({ sessionClosed: (reservationId) => closes.set(reservationId, (closes.get(reservationId) ?? 0) + 1) });
    const attempts = await Promise.all(Array.from({ length: 33 }, (_, index) => request({
      jsonrpc: '2.0', id: createRequestId(), method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: `parallel-${index}`, version: '1' } },
    })));
    const accepted = attempts.filter(({ response }) => response.status === 200);
    const rejected = attempts.filter(({ response }) => response.status === 503);
    expect(accepted).toHaveLength(32);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].response.headers.get('retry-after')).toBe('5');
    expect(rejected[0].message).toMatchObject({ error: 'session_limit' });
    const sessions = accepted.map(({ response }) => response.headers.get('mcp-session-id'));
    expect(sessions.every(Boolean)).toBe(true);
    expect(new Set(sessions).size).toBe(32);
    expect(closes.size).toBe(0);

    const removed = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessions[0]! } });
    expect([200, 202, 204]).toContain(removed.status);
    expect([...closes.values()]).toEqual([1]);
    expect((await initialize()).sessionId).toBeTruthy();
    expect([...closes.values()]).toEqual([1]);
  });

  it('releases failed and client-aborted initialize reservations and closes each unadopted session exactly once', async () => {
    const closes = new Map<string, number>();
    let failBeforeConnect = true;
    await restartHostWithLifecycleHooks({
      beforeConnect: async () => { if (failBeforeConnect) { failBeforeConnect = false; throw new Error('simulated session allocation failure'); } },
      sessionClosed: (reservationId) => closes.set(reservationId, (closes.get(reservationId) ?? 0) + 1),
    });
    const failed = await request({
      jsonrpc: '2.0', id: createRequestId(), method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'failed-allocation', version: '1' } },
    });
    expect(failed.response.status).toBe(500);
    expect(failed.response.headers.get('mcp-session-id')).toBeNull();
    expect([...closes.values()]).toEqual([1]);
    expect((await initialize()).sessionId).toBeTruthy();
    const rejected = await request({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: {} });
    expect(rejected.response.status).toBe(400);
    expect(rejected.response.headers.get('mcp-session-id')).toBeNull();
    expect(rejected.message?.error).toBeTruthy();
    expect([...closes.values()]).toEqual([1, 1]);

    let releaseInitialize!: () => void;
    let initializeEntered!: () => void;
    let abortObserved!: () => void;
    const initializeRelease = new Promise<void>((resolvePromise) => { releaseInitialize = resolvePromise; });
    const initializeStarted = new Promise<void>((resolvePromise) => { initializeEntered = resolvePromise; });
    const initializeAbortObserved = new Promise<void>((resolvePromise) => { abortObserved = resolvePromise; });
    let pauseNextInitialize = true;
    await restartHostWithLifecycleHooks({
      beforeInitializeHandle: async () => { if (pauseNextInitialize) { pauseNextInitialize = false; initializeEntered(); await initializeRelease; } },
      initializationAborted: () => abortObserved(),
      sessionClosed: (reservationId) => closes.set(reservationId, (closes.get(reservationId) ?? 0) + 1),
    });
    closes.clear();
    let abortingRequest!: ClientRequest;
    const aborted = new Promise<void>((resolvePromise) => {
      abortingRequest = httpRequest(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      }, (response) => { response.resume(); response.once('end', resolvePromise); });
      abortingRequest.once('error', () => resolvePromise());
      abortingRequest.once('close', () => resolvePromise());
      abortingRequest.end(JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'aborted-initialize', version: '1' } } }));
    });
    await initializeStarted;
    abortingRequest.destroy();
    await aborted;
    await initializeAbortObserved;
    releaseInitialize();
    const deadline = Date.now() + 2_000;
    while (!closes.size && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect([...closes.values()]).toEqual([1]);
    expect((await initialize()).sessionId).toBeTruthy();
  });

  it('invalidates and cleans a late allocation before repeated stop calls settle', async () => {
    const closes = new Map<string, number>();
    let releaseConnect!: () => void;
    let connectEntered!: () => void;
    const connectRelease = new Promise<void>((resolvePromise) => { releaseConnect = resolvePromise; });
    const connectStarted = new Promise<void>((resolvePromise) => { connectEntered = resolvePromise; });
    await restartHostWithLifecycleHooks({
      beforeConnect: async () => { connectEntered(); await connectRelease; },
      sessionClosed: (reservationId) => closes.set(reservationId, (closes.get(reservationId) ?? 0) + 1),
    });
    const initializing = fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'late-allocation', version: '1' } } }),
    });
    await connectStarted;
    let stopped = false;
    const firstStop = host.stop().then(() => { stopped = true; });
    const repeatedStop = host.stop();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(stopped).toBe(false);
    expect([...closes.values()]).toEqual([1]);
    releaseConnect();
    await Promise.all([firstStop, repeatedStop]);
    await Promise.allSettled([initializing]);
    await host.stop();
    expect([...closes.values()]).toEqual([1]);
    expect(host.connection()).toMatchObject({ url: undefined, token: '' });
  });

  it('awaits and cleans a connected initialize that races with stop without adopting it', async () => {
    const closes = new Map<string, number>();
    let releaseInitialize!: () => void;
    let initializeEntered!: () => void;
    const initializeRelease = new Promise<void>((resolvePromise) => { releaseInitialize = resolvePromise; });
    const initializeStarted = new Promise<void>((resolvePromise) => { initializeEntered = resolvePromise; });
    await restartHostWithLifecycleHooks({
      beforeInitializeHandle: async () => { initializeEntered(); await initializeRelease; },
      sessionClosed: (reservationId) => closes.set(reservationId, (closes.get(reservationId) ?? 0) + 1),
    });
    const initializing = fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stop-racing-initialize', version: '1' } } }),
    });
    await initializeStarted;
    let stopped = false;
    const stopping = host.stop().then(() => { stopped = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(stopped).toBe(false);
    expect([...closes.values()]).toEqual([1]);
    releaseInitialize();
    await stopping;
    await Promise.allSettled([initializing]);
    expect([...closes.values()]).toEqual([1]);
    expect(host.connection()).toMatchObject({ url: undefined, token: '' });
  });

  it('reauthenticates slow authenticated POST bodies against the live shutdown generation before routing', async () => {
    let armed = false;
    let admitted!: (generation: number) => void;
    const admittedGenerations: number[] = [];
    const armNextPost = () => new Promise<number>((resolvePromise) => { armed = true; admitted = resolvePromise; });
    await restartHostWithLifecycleHooks({
      requestAuthenticated: (method, pathname, generation) => {
        if (!armed || method !== 'POST' || pathname !== '/mcp') return;
        armed = false;
        admittedGenerations.push(generation);
        admitted(generation);
      },
    });

    const expectStoppedChunkedPost = async (firstChunk: string, finalChunk: string, sessionId?: string) => {
      const admittedRequest = armNextPost();
      const pending = beginChunkedPost(url, token, firstChunk, sessionId);
      await admittedRequest;
      const stopping = host.stop();
      pending.request.end(finalChunk);
      const result = await pending.response;
      expect(result.status).toBe(401);
      expect(result.headers['www-authenticate']).toContain('Bearer');
      expect(result.body).toBe('{"error":"invalid_token"}');
      expect(result.body).not.toContain(host.connection().instanceId);
      expect(result.body).not.toContain(host.connection().profileId);
      await stopping;
    };

    const existing = await initialize();
    await expectStoppedChunkedPost(
      `{"jsonrpc":"2.0","id":${createRequestId()},"method":"tools/`,
      'list","params":{}}',
      existing.sessionId,
    );

    url = (await host.start(token)).url;
    await expectStoppedChunkedPost(
      `{"jsonrpc":"2.0","id":${createRequestId()},"method":"init`,
      `ialize","params":{"protocolVersion":"${LATEST_PROTOCOL_VERSION}","capabilities":{},"clientInfo":{"name":"slow-initialize","version":"1"}}}`,
    );

    url = (await host.start(token)).url;
    await expectStoppedChunkedPost('{not-', 'json');
    expect(admittedGenerations).toHaveLength(3);
    expect(admittedGenerations[1]).toBeGreaterThan(admittedGenerations[0]);
    expect(admittedGenerations[2]).toBeGreaterThan(admittedGenerations[1]);

    const rotatedToken = Buffer.alloc(32, 0x76).toString('base64url');
    url = (await host.start(rotatedToken)).url;
    const stale = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stale-after-restart', version: '1' } } }),
    });
    expect(stale.status).toBe(401);
    await expect(stale.text()).resolves.toBe('{"error":"invalid_token"}');
    const current = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${rotatedToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'fresh-after-restart', version: '1' } } }),
    });
    expect(current.status).toBe(200);
    expect(current.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects blank, invalid, wrong, and stale authority on every TCP route while stop is blocked', async () => {
    let releaseInitialize!: () => void;
    let initializeEntered!: () => void;
    const initializeRelease = new Promise<void>((resolvePromise) => { releaseInitialize = resolvePromise; });
    const initializeStarted = new Promise<void>((resolvePromise) => { initializeEntered = resolvePromise; });
    await restartHostWithLifecycleHooks({ beforeInitializeHandle: async () => { initializeEntered(); await initializeRelease; } });

    const stoppingUrl = url;
    const initializing = fetch(stoppingUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: createRequestId(), method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'blocked-stop-authentication', version: '1' } } }),
    });
    await initializeStarted;
    let stopped = false;
    const stopping = host.stop().then(() => { stopped = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(stopped).toBe(false);

    const wrongToken = Buffer.alloc(32, 0x75).toString('base64url');
    const authorities: Array<string | undefined> = [undefined, 'Bearer ', 'Bearer malformed', `Bearer ${wrongToken}`, `Bearer ${token}`];
    const routes: Array<{ path: string; method: string; body?: string }> = [
      { path: '/health', method: 'GET' },
      { path: '/mcp', method: 'OPTIONS' },
      { path: '/mcp', method: 'GET' },
      { path: '/mcp', method: 'POST', body: '{not-json' },
      { path: '/mcp', method: 'DELETE' },
      { path: '/not-a-route', method: 'GET' },
    ];

    try {
      for (const route of routes) {
        for (const authorization of authorities) {
          const response = await fetch(new URL(route.path, stoppingUrl), {
            method: route.method,
            headers: { ...(authorization === undefined ? {} : { authorization }), ...(route.body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(route.body === undefined ? {} : { body: route.body }),
          });
          expect(response.status, `${route.method} ${route.path} with ${authorization ?? '<absent>'}`).toBe(401);
          expect(response.headers.get('www-authenticate')).toContain('Bearer');
          const text = await response.text();
          expect(text).toBe('{"error":"invalid_token"}');
          expect(text).not.toContain('AIMuse Engine');
          expect(text).not.toContain(host.connection().instanceId);
          expect(text).not.toContain(host.connection().profileId);
        }
      }
    } finally {
      releaseInitialize();
      await Promise.allSettled([initializing, stopping]);
    }
    expect(stopped).toBe(true);
    expect(host.connection()).toMatchObject({ url: undefined, token: '' });
  });
});
