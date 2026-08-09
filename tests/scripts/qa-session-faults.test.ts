import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error -- coordinator test modules are intentionally plain ESM scripts.
import { assertOwnerPrivateRoot } from '../../scripts/qa-private-root.mjs';
// @ts-expect-error -- coordinator test modules are intentionally plain ESM scripts.
import { redact, show, status, stop } from '../../scripts/qa-session.mjs';

const createdRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(prefix));
  createdRoots.push(root);
  return root;
}

const TEST_USER = 'S-1-5-21-111-222-333-1001';
const TEST_RULES = [
  { sid: TEST_USER, type: 'Allow', rights: 'FullControl' },
  { sid: 'S-1-5-18', type: 'Allow', rights: 'FullControl' },
  { sid: 'S-1-5-32-544', type: 'Allow', rights: 'FullControl' },
];

function safeRootGuard(root: string) {
  return (options: { privateRoot: string; paths: string[] }) => assertOwnerPrivateRoot(options, {
    platform: 'win32',
    currentWindowsSid: async () => TEST_USER,
    inspectWindowsAcl: async (path: string) => ({ protected: path === root, ownerSid: TEST_USER, rules: TEST_RULES }),
  });
}

async function runQaSession(command: string, manifest: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const privateRoot = dirname(manifest);
  let stdout = '';
  let exitCode = 0;
  const commands = { redact, show, status, stop } as const;
  try {
    await commands[command as keyof typeof commands](new Map([['private-root', [privateRoot]], ['manifest', [manifest]]]), {
      platform: 'win32',
      assertPrivateRoot: safeRootGuard(privateRoot),
      writeOutput: (text: string) => { stdout += text; },
      setExitCode: (code: number) => { exitCode = code; },
    });
    return { status: exitCode, stdout, stderr: '' };
  } catch (error) {
    return { status: 1, stdout, stderr: error instanceof Error ? error.message : String(error) };
  }
}

const runQaSessionAsync = runQaSession;

