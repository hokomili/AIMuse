import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { packagedE2eSubject } from './package-subject';

const packagedSubject = packagedE2eSubject();
const executable = packagedSubject.executable;
interface RpcResponse { jsonrpc: '2.0'; id?: number; result?: Record<string, unknown>; error?: Record<string, unknown> }

async function waitForExit(process: ChildProcess, label: string, timeoutMilliseconds = 15_000): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(process, 'exit'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMilliseconds} ms.`)), timeoutMilliseconds); timer.unref(); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function rpc(url: string, token: string, body: unknown, sessionId?: string): Promise<{ response: Response; message?: RpcResponse }> {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!text) return { response };
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5).trim()) as RpcResponse);
    return { response, message: messages.at(-1) };
  }
  return { response, message: JSON.parse(text) as RpcResponse };
}

function toolPayload<T>(message?: RpcResponse): T {
  const content = message?.result?.content as Array<{ text?: string }> | undefined;
  if (!content?.[0]?.text) throw new Error(`Missing MCP tool payload: ${JSON.stringify(message)}`);
  return JSON.parse(content[0].text) as T;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback QA port.');
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForConnectionFile(path: string): Promise<{ version: 1; url: string; token: string; pid: number; activeProjectId: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) as { version: 1; url: string; token: string; pid: number; activeProjectId: string }; }
    catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
  }
  throw new Error('AIMuse did not publish its private MCP connection file.');
}

async function connectToPackagedEditor(port: number): Promise<{ browser: Browser; page: Page }> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0];
        if (!context) throw new Error('Packaged AIMuse did not expose an editor context.');
        while (Date.now() < deadline) {
          const page = context.pages().find((candidate) => candidate.url().startsWith('aimuse://app/'));
          if (page) return { browser, page };
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
        await browser.close();
      }
    } catch { /* The exact packaged process is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Could not attach to the packaged AIMuse editor over its test-only loopback DevTools port.');
}

test.describe('packaged cross-surface smoke', () => {
  test.skip(!packagedSubject.exact && !existsSync(executable), 'Run npm run package before packaged desktop QA.');

  let applicationProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let testRoot: string;

  test.beforeEach(async () => { testRoot = await mkdtemp(join(tmpdir(), 'aimuse-e2e-')); });
  test.afterEach(async () => {
    if (applicationProcess) {
      const quitter = spawn(executable, ['--quit-engine', `--user-data-dir=${join(testRoot, 'user-data')}`], { stdio: 'ignore', windowsHide: true });
      await waitForExit(quitter, 'AIMuse lifecycle client');
      await waitForExit(applicationProcess, 'AIMuse engine');
    }
    await browser?.close().catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('uses one canonical project across the packaged editor and authenticated MCP engine', async ({ browserName }, testInfo) => {
    void browserName;
    const userData = join(testRoot, 'user-data'); const connectionPath = join(testRoot, 'private-mcp.json');
    const cdpPort = await reserveLoopbackPort();
    applicationProcess = spawn(executable, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`, `--write-mcp-connection=${connectionPath}`], { stdio: 'ignore', windowsHide: true });
    const connection = await waitForConnectionFile(connectionPath);
    const attachedEditor = await connectToPackagedEditor(cdpPort);
    browser = attachedEditor.browser;
    const window = attachedEditor.page;
    await expect(window).toHaveTitle(/AIMuse/);
    await expect(window.locator('.app-brand')).toContainText('AIMuse');
    await expect(window.getByText('New Song', { exact: true }).first()).toBeVisible();

    await window.getByRole('button', { name: 'MIDI clip', exact: true }).click();
    await expect(window.getByText('New idea', { exact: true }).first()).toBeVisible();

    expect(connection).toMatchObject({ version: 1, pid: applicationProcess.pid, activeProjectId: expect.stringMatching(/^project_/) });
    expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:48\d{3}\/mcp$/);

    const healthUrl = connection.url.replace('/mcp', '/health');
    const unauthenticatedHealth = await fetch(healthUrl);
    expect(unauthenticatedHealth.status).toBe(401);
    const health = await fetch(healthUrl, { headers: { authorization: `Bearer ${connection.token}`, accept: 'application/json' } });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ name: 'AIMuse Engine', version: '0.1.0-alpha.0', status: 'ok', uiRequired: false });
    const unauthorized = await fetch(connection.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);

    let requestId = 0;
    const initialized = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'AIMuse packaged QA', version: '1' } } });
    expect(initialized.response.status).toBe(200);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await rpc(connection.url, connection.token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!);
    await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'session_manage', arguments: { action: 'join', name: 'Packaged QA Agent', client: { product: 'playwright', model: 'fixture' } } } }, sessionId!);

    const observed = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'project_observe', arguments: { projectId: connection.activeProjectId, includeEditor: true } } }, sessionId!);
    const observation = toolPayload<{ project: { clips: Record<string, { name: string }> }; editor: { selection?: unknown } }>(observed.message);
    expect(Object.values(observation.project.clips).some((clip) => clip.name === 'New idea')).toBe(true);

    const applied = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'project_apply', arguments: { projectId: connection.activeProjectId, clientOperationId: 'packaged-cross-surface-rename-1', label: 'Rename from packaged MCP client', operations: [{ kind: 'project.rename', name: 'MCP Coauthored Song' }], commitMode: 'direct' } } }, sessionId!);
    const appliedPayload = toolPayload<{ status: string; revision: number; transactionId: string }>(applied.message);
    expect(appliedPayload).toMatchObject({ status: 'committed', transactionId: expect.stringMatching(/^tx_/) });
    await expect(window.getByText('MCP Coauthored Song', { exact: true }).first()).toBeVisible();

    const beforeReplayResponse = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'project_observe', arguments: { projectId: connection.activeProjectId } } }, sessionId!);
    const beforeReplay = toolPayload<{ project: Record<string, unknown> }>(beforeReplayResponse.message);
    const replayed = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'trace_replay', arguments: { projectId: connection.activeProjectId, transactionId: appliedPayload.transactionId } } }, sessionId!);
    const replayReceipt = toolPayload<{
      status: string; projectId: string; transactionId: string; auditSha256: string;
      source: { resource: string; revision: number; operationCount: number; operationKinds: string[]; entrySha256: string; transactionSha256: string };
      replay: { mode: string; appliedOperations: number; progressEventCount: number; steps: Array<Record<string, unknown>> };
      canonical: { beforeRevision: number; afterRevision: number; beforeSha256: string; afterSha256: string; unchanged: boolean };
    }>(replayed.message);
    expect(replayReceipt).toMatchObject({
      status: 'completed', projectId: connection.activeProjectId, transactionId: appliedPayload.transactionId,
      source: {
        resource: `aimuse://projects/${connection.activeProjectId}/trace`, revision: appliedPayload.revision,
        operationCount: 1, operationKinds: ['project.rename'], entrySha256: expect.stringMatching(/^[0-9a-f]{64}$/), transactionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      replay: {
        mode: 'non-mutating-visualization', appliedOperations: 0, progressEventCount: 2,
        steps: [{ index: 0, kind: 'project.rename', progressStart: 0, progressEnd: 1 }],
      },
      canonical: { beforeRevision: appliedPayload.revision, afterRevision: appliedPayload.revision, unchanged: true },
      auditSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(replayReceipt.canonical.beforeSha256).toBe(replayReceipt.canonical.afterSha256);
    const afterReplayResponse = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'project_observe', arguments: { projectId: connection.activeProjectId } } }, sessionId!);
    expect(toolPayload<{ project: Record<string, unknown> }>(afterReplayResponse.message)).toEqual(beforeReplay);
    await expect(window.getByText('MCP Coauthored Song', { exact: true }).first()).toBeVisible();

    const firstApprovalResponse = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'export_manage', arguments: { projectId: connection.activeProjectId, kind: 'midi', destination: join(testRoot, 'approval-first'), overwrite: false } } }, sessionId!);
    const firstApproval = toolPayload<{ jobId: string }>(firstApprovalResponse.message);
    expect(firstApproval.jobId).toMatch(/^export-/);
    const competingResponse = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'export_manage', arguments: { projectId: connection.activeProjectId, kind: 'dawproject', destination: join(testRoot, 'approval-competing'), overwrite: false } } }, sessionId!);
    const competing = toolPayload<{ error: string; retryable: boolean; jobId?: string; next: { humanRequired: boolean } }>(competingResponse.message);
    expect(competing).toMatchObject({ error: 'approval_pending', retryable: true, next: { humanRequired: true } });
    expect(competing).not.toHaveProperty('jobId');
    expect(JSON.stringify(competing)).not.toContain(firstApproval.jobId);
    const waitForApproval = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'wait', jobId: firstApproval.jobId, timeoutMs: 5_000 } } }, sessionId!);
    expect(toolPayload<{ id: string; status: string }>(waitForApproval.message)).toMatchObject({ id: firstApproval.jobId, status: 'waiting-for-user' });
    const jobsWhilePending = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'list' } } }, sessionId!);
    expect(toolPayload<Array<{ id: string; status: string }>>(jobsWhilePending.message).filter((job) => job.status === 'waiting-for-user')).toEqual([{ id: firstApproval.jobId, status: 'waiting-for-user', kind: 'render', progress: 0, message: 'No process-lifetime authority policy is installed.', createdAt: expect.any(String), updatedAt: expect.any(String), projectId: connection.activeProjectId, dependency: expect.any(Object), next: expect.any(Object) }]);
    const cancelledApproval = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'cancel', jobId: firstApproval.jobId } } }, sessionId!);
    expect(toolPayload<{ status: string }>(cancelledApproval.message)).toMatchObject({ status: 'cancelled' });
    const afterCancellationResponse = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'export_manage', arguments: { projectId: connection.activeProjectId, kind: 'stems', destination: join(testRoot, 'approval-after-cancel'), overwrite: false } } }, sessionId!);
    const afterCancellation = toolPayload<{ jobId: string }>(afterCancellationResponse.message);
    expect(afterCancellation.jobId).toMatch(/^export-/);
    const waitAfterCancellation = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'wait', jobId: afterCancellation.jobId, timeoutMs: 5_000 } } }, sessionId!);
    expect(toolPayload<{ id: string; status: string }>(waitAfterCancellation.message)).toMatchObject({ id: afterCancellation.jobId, status: 'waiting-for-user' });
    const cancelAfterCancellation = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'job_manage', arguments: { action: 'cancel', jobId: afterCancellation.jobId } } }, sessionId!);
    expect(toolPayload<{ status: string }>(cancelAfterCancellation.message)).toMatchObject({ status: 'cancelled' });

    const transport = async (action: 'status' | 'play' | 'pause' | 'seek', tick?: number) => {
      const result = await rpc(connection.url, connection.token, { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name: 'transport_manage', arguments: { action, ...(tick === undefined ? {} : { tick }) } } }, sessionId!);
      return toolPayload<{ status: string; tick: number; sample: number }>(result.message);
    };

    // A prepared revision must start promptly, and a normal project edit must not
    // stop playback or rewind the creator to the beginning of the song.
    await transport('seek', 7_213);
    const playStartedAt = performance.now();
    expect(await transport('play')).toMatchObject({ status: 'playing' });
    expect(performance.now() - playStartedAt).toBeLessThan(2_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const beforeToggle = await transport('status');
    expect(beforeToggle.status).toBe('playing');
    expect(beforeToggle.tick).toBeGreaterThan(7_213);

    const muteIdeas = window.getByRole('button', { name: 'Mute Ideas' }).first();
    await muteIdeas.click();
    await expect(muteIdeas).toHaveClass(/active/);
    const afterToggle = await transport('status');
    expect(afterToggle.status).toBe('playing');
    expect(afterToggle.tick).toBeGreaterThanOrEqual(beforeToggle.tick);
    expect(afterToggle.tick).toBeGreaterThan(7_213);

    // The ruler is a continuous scrub surface: dragging seeks to the exact
    // pointer location instead of snapping to a coarse click grid.
    expect(await transport('pause')).toMatchObject({ status: 'paused' });
    const ruler = window.locator('.ruler');
    const firstBar = ruler.locator('.ruler-bar').first();
    const [rulerBox, barBox] = await Promise.all([ruler.boundingBox(), firstBar.boundingBox()]);
    expect(rulerBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    const targetOffset = Math.min(barBox!.width * 2.371, rulerBox!.width - 4);
    const targetX = rulerBox!.x + targetOffset;
    const rulerY = rulerBox!.y + rulerBox!.height / 2;
    await window.mouse.move(rulerBox!.x + barBox!.width * 0.35, rulerY);
    await window.mouse.down();
    await window.mouse.move(targetX, rulerY, { steps: 6 });
    await window.mouse.up();
    const expectedScrubTick = Math.round(targetOffset * 3_840 / barBox!.width);
    await expect.poll(async () => (await transport('status')).tick).toBeGreaterThan(0);
    const scrubbed = await transport('status');
    expect(scrubbed.status).toBe('paused');
    expect(Math.abs(scrubbed.tick - expectedScrubTick)).toBeLessThanOrEqual(Math.ceil(3_840 / barBox!.width));

    await window.screenshot({ path: testInfo.outputPath('aimuse-packaged-smoke.png'), fullPage: true });

    const released = await fetch(connection.url, { method: 'DELETE', headers: { authorization: `Bearer ${connection.token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId! } });
    expect([200, 202, 204]).toContain(released.status);
  });
});
