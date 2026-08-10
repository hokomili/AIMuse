import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { assertOwnerPrivateRoot } from '../../scripts/qa-private-root.mjs';
import { profileIdForPath } from '../../scripts/qa-lifecycle.mjs';
import { redact, show, status, stop } from '../../scripts/qa-session.mjs';
import { close, resource, tool } from '../../scripts/qa-mcp.mjs';

const USER = 'S-1-5-21-111-222-333-1001';
const OTHER_USER = 'S-1-5-21-999-888-777-1002';
const TEST_RESULTS = resolve('test-results');
const PID = 41_001;
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'A'.repeat(64);
const MCP_URL = 'http://127.0.0.1:41001/mcp';
const HEALTH_URL = 'http://127.0.0.1:41001/health';
const NOW = '2026-08-06T05:00:00.000Z';
const SUBJECT_DIGEST = 'B'.repeat(64);
const SUBJECT_IDENTITY = 'C'.repeat(64);
const SAFE_RULES = [
  { sid: USER, type: 'Allow', inherited: false, rights: 'FullControl' },
  { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
  { sid: 'S-1-5-32-544', type: 'Allow', inherited: false, rights: 'FullControl' },
];
const createdRoots = [];

afterEach(async () => {
  while (createdRoots.length) await rm(createdRoots.pop(), { recursive: true, force: true });
});

function safeAcl(root, path) {
  return { protected: path === root, ownerSid: USER, rules: SAFE_RULES };
}

function aclDependencies(root, overrides = {}) {
  return {
    platform: 'win32',
    currentWindowsSid: async () => USER,
    inspectWindowsAcl: async (path) => safeAcl(root, path),
    ...overrides,
  };
}

function safeGuard(root) {
  return (options) => assertOwnerPrivateRoot(options, aclDependencies(root));
}

function sessionValues(privateRoot, manifest) {
  return new Map([['private-root', [privateRoot]], ['manifest', [manifest]]]);
}

function mcpValues(privateRoot, state, values = {}) {
  return new Map([['private-root', privateRoot], ['state', state], ...Object.entries(values)]);
}

function health(fixture, overrides = {}) {
  return { name: 'AIMuse Engine', status: 'ok', pid: PID, instanceId: INSTANCE_ID, profileId: fixture.profileId, ...overrides };
}

async function fixture(mcpUrl = MCP_URL) {
  const root = await mkdtemp(join(TEST_RESULTS, '.qa-private-drift-test-'));
  createdRoots.push(root);
  const profile = join(root, 'profile');
  const connection = join(root, 'connection.json');
  const manifest = join(root, 'session.json');
  const state = join(root, 'mcp-state.json');
  const exe = join(root, 'AIMuse.exe');
  await mkdir(profile, { mode: 0o700 });
  const observed = await safeGuard(root)({ privateRoot: root, paths: [profile, connection, manifest, state] });
  const profileId = profileIdForPath(profile);
  const manifestValue = {
    version: 1,
    startedAt: NOW,
    exe,
    exeSha256: HASH,
    privateRoot: root,
    privateRootIdentity: observed.identity,
    profile,
    profileId,
    connection,
    mode: 'headless',
    launchContext: 'unsandboxed-gui',
    pid: PID,
    instanceId: INSTANCE_ID,
    mcpUrl,
    healthUrl: mcpUrl.replace('/mcp', '/health'),
    trustedFolders: [],
    windowRequested: false,
  };
  const connectionValue = { version: 1, pid: PID, url: mcpUrl, instanceId: INSTANCE_ID, profileId, token: 'TEST_ONLY_PRIVATE_BEARER', activeProjectId: 'project_fixture' };
  const stateValue = {
    version: 1,
    url: mcpUrl,
    token: 'TEST_ONLY_PRIVATE_BEARER',
    sessionId: 'fixture-session',
    nextRequestId: 2,
    privateRoot: root,
    privateRootIdentity: observed.identity,
    connectionPath: connection,
    connectionPid: PID,
    actorName: 'ACL fixture',
    actorColor: '#2563EB',
    initializedAt: NOW,
  };
  await writeFile(manifest, `${JSON.stringify(manifestValue, null, 2)}\n`, { mode: 0o600 });
  await writeFile(connection, `${JSON.stringify(connectionValue, null, 2)}\n`, { mode: 0o600 });
  await writeFile(state, `${JSON.stringify(stateValue, null, 2)}\n`, { mode: 0o600 });
  return { root, profile, profileId, connection, connectionValue, manifest, manifestValue, state, stateValue, exe };
}

async function snapshots(fixtureValue) {
  return new Map(await Promise.all([fixtureValue.manifest, fixtureValue.connection, fixtureValue.state].map(async (path) => [path, await readFile(path)])));
}

async function expectSnapshots(fixtureValue, expected) {
  for (const path of [fixtureValue.manifest, fixtureValue.connection, fixtureValue.state]) expect(await readFile(path)).toEqual(expected.get(path));
}

function sessionBaseDependencies(fixtureValue, overrides = {}) {
  return {
    platform: 'win32',
    assertPrivateRoot: safeGuard(fixtureValue.root),
    hashExecutable: vi.fn(async () => HASH),
    inspectProcess: vi.fn(async () => ({ alive: true, identity: 'process-generation-A' })),
    probeHealth: vi.fn(async () => health(fixtureValue)),
    writeManifest: vi.fn(async () => undefined),
    writeConnection: vi.fn(async () => undefined),
    writeOutput: vi.fn(),
    setExitCode: vi.fn(),
    now: () => Date.parse(NOW),
    nowIso: () => NOW,
    sleep: async () => undefined,
    ...overrides,
  };
}

async function formalStatusFixture(mcpUrl = MCP_URL) {
  const files = await fixture(mcpUrl);
  const packageSubjectManifest = join(files.root, 'package-subject.json');
  files.manifestValue = {
    ...files.manifestValue,
    packageSubjectManifest,
    packageSubjectManifestSha256: SUBJECT_DIGEST,
    packageSubjectIdentitySha256: SUBJECT_IDENTITY,
  };
  await writeFile(files.manifest, `${JSON.stringify(files.manifestValue, null, 2)}\n`, { mode: 0o600 });
  return { ...files, packageSubjectManifest };
}

function darwinStatusDependencies(files, overrides = {}) {
  const writeOutput = vi.fn();
  const setExitCode = vi.fn();
  const verifyPackageSubject = vi.fn(async () => ({
    manifestPath: files.packageSubjectManifest,
    manifestSha256: SUBJECT_DIGEST,
    manifest: { subject: { identitySha256: SUBJECT_IDENTITY, files: { applicationExecutable: { path: relative(resolve('.'), files.exe) } } } },
  }));
  const inspectProcess = vi.fn(async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  const probeHealth = vi.fn(async () => ({ url: files.manifestValue.healthUrl, body: health(files) }));
  const probeMcpAuthentication = vi.fn(async () => ({ verified: true, httpStatus: 400, result: 'initialization_required' }));
  return {
    platform: 'darwin',
    assertPrivateRoot: (options) => assertOwnerPrivateRoot(options, { platform: 'darwin' }),
    hashExecutable: vi.fn(async () => HASH),
    verifyPackageSubject,
    inspectProcess,
    probeHealth,
    probeMcpAuthentication,
    writeOutput,
    setExitCode,
    ...overrides,
  };
}

function statusOutput(dependencies) {
  expect(dependencies.writeOutput).toHaveBeenCalledOnce();
  return JSON.parse(dependencies.writeOutput.mock.calls[0][0]);
}

function mcpBaseDependencies(fixtureValue, overrides = {}) {
  return {
    platform: 'win32',
    assertPrivateRoot: safeGuard(fixtureValue.root),
    request: vi.fn(async (_url, _headers, body) => {
      if (body.method === 'resources/read') return { payload: { result: { contents: [] } } };
      return { payload: { result: { content: [{ type: 'text', text: JSON.stringify({ okay: true }) }] } } };
    }),
    fetch: vi.fn(async () => ({ ok: true })),
    writeState: vi.fn(async () => undefined),
    writeOutput: vi.fn(),
    nowIso: () => NOW,
    ...overrides,
  };
}

describe('QA-10 private-root drift and follow-up TOCTOU guards', () => {
  it('allows every session follow-up through one unchanged protected root using only injected lifecycle stand-ins', async () => {
    const files = await fixture();
    const values = sessionValues(files.root, files.manifest);

    const statusDependencies = sessionBaseDependencies(files, { probeHealth: vi.fn(async () => ({ url: 'http://127.0.0.1:41001/health', body: health(files) })) });
    await status(values, statusDependencies);
    expect(statusDependencies.writeOutput).toHaveBeenCalledOnce();
    expect(statusDependencies.setExitCode).not.toHaveBeenCalled();

    const accepted = { requestId: REQUEST_ID, status: 'accepted', pid: PID, instanceId: INSTANCE_ID, profileId: files.profileId, receivedAt: NOW, acknowledgedAt: NOW, attempts: 1 };
    let showHealthIndex = 0;
    const showDependencies = sessionBaseDependencies(files, {
      requestId: REQUEST_ID,
      probeHealth: vi.fn(async () => [health(files), health(files), health(files, { showAcknowledgements: [accepted] }), health(files, { showAcknowledgements: [accepted] })][Math.min(showHealthIndex++, 3)]),
      launchWindowRequest: vi.fn(async () => ({ fixtureChild: true })),
      waitForChildExit: vi.fn(async () => 0),
    });
    await show(values, showDependencies);
    expect(showDependencies.launchWindowRequest).toHaveBeenCalledOnce();
    expect(showDependencies.writeManifest).toHaveBeenCalledOnce();

    const redactDependencies = sessionBaseDependencies(files, { inspectProcess: vi.fn(async () => ({ alive: false })) });
    await redact(values, redactDependencies);
    expect(redactDependencies.writeConnection).toHaveBeenCalledOnce();
    expect(redactDependencies.writeManifest).toHaveBeenCalledOnce();

    let processIndex = 0;
    const stopProcesses = [
      { alive: true, identity: 'process-generation-A' },
      { alive: true, identity: 'process-generation-A' },
      { alive: true, identity: 'process-generation-A' },
      { alive: false },
      { alive: false },
      { alive: false },
    ];
    const stopDependencies = sessionBaseDependencies(files, {
      inspectProcess: vi.fn(async () => stopProcesses[Math.min(processIndex++, stopProcesses.length - 1)]),
      signalProcess: vi.fn(() => ({ fixtureChild: true })),
      waitForChildExit: vi.fn(async () => 0),
    });
    await stop(values, stopDependencies);
    expect(stopDependencies.signalProcess).toHaveBeenCalledOnce();
    expect(stopDependencies.writeConnection).toHaveBeenCalledOnce();
    expect(stopDependencies.writeManifest).toHaveBeenCalledOnce();
    for (const dependencies of [statusDependencies, showDependencies, redactDependencies, stopDependencies]) expect(JSON.stringify(dependencies.writeOutput.mock.calls)).not.toContain('TEST_ONLY_PRIVATE_BEARER');
  });

  it('accepts Darwin EPERM only through exact subject, health, connection, and bearer-auth proofs', async () => {
    const files = await formalStatusFixture();
    const before = await snapshots(files);
    const dependencies = darwinStatusDependencies(files);

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output).toMatchObject({
      okay: true,
      hashMatches: true,
      packageSubjectVerified: true,
      packageSubjectManifest: files.packageSubjectManifest,
      packageSubjectManifestSha256: SUBJECT_DIGEST,
      packageSubjectIdentitySha256: SUBJECT_IDENTITY,
      processAlive: null,
      processInspection: 'denied',
      processInspectionSupported: false,
      processInspectionDenied: true,
      processInspectionStatus: 'permission-denied',
      processIdentityMatches: null,
      inspectionFallbackVerified: true,
      mcpAuthentication: { verified: true, httpStatus: 400, result: 'initialization_required' },
    });
    expect(output.health).toMatchObject({ url: HEALTH_URL, body: { name: 'AIMuse Engine', status: 'ok', pid: PID, instanceId: INSTANCE_ID, profileId: files.profileId } });
    expect(dependencies.inspectProcess).toHaveBeenCalledExactlyOnceWith(PID);
    expect(dependencies.probeHealth).toHaveBeenCalledTimes(2);
    expect(dependencies.probeMcpAuthentication).toHaveBeenCalledExactlyOnceWith(MCP_URL, 'TEST_ONLY_PRIVATE_BEARER');
    expect(dependencies.verifyPackageSubject).toHaveBeenCalledTimes(2);
    expect(dependencies.hashExecutable).toHaveBeenCalledTimes(2);
    expect(dependencies.setExitCode).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toContain('TEST_ONLY_PRIVATE_BEARER');
    await expectSnapshots(files, before);
  });

  it('uses a no-mutation authenticated GET and accepts only the exact post-auth MCP response', async () => {
    const requests = [];
    let healthBody;
    const server = createServer((request, response) => {
      const authorized = request.headers.authorization === 'Bearer TEST_ONLY_PRIVATE_BEARER';
      requests.push({ method: request.method, url: request.url, authorized });
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(healthBody));
        return;
      }
      if (request.method === 'GET' && request.url === '/mcp' && authorized) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"initialization_required"}');
        return;
      }
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":"invalid_token"}');
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Status test server did not expose a TCP port.');
    const files = await formalStatusFixture(`http://127.0.0.1:${address.port}/mcp`);
    healthBody = health(files);
    const dependencies = darwinStatusDependencies(files, { probeHealth: undefined, probeMcpAuthentication: undefined });

    try {
      await status(sessionValues(files.root, files.manifest), dependencies);
    } finally {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    const output = statusOutput(dependencies);

    expect(output.okay).toBe(true);
    expect(output.mcpAuthentication).toEqual({ verified: true, httpStatus: 400, result: 'initialization_required' });
    expect(requests).toEqual([
      { method: 'GET', url: '/health', authorized: false },
      { method: 'GET', url: '/mcp', authorized: true },
      { method: 'GET', url: '/health', authorized: false },
    ]);
    expect(dependencies.writeOutput.mock.calls[0][0]).not.toContain('TEST_ONLY_PRIVATE_BEARER');
  });

  it('fails Darwin EPERM when exact health identity does not match and never attempts bearer auth', async () => {
    const files = await formalStatusFixture();
    const before = await snapshots(files);
    const dependencies = darwinStatusDependencies(files, {
      probeHealth: vi.fn(async () => ({ url: HEALTH_URL, body: health(files, { pid: PID + 1 }) })),
    });

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output.okay).toBe(false);
    expect(output.processInspectionStatus).toBe('permission-denied');
    expect(output.inspectionFallbackVerified).toBe(false);
    expect(output.health.error).toContain('Health endpoint PID mismatch');
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
    expect(dependencies.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
    await expectSnapshots(files, before);
  });

  it('never applies the EPERM fallback on Windows', async () => {
    const files = await formalStatusFixture();
    const dependencies = darwinStatusDependencies(files, {
      platform: 'win32',
      assertPrivateRoot: safeGuard(files.root),
    });

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output).toMatchObject({ okay: false, processInspectionStatus: 'permission-denied', processInspectionDenied: true, inspectionFallbackVerified: false, health: { skipped: 'process inspection unavailable' } });
    expect(dependencies.probeHealth).not.toHaveBeenCalled();
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
    expect(dependencies.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    ['ESRCH', { alive: false, supported: true, denied: false, status: 'absent', inspection: 'performed', skipped: 'process absent' }],
    ['ENOTSUP', { alive: null, supported: false, denied: false, status: 'unsupported', inspection: 'unsupported', skipped: 'process inspection unavailable' }],
  ])('keeps %s process inspection fail-closed without health or bearer access', async (code, expected) => {
    const files = await formalStatusFixture();
    const before = await snapshots(files);
    const dependencies = darwinStatusDependencies(files, {
      inspectProcess: vi.fn(async () => { throw Object.assign(new Error(code), { code }); }),
    });

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output).toMatchObject({
      okay: false,
      processAlive: expected.alive,
      processInspection: expected.inspection,
      processInspectionSupported: expected.supported,
      processInspectionDenied: expected.denied,
      processInspectionStatus: expected.status,
      inspectionFallbackVerified: false,
      health: { skipped: expected.skipped },
    });
    expect(dependencies.probeHealth).not.toHaveBeenCalled();
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
    expect(dependencies.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
    await expectSnapshots(files, before);
  });

  it('fails an explicit process identity mismatch before health or bearer access', async () => {
    const files = await formalStatusFixture();
    const dependencies = darwinStatusDependencies(files, {
      inspectProcess: vi.fn(async () => ({ alive: true, pid: PID + 1, identityMatches: false })),
    });

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output).toMatchObject({ okay: false, processAlive: true, processInspectionStatus: 'identity-mismatch', processIdentityMatches: false, health: { skipped: 'process identity mismatch' } });
    expect(dependencies.probeHealth).not.toHaveBeenCalled();
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
  });

  it('skips inspection, health, and bearer access on a static connection drift', async () => {
    const files = await formalStatusFixture();
    await writeFile(files.connection, `${JSON.stringify({ ...files.connectionValue, url: 'http://127.0.0.1:41002/mcp' }, null, 2)}\n`, { mode: 0o600 });
    const dependencies = darwinStatusDependencies(files);

    await status(sessionValues(files.root, files.manifest), dependencies);
    const output = statusOutput(dependencies);

    expect(output).toMatchObject({
      okay: false,
      urlMatches: false,
      processAlive: null,
      processInspection: 'skipped',
      processInspectionSupported: null,
      processInspectionDenied: false,
      processInspectionStatus: 'skipped-static-identity-mismatch',
      health: { skipped: 'static identity mismatch' },
    });
    expect(dependencies.inspectProcess).not.toHaveBeenCalled();
    expect(dependencies.probeHealth).not.toHaveBeenCalled();
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
  });

  it('keeps failed bearer-auth evidence credential-free and fails the EPERM fallback', async () => {
    const files = await formalStatusFixture();
    const before = await snapshots(files);
    const dependencies = darwinStatusDependencies(files, {
      probeMcpAuthentication: vi.fn(async () => ({ verified: false, httpStatus: 401, result: 'invalid-token', token: 'TEST_ONLY_PRIVATE_BEARER' })),
    });

    await status(sessionValues(files.root, files.manifest), dependencies);
    const outputText = dependencies.writeOutput.mock.calls[0][0];
    const output = JSON.parse(outputText);

    expect(output).toMatchObject({ okay: false, inspectionFallbackVerified: false, mcpAuthentication: { verified: false, httpStatus: 401, result: 'invalid-token' } });
    expect(output.mcpAuthentication).not.toHaveProperty('token');
    expect(outputText).not.toContain('TEST_ONLY_PRIVATE_BEARER');
    expect(dependencies.probeHealth).toHaveBeenCalledOnce();
    expect(dependencies.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
    await expectSnapshots(files, before);
  });

  it('rejects package-subject drift before process, health, bearer, or output access', async () => {
    const files = await formalStatusFixture();
    const before = await snapshots(files);
    const dependencies = darwinStatusDependencies(files, {
      verifyPackageSubject: vi.fn(async () => { throw new Error('injected package subject drift'); }),
    });

    await expect(status(sessionValues(files.root, files.manifest), dependencies)).rejects.toThrow('injected package subject drift');
    expect(dependencies.inspectProcess).not.toHaveBeenCalled();
    expect(dependencies.probeHealth).not.toHaveBeenCalled();
    expect(dependencies.probeMcpAuthentication).not.toHaveBeenCalled();
    expect(dependencies.writeOutput).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('allows tool, resource, and close through unchanged protected state using only injected request/write stand-ins', async () => {
    const files = await fixture();
    const commands = [
      [tool, { name: 'project_observe', 'args-json': '{}' }],
      [resource, { uri: 'aimuse://manifest' }],
      [close, {}],
    ];
    for (const [command, arguments_] of commands) {
      const dependencies = mcpBaseDependencies(files);
      await command(mcpValues(files.root, files.state, arguments_), dependencies);
      expect(dependencies.request).toHaveBeenCalled();
      expect(dependencies.writeState).toHaveBeenCalled();
      expect(dependencies.writeOutput).toHaveBeenCalledOnce();
      expect(JSON.stringify(dependencies.writeOutput.mock.calls)).not.toContain('TEST_ONLY_PRIVATE_BEARER');
      if (command === close) expect(dependencies.fetch).toHaveBeenCalledOnce();
      else expect(dependencies.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['status', status, { protected: false, ownerSid: USER, rules: SAFE_RULES }, 'still inherits access rules'],
    ['show', show, { protected: true, ownerSid: OTHER_USER, rules: SAFE_RULES }, 'not owned by the launching Windows user'],
    ['stop', stop, { protected: true, ownerSid: USER, rules: [...SAFE_RULES, { sid: 'S-1-5-32-545', type: 'Allow', rights: 'ReadAndExecute' }] }, 'unexpected principal'],
    ['redact', redact, { protected: true, ownerSid: USER, rules: [{ sid: USER, type: 'Deny', rights: 'Read' }, ...SAFE_RULES] }, 'non-Allow rule'],
  ])('rejects %s on unsafe ACL/owner/principal drift before any evidence, PID, health, window, signal, or write call', async (_name, command, acl, message) => {
    const files = await fixture();
    const before = await snapshots(files);
    const downstream = {
      readFile: vi.fn(), hashExecutable: vi.fn(), inspectProcess: vi.fn(), probeHealth: vi.fn(), launchWindowRequest: vi.fn(), signalProcess: vi.fn(), writeConnection: vi.fn(), writeManifest: vi.fn(), writeOutput: vi.fn(),
    };
    const reject = (options) => assertOwnerPrivateRoot(options, aclDependencies(files.root, { inspectWindowsAcl: async () => acl }));
    await expect(command(sessionValues(files.root, files.manifest), { platform: 'win32', assertPrivateRoot: reject, ...downstream })).rejects.toThrow(message);
    for (const call of Object.values(downstream)) expect(call).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it.each([
    ['tool', tool, { name: 'project_observe' }, { protected: false, ownerSid: USER, rules: SAFE_RULES }, 'still inherits access rules'],
    ['resource', resource, { uri: 'aimuse://manifest' }, { protected: true, ownerSid: OTHER_USER, rules: SAFE_RULES }, 'not owned by the launching Windows user'],
    ['close', close, {}, { protected: true, ownerSid: USER, rules: [...SAFE_RULES, { sid: 'S-1-5-11', type: 'Allow', rights: 'Read' }] }, 'unexpected principal'],
  ])('rejects MCP %s on unsafe root drift before state/bearer read, request, DELETE, write, or output', async (_name, command, arguments_, acl, message) => {
    const files = await fixture();
    const before = await snapshots(files);
    const downstream = { readFile: vi.fn(), request: vi.fn(), fetch: vi.fn(), writeState: vi.fn(), writeOutput: vi.fn() };
    const reject = (options) => assertOwnerPrivateRoot(options, aclDependencies(files.root, { inspectWindowsAcl: async () => acl }));
    await expect(command(mcpValues(files.root, files.state, arguments_), { platform: 'win32', assertPrivateRoot: reject, ...downstream })).rejects.toThrow(message);
    for (const call of Object.values(downstream)) expect(call).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects a canonical manifest-path replacement before reading evidence or touching a process', async () => {
    const files = await fixture();
    const before = await snapshots(files);
    const readText = vi.fn();
    const inspectProcess = vi.fn();
    const guard = (options) => assertOwnerPrivateRoot(options, aclDependencies(files.root, {
      realpathPath: async (path) => path === files.manifest ? join(TEST_RESULTS, 'foreign-manifest.json') : realpath(path),
    }));
    await expect(status(sessionValues(files.root, files.manifest), { platform: 'win32', assertPrivateRoot: guard, readFile: readText, inspectProcess })).rejects.toThrow('escapes its root');
    expect(readText).not.toHaveBeenCalled();
    expect(inspectProcess).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects a state-path link replacement before reading its bearer or making a request', async () => {
    const files = await fixture();
    const before = await snapshots(files);
    const readText = vi.fn();
    const request = vi.fn();
    const guard = (options) => assertOwnerPrivateRoot(options, aclDependencies(files.root, {
      lstatPath: async (path) => {
        const info = await lstat(path);
        if (path !== files.state) return info;
        return { dev: info.dev, ino: info.ino, isDirectory: () => info.isDirectory(), isSymbolicLink: () => true };
      },
    }));
    await expect(tool(mcpValues(files.root, files.state, { name: 'project_observe' }), { platform: 'win32', assertPrivateRoot: guard, readFile: readText, request })).rejects.toThrow('must not traverse a link');
    expect(readText).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('makes a root object replacement after manifest read sticky before connection, PID, health, or evidence access', async () => {
    const files = await fixture();
    const before = await snapshots(files);
    let guardCalls = 0;
    const guard = async (options) => {
      const observed = await safeGuard(files.root)(options);
      guardCalls += 1;
      if (guardCalls < 2) return observed;
      return { ...observed, identity: { ...observed.identity, inode: String(BigInt(observed.identity.inode) + 1n) } };
    };
    const readText = vi.fn((...arguments_) => readFile(...arguments_));
    const downstream = { hashExecutable: vi.fn(), inspectProcess: vi.fn(), probeHealth: vi.fn(), writeManifest: vi.fn(), writeOutput: vi.fn() };
    await expect(status(sessionValues(files.root, files.manifest), { platform: 'win32', assertPrivateRoot: guard, readFile: readText, ...downstream })).rejects.toThrow('filesystem identity changed');
    expect(readText).toHaveBeenCalledTimes(1);
    for (const call of Object.values(downstream)) expect(call).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('makes a root object replacement after state read sticky before request, DELETE, state write, or output', async () => {
    const files = await fixture();
    const before = await snapshots(files);
    let guardCalls = 0;
    const guard = async (options) => {
      const observed = await safeGuard(files.root)(options);
      guardCalls += 1;
      if (guardCalls < 2) return observed;
      return { ...observed, identity: { ...observed.identity, canonicalPath: join(TEST_RESULTS, 'replacement-root') } };
    };
    const readText = vi.fn((...arguments_) => readFile(...arguments_));
    const downstream = { request: vi.fn(), fetch: vi.fn(), writeState: vi.fn(), writeOutput: vi.fn() };
    await expect(close(mcpValues(files.root, files.state), { platform: 'win32', assertPrivateRoot: guard, readFile: readText, ...downstream })).rejects.toThrow('filesystem identity changed');
    expect(readText).toHaveBeenCalledTimes(1);
    for (const call of Object.values(downstream)) expect(call).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects mismatched persisted manifest root identity before connection/process access', async () => {
    const files = await fixture();
    const value = { ...files.manifestValue, privateRootIdentity: { ...files.manifestValue.privateRootIdentity, inode: String(BigInt(files.manifestValue.privateRootIdentity.inode) + 1n) } };
    await writeFile(files.manifest, `${JSON.stringify(value, null, 2)}\n`);
    const before = await snapshots(files);
    const hashExecutable = vi.fn();
    const inspectProcess = vi.fn();
    await expect(status(sessionValues(files.root, files.manifest), { platform: 'win32', assertPrivateRoot: safeGuard(files.root), hashExecutable, inspectProcess })).rejects.toThrow('filesystem identity changed');
    expect(hashExecutable).not.toHaveBeenCalled();
    expect(inspectProcess).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects mismatched persisted MCP root identity before request or state write', async () => {
    const files = await fixture();
    const value = { ...files.stateValue, privateRootIdentity: { ...files.stateValue.privateRootIdentity, device: String(BigInt(files.stateValue.privateRootIdentity.device) + 1n) } };
    await writeFile(files.state, `${JSON.stringify(value, null, 2)}\n`);
    const before = await snapshots(files);
    const request = vi.fn();
    const writeState = vi.fn();
    await expect(resource(mcpValues(files.root, files.state, { uri: 'aimuse://manifest' }), { platform: 'win32', assertPrivateRoot: safeGuard(files.root), request, writeState })).rejects.toThrow('filesystem identity changed');
    expect(request).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects a persisted session-root declaration mismatch before connection or process access', async () => {
    const files = await fixture();
    await writeFile(files.manifest, `${JSON.stringify({ ...files.manifestValue, privateRoot: join(TEST_RESULTS, 'foreign-root') }, null, 2)}\n`);
    const before = await snapshots(files);
    const inspectProcess = vi.fn();
    await expect(status(sessionValues(files.root, files.manifest), { platform: 'win32', assertPrivateRoot: safeGuard(files.root), inspectProcess })).rejects.toThrow(/persisted private root|path must stay below/);
    expect(inspectProcess).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });

  it('rejects a persisted MCP containment escape before request or state write', async () => {
    const files = await fixture();
    await writeFile(files.state, `${JSON.stringify({ ...files.stateValue, connectionPath: join(TEST_RESULTS, 'foreign-connection.json') }, null, 2)}\n`);
    const before = await snapshots(files);
    const request = vi.fn();
    const writeState = vi.fn();
    await expect(tool(mcpValues(files.root, files.state, { name: 'project_observe' }), { platform: 'win32', assertPrivateRoot: safeGuard(files.root), request, writeState })).rejects.toThrow('path must stay below persisted private root');
    expect(request).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    await expectSnapshots(files, before);
  });
});
