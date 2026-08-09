import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertOwnerPrivateRoot } from '../../scripts/qa-private-root.mjs';
import { start } from '../../scripts/qa-session.mjs';
import { init } from '../../scripts/qa-mcp.mjs';

const USER = 'S-1-5-21-111-222-333-1001';
const OTHER_USER = 'S-1-5-21-999-888-777-1002';
const TEST_RESULTS = resolve('test-results');
const SAFE_RULES = [
  { sid: USER, type: 'Allow', inherited: false, rights: 'FullControl' },
  { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
  { sid: 'S-1-5-32-544', type: 'Allow', inherited: false, rights: 'FullControl' },
];

let privateRoot;

beforeEach(async () => {
  await mkdir(TEST_RESULTS, { recursive: true });
  privateRoot = await mkdtemp(join(TEST_RESULTS, '.qa-private-root-test-'));
});

afterEach(async () => {
  if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
});

function safeAcl(path) {
  return { protected: path === privateRoot, ownerSid: USER, rules: SAFE_RULES };
}

function windowsAclDependencies(inspectWindowsAcl = async (path) => safeAcl(path)) {
  return {
    platform: 'win32',
    currentWindowsSid: async () => USER,
    inspectWindowsAcl,
  };
}

function sessionValues(values) {
  return new Map(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]));
}

function mcpValues(values) {
  return new Map(Object.entries(values));
}

function sessionFixture() {
  return {
    exe: join(privateRoot, 'AIMuse.exe'),
    profile: join(privateRoot, 'profile'),
    connection: join(privateRoot, 'connection.json'),
    manifest: join(privateRoot, 'session.json'),
  };
}

function mcpFixture() {
  return {
    connection: join(privateRoot, 'connection.json'),
    state: join(privateRoot, 'mcp-state.json'),
  };
}