async function withHealthServer<T>(body: Record<string, unknown>, callback: (mcpUrl: string, requests: string[]) => Promise<T>): Promise<T> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test health server did not expose a TCP port.');
  try {
    return await callback(`http://127.0.0.1:${address.port}/mcp`, requests);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

let executableHash: Promise<string> | undefined;
function currentExecutableHash(): Promise<string> {
  executableHash ??= readFile(process.execPath).then((bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase());
  return executableHash;
}

async function manifestFor(runRoot: string, connection: string, overrides: Record<string, unknown> = {}) {
  const profile = join(runRoot, 'profile');
  const rootInfo = await lstat(runRoot);
  return {
    version: 1,
    exe: process.execPath,
    exeSha256: '0'.repeat(64),
    privateRoot: runRoot,
    privateRootIdentity: { version: 1, canonicalPath: await realpath(runRoot), device: String(rootInfo.dev), inode: String(rootInfo.ino) },
    profile,
    profileId: createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex').toUpperCase(),
    connection,
    pid: process.pid,
    mcpUrl: 'http://127.0.0.1:48300/mcp',
    trustedFolders: [],
    ...overrides,
  };
}

async function identityFixture(runRoot: string, mcpUrl: string, manifestOverrides: Record<string, unknown> = {}, connectionOverrides: Record<string, unknown> = {}) {
  const connection = join(runRoot, 'connection.json');
  const manifest = join(runRoot, 'session.json');
  const manifestValue = await manifestFor(runRoot, connection, { exeSha256: await currentExecutableHash(), mcpUrl, ...manifestOverrides });
  const connectionValue = { version: 1, pid: manifestValue.pid, url: manifestValue.mcpUrl, profileId: manifestValue.profileId, ...connectionOverrides };
  const manifestText = JSON.stringify(manifestValue);
  const connectionText = JSON.stringify(connectionValue);
  await writeFile(manifest, manifestText);
  await writeFile(connection, connectionText);
  return { connection, connectionText, manifest, manifestText };
}

afterEach(async () => {
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('QA session fail-closed identity and redaction', () => {
  it('refuses show before health or launch when the executable hash changed', async () => {
    const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
    const connection = join(runRoot, 'connection.json');
    const manifest = join(runRoot, 'session.json');
    await writeFile(connection, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:48300/mcp' }));
    await writeFile(manifest, JSON.stringify(await manifestFor(runRoot, connection)));

    const result = await runQaSession('show', manifest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to show AIMuse because executable hash changed');
    expect(result.stderr).not.toContain('fetch failed');
  });

  it('refuses a profile-path substitution before executable, process, health, or launch access', async () => {
    const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
    const connection = join(runRoot, 'connection.json');
    const manifest = join(runRoot, 'session.json');
    const value = await manifestFor(runRoot, connection, { profile: join(runRoot, 'other-profile'), exeSha256: await currentExecutableHash() });
    await writeFile(connection, JSON.stringify({ pid: process.pid, url: value.mcpUrl, profileId: value.profileId }));
    await writeFile(manifest, JSON.stringify(value));

    const result = await runQaSession('show', manifest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('profile identity does not match its profile path');
  });

  it('refuses redaction when a tampered manifest points outside the evidence root', async () => {
    const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
    const outsideRoot = await temporaryRoot('.qa-session-outside-');
    const connection = join(outsideRoot, 'connection.json');
    const manifest = join(runRoot, 'session.json');
    const sentinel = 'test-owned sentinel must remain unchanged';
    await writeFile(connection, sentinel);
    await writeFile(manifest, JSON.stringify(await manifestFor(runRoot, connection, { pid: 99_999_999 })));

    const result = await runQaSession('redact', manifest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('QA session artifacts must stay below');
    expect(await readFile(connection, 'utf8')).toBe(sentinel);
  });

  it('refuses colliding connection and manifest paths before process access', async () => {
    const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
    const evidence = join(runRoot, 'session.json');
    const result = spawnSync(process.execPath, [
      resolve('scripts/qa-session.mjs'),
      'start',
      '--exe', join(runRoot, 'missing.exe'),
      '--private-root', runRoot,
      '--profile', join(runRoot, 'profile'),
      '--connection', evidence,
      '--manifest', evidence,
      '--mode', 'interactive',
      '--launch-context', 'unsandboxed-gui',
    ], { cwd: resolve('.'), encoding: 'utf8', windowsHide: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('connection and manifest paths must differ');
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('redacts from trusted manifest identity instead of preserving mismatched connection secrets', async () => {
    const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
    const connection = join(runRoot, 'connection.json');
    const manifest = join(runRoot, 'session.json');
    await writeFile(connection, JSON.stringify({
      version: 1,
      url: 'http://127.0.0.1:59999/mcp',
      pid: 1234,
      token: 'fake-test-token',
      tokenHint: 'fake-hint',
      sessionId: 'fake-session',
      activeProjectId: 'project_test',
    }));
    await writeFile(manifest, JSON.stringify(await manifestFor(runRoot, connection, { pid: 99_999_999 })));

    const result = await runQaSession('redact', manifest);
    const redacted = JSON.parse(await readFile(connection, 'utf8')) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(redacted).toMatchObject({
      version: 1,
      url: 'http://127.0.0.1:48300/mcp',
      pid: 99_999_999,
      activeProjectId: 'project_test',
      credentialsRedacted: true,
    });
    expect(redacted).not.toHaveProperty('token');
    expect(redacted).not.toHaveProperty('tokenHint');
    expect(redacted).not.toHaveProperty('sessionId');
  });

  it.each([
    ['PID', { pid: process.pid + 1 }],
    ['URL', { url: 'http://127.0.0.1:59999/mcp' }],
    ['instance', { instanceId: '11111111-1111-4111-8111-111111111111' }],
    ['profile', { profileId: 'B'.repeat(64) }],
  ])('status skips process and health inspection on static %s mismatch', async (_kind, connectionOverrides) => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: process.pid }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl, {}, connectionOverrides);

      const result = await runQaSessionAsync('status', fixture.manifest);
      const status = JSON.parse(result.stdout) as Record<string, any>;

      expect(result.status).toBe(1);
      expect(status.okay).toBe(false);
      expect(status.processAlive).toBeNull();
      expect(status.processInspection).toBe('skipped');
      expect(status.health).toEqual({ skipped: 'static identity mismatch' });
      expect(requests).toEqual([]);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it('status inspects only the declared stale PID and skips health', async () => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: 99_999_999 }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl, { pid: 99_999_999 });

      const result = await runQaSessionAsync('status', fixture.manifest);
      const status = JSON.parse(result.stdout) as Record<string, any>;

      expect(result.status).toBe(1);
      expect(status.processAlive).toBe(false);
      expect(status.processInspection).toBe('performed');
      expect(status.health).toEqual({ skipped: 'process not alive' });
      expect(requests).toEqual([]);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it('status rejects a non-AIMuse health identity without mutating evidence', async () => {
    await withHealthServer({ name: 'Different Service', status: 'ok', pid: process.pid }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl);

      const result = await runQaSessionAsync('status', fixture.manifest);
      const status = JSON.parse(result.stdout) as Record<string, any>;

      expect(result.status).toBe(1);
      expect(status.processAlive).toBe(true);
      expect(status.health.error).toContain('Health endpoint identity mismatch');
      expect(requests).toEqual(['/health']);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it.each([
    ['PID', { pid: process.pid + 1 }],
    ['URL', { url: 'http://127.0.0.1:59999/mcp' }],
  ])('stop refuses static %s mismatch before process or health access', async (_kind, connectionOverrides) => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: process.pid }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl, {}, connectionOverrides);

      const result = await runQaSessionAsync('stop', fixture.manifest);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('session PID/URL identity changed');
      expect(requests).toEqual([]);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it('stop refuses an engine-instance mismatch before process or health access', async () => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: process.pid }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl, {}, { instanceId: '11111111-1111-4111-8111-111111111111' });

      const result = await runQaSessionAsync('stop', fixture.manifest);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('session instance identity changed');
      expect(requests).toEqual([]);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it('stop refuses a stale PID before health or signal launch', async () => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: 99_999_999 }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl, { pid: 99_999_999 });

      const result = await runQaSessionAsync('stop', fixture.manifest);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('QA PID 99999999 is not alive');
      expect(requests).toEqual([]);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });

  it('stop refuses mismatched health PID before signal launch or redaction', async () => {
    await withHealthServer({ name: 'AIMuse Engine', status: 'ok', pid: process.pid + 1 }, async (mcpUrl, requests) => {
      const runRoot = await temporaryRoot(join('test-results', 'qa-session-fault-'));
      const fixture = await identityFixture(runRoot, mcpUrl);

      const result = await runQaSessionAsync('stop', fixture.manifest);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Health endpoint PID mismatch');
      expect(requests).toEqual(['/health']);
      expect(await readFile(fixture.manifest, 'utf8')).toBe(fixture.manifestText);
      expect(await readFile(fixture.connection, 'utf8')).toBe(fixture.connectionText);
    });
  });
});