describe('owner-private coordinator roots', () => {
  it('accepts a protected owner-private root and contained sensitive paths', async () => {
    const profile = join(privateRoot, 'profile');
    await mkdir(profile);
    const result = await assertOwnerPrivateRoot({ privateRoot, paths: [profile, join(privateRoot, 'connection.json')] }, windowsAclDependencies());
    expect(result).toMatchObject({ root: privateRoot, platform: 'win32', owner: 'launching-user', inspectedPaths: 2 });
  });

  it.each([
    ['broad inherited access', { protected: false, ownerSid: USER, rules: SAFE_RULES }, 'still inherits access rules'],
    ['wrong owner', { protected: true, ownerSid: OTHER_USER, rules: SAFE_RULES }, 'not owned by the launching Windows user'],
    ['unexpected principal', { protected: true, ownerSid: USER, rules: [...SAFE_RULES, { sid: 'S-1-5-32-545', type: 'Allow', rights: 'ReadAndExecute' }] }, 'unexpected principal'],
    ['deny rule', { protected: true, ownerSid: USER, rules: [{ sid: USER, type: 'Deny', rights: 'Read' }, ...SAFE_RULES] }, 'non-Allow rule'],
    ['missing owner control', { protected: true, ownerSid: USER, rules: [{ sid: USER, type: 'Allow', rights: 'ReadAndExecute' }] }, 'does not grant the launching Windows user FullControl'],
  ])('rejects an unsafe root with %s', async (_case, acl, message) => {
    await expect(assertOwnerPrivateRoot({ privateRoot, paths: [join(privateRoot, 'connection.json')] }, windowsAclDependencies(async () => acl))).rejects.toThrow(message);
  });

  it('rejects a sensitive path outside the declared root before ACL inspection', async () => {
    const inspect = vi.fn();
    await expect(assertOwnerPrivateRoot({ privateRoot, paths: [join(TEST_RESULTS, 'foreign', 'connection.json')] }, windowsAclDependencies(inspect))).rejects.toThrow('must stay below private root');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('gates qa-session start before executable access or process launch and preserves sentinels on rejection', async () => {
    const fixture = sessionFixture();
    await writeFile(fixture.connection, 'CONNECTION-SENTINEL', 'utf8');
    await writeFile(fixture.manifest, 'MANIFEST-SENTINEL', 'utf8');
    const accessPath = vi.fn();
    const spawnProcess = vi.fn();
    const writeManifest = vi.fn();
    const values = sessionValues({
      exe: fixture.exe,
      'private-root': privateRoot,
      profile: fixture.profile,
      connection: fixture.connection,
      manifest: fixture.manifest,
      mode: 'headless',
      'launch-context': 'unsandboxed-gui',
    });
    const rejectBroadRoot = (options) => assertOwnerPrivateRoot(options, windowsAclDependencies(async () => ({ protected: false, ownerSid: USER, rules: SAFE_RULES })));

    await expect(start(values, { assertPrivateRoot: rejectBroadRoot, accessPath, spawnProcess, writeManifest })).rejects.toThrow('still inherits access rules');
    expect(accessPath).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(writeManifest).not.toHaveBeenCalled();
    expect(await readFile(fixture.connection, 'utf8')).toBe('CONNECTION-SENTINEL');
    expect(await readFile(fixture.manifest, 'utf8')).toBe('MANIFEST-SENTINEL');
  });

  it('allows qa-session start through a protected root before its injected launcher', async () => {
    const fixture = sessionFixture();
    const order = [];
    let writtenManifest;
    const values = sessionValues({
      exe: fixture.exe,
      'private-root': privateRoot,
      profile: fixture.profile,
      connection: fixture.connection,
      manifest: fixture.manifest,
      mode: 'headless',
      'launch-context': 'unsandboxed-gui',
    });
    await start(values, {
      assertPrivateRoot: async (options) => { order.push('acl'); return assertOwnerPrivateRoot(options, windowsAclDependencies()); },
      accessPath: async () => { order.push('access'); },
      hashExecutable: async () => 'C'.repeat(64),
      mkdirPath: async () => undefined,
      now: () => Date.parse('2026-08-06T04:00:00.000Z'),
      spawnProcess: () => { order.push('spawn'); return { pid: 41001, unref() {} }; },
      waitForReady: async () => ({
        connection: { profileId: 'D'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111', url: 'http://127.0.0.1:41001/mcp' },
        health: { url: 'http://127.0.0.1:41001/health' },
      }),
      writeManifest: async (_path, manifest) => { writtenManifest = manifest; },
      writeOutput: () => undefined,
    });
    expect(order).toEqual(['acl', 'access', 'spawn']);
    expect(writtenManifest).toMatchObject({ pid: 41001, privateRoot, privateRootIdentity: { version: 1, canonicalPath: privateRoot }, profile: fixture.profile, connection: fixture.connection, mode: 'headless' });
  });

  it('gates qa-mcp init before bearer read, request, or state write and preserves sentinels on rejection', async () => {
    const fixture = mcpFixture();
    await writeFile(fixture.connection, 'MOCK-BEARER-MUST-NOT-BE-READ', 'utf8');
    await writeFile(fixture.state, 'MCP-STATE-SENTINEL', 'utf8');
    const readConnection = vi.fn();
    const request = vi.fn();
    const fetch = vi.fn();
    const writeState = vi.fn();
    const values = mcpValues({
      'private-root': privateRoot,
      connection: fixture.connection,
      state: fixture.state,
      'actor-name': 'ACL fixture',
      'actor-color': '#2563EB',
    });
    const rejectWrongOwner = (options) => assertOwnerPrivateRoot(options, windowsAclDependencies(async () => ({ protected: true, ownerSid: OTHER_USER, rules: SAFE_RULES })));

    await expect(init(values, { assertPrivateRoot: rejectWrongOwner, readFile: readConnection, request, fetch, writeState })).rejects.toThrow('not owned by the launching Windows user');
    expect(readConnection).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
    expect(await readFile(fixture.connection, 'utf8')).toBe('MOCK-BEARER-MUST-NOT-BE-READ');
    expect(await readFile(fixture.state, 'utf8')).toBe('MCP-STATE-SENTINEL');
  });

  it('allows qa-mcp init through a protected root and keeps all credential activity in stand-ins', async () => {
    const fixture = mcpFixture();
    const order = [];
    const writtenStates = [];
    const values = mcpValues({
      'private-root': privateRoot,
      connection: fixture.connection,
      state: fixture.state,
      'actor-name': 'ACL fixture',
      'actor-color': '#2563EB',
      model: 'mock-model',
    });
    await init(values, {
      assertPrivateRoot: async (options) => { order.push('acl'); return assertOwnerPrivateRoot(options, windowsAclDependencies()); },
      readFile: async () => { order.push('read'); return JSON.stringify({ url: 'http://127.0.0.1:41001/mcp', token: 'distinctive-test-only-bearer', pid: 41001 }); },
      request: async (_url, _headers, body) => {
        order.push(body.method);
        if (body.method === 'initialize') return { response: { headers: { get: (name) => name === 'mcp-session-id' ? 'fixture-session' : null } }, payload: { result: {} } };
        return { response: { headers: { get: () => null } }, payload: { result: { content: [{ type: 'text', text: JSON.stringify({ actorId: 'fixture-actor' }) }] } } };
      },
      fetch: async () => { order.push('initialized'); return { ok: true }; },
      writeState: async (_path, state) => { order.push('write'); writtenStates.push(structuredClone(state)); },
      nowIso: () => '2026-08-06T04:00:00.000Z',
      writeOutput: () => undefined,
    });
    expect(order).toEqual(['acl', 'read', 'acl', 'initialize', 'acl', 'initialized', 'acl', 'write', 'acl', 'tools/call', 'acl', 'write', 'acl']);
    expect(writtenStates).toHaveLength(2);
    expect(writtenStates.at(-1)).toMatchObject({ sessionId: 'fixture-session', nextRequestId: 3, privateRoot, privateRootIdentity: { version: 1, canonicalPath: privateRoot }, actorName: 'ACL fixture' });
  });
});
