import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { coordinateShow, profileIdForPath } from '../../scripts/qa-lifecycle.mjs';

const PID = 99_999_991;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const MCP_URL = 'http://127.0.0.1:48300/mcp';
const HASH_A = 'A'.repeat(64);
const HASH_B = 'B'.repeat(64);
const PROFILE = resolve('test-results', 'qa-show-owned-fixture', 'profile');
const PROFILE_ID = profileIdForPath(PROFILE);
const OTHER_PROFILE_ID = 'C'.repeat(64);
const CREDENTIAL = 'TEST_ONLY_FAKE_CREDENTIAL_NEVER_WRITE';
const REQUESTED_AT = '2026-08-05T04:00:00.000Z';
const REQUESTED_AT_MS = Date.parse(REQUESTED_AT);
const EVIDENCE_SENTINEL = '{"sentinel":"known-good-manifest"}\n';

it('matches platform-specific profile identity semantics', () => {
  expect(profileIdForPath('/Users/AIMuse', 'darwin')).not.toBe(profileIdForPath('/Users/aimuse', 'darwin'));
  expect(profileIdForPath('C:\\Users\\AIMuse', 'win32')).toBe(profileIdForPath('C:\\Users\\aimuse', 'win32'));
});

function baseManifest(overrides = {}) {
  return {
    version: 1,
    exe: resolve('test-results', 'qa-show-owned-fixture', 'AIMuse.exe'),
    exeSha256: HASH_A,
    profile: PROFILE,
    profileId: PROFILE_ID,
    connection: resolve('test-results', 'qa-show-owned-fixture', 'connection.json'),
    pid: PID,
    instanceId: INSTANCE_A,
    mcpUrl: MCP_URL,
    trustedFolders: [],
    windowRequested: false,
    ...overrides,
  };
}

function connection(overrides = {}) {
  return { version: 1, pid: PID, url: MCP_URL, instanceId: INSTANCE_A, profileId: PROFILE_ID, token: CREDENTIAL, ...overrides };
}

function health(overrides = {}) {
  return { name: 'AIMuse Engine', status: 'ok', pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID, ...overrides };
}

function acknowledgement(overrides = {}) {
  return { requestId: REQUEST_ID, status: 'accepted', pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID, receivedAt: REQUESTED_AT, acknowledgedAt: REQUESTED_AT, attempts: 1, ...overrides };
}

function repeated(value, length) {
  return Array.from({ length }, () => value);
}

function sequenceValue(values, index) {
  return values[Math.min(index, values.length - 1)];
}

function createScenario(options = {}) {
  const manifest = baseManifest(options.manifest);
  const hashes = options.hashes ?? [HASH_A, HASH_A];
  const connections = options.connections ?? [connection(), connection()];
  const processes = options.processes ?? repeated({ alive: true, identity: 'process-generation-A' }, 6);
  const acceptedHealth = health({ showAcknowledgements: [acknowledgement()] });
  const healthProbes = options.healthProbes ?? [health(), health(), acceptedHealth, acceptedHealth];
  const calls = { hashes: [], connections: [], processes: [], health: [], launches: [], childExits: [], sleeps: [], writes: [] };
  let hashIndex = 0; let connectionIndex = 0; let processIndex = 0; let healthIndex = 0;
  let clock = REQUESTED_AT_MS;
  let evidence = EVIDENCE_SENTINEL;
  const child = { testOwnedChild: true };

  const run = coordinateShow({ manifest, requestId: options.requestId ?? REQUEST_ID, timeoutMs: 250, acknowledgementTimeoutMs: options.acknowledgementTimeoutMs ?? 30, acknowledgementPollMs: options.acknowledgementPollMs ?? 10 }, {
    hashExecutable: async (path) => { calls.hashes.push(path); return sequenceValue(hashes, hashIndex++); },
    readConnection: async (path) => { calls.connections.push(path); return sequenceValue(connections, connectionIndex++); },
    inspectProcess: async (pid) => { calls.processes.push(pid); return sequenceValue(processes, processIndex++); },
    probeHealth: async (url, pid, instanceId, profileId) => {
      calls.health.push({ url, pid, instanceId, profileId });
      return sequenceValue(healthProbes, healthIndex++);
    },
    launchWindowRequest: async (target) => {
      calls.launches.push(target);
      if (options.launchError) throw options.launchError;
      return child;
    },
    waitForChildExit: async (value, timeoutMs) => {
      calls.childExits.push({ value, timeoutMs });
      return options.childExitCode === null ? undefined : (options.childExitCode ?? 0);
    },
    now: () => clock,
    nowIso: () => new Date(clock).toISOString(),
    sleep: async (milliseconds) => { calls.sleeps.push(milliseconds); clock += milliseconds; },
    writeManifest: async (value) => {
      calls.writes.push(value);
      if (options.writeError) throw options.writeError;
      const serialized = `${JSON.stringify(value)}\n`;
      if (serialized.includes(CREDENTIAL)) throw new Error('Injected writer observed a leaked credential.');
      evidence = serialized;
    },
  });
  return { calls, get evidence() { return evidence; }, manifest, run };
}

async function expectRejectedUnchanged(scenario, message) {
  await expect(scenario.run).rejects.toThrow(message);
  expect(scenario.calls.writes).toEqual([]);
  expect(scenario.evidence).toBe(EVIDENCE_SENTINEL);
}

describe('QA attach/show fail-closed lifecycle coordination', () => {
  it('records one credential-free request only after the same bound subject survives every check', async () => {
    const scenario = createScenario();

    const result = await scenario.run;

    expect(scenario.calls.hashes).toEqual([scenario.manifest.exe, scenario.manifest.exe]);
    expect(scenario.calls.connections).toEqual([scenario.manifest.connection, scenario.manifest.connection]);
    expect(scenario.calls.processes).toEqual(repeated(PID, 6));
    expect(scenario.calls.health).toEqual(repeated({ url: MCP_URL, pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID }, 4));
    expect(scenario.calls.launches).toHaveLength(1);
    expect(scenario.calls.launches[0]).toMatchObject({
      pid: PID,
      instanceId: INSTANCE_A,
      profileId: PROFILE_ID,
      processIdentity: 'process-generation-A',
      requestId: REQUEST_ID,
      arguments: [`--user-data-dir=${PROFILE}`, `--show-engine-instance=${INSTANCE_A}`, `--show-profile-id=${PROFILE_ID}`, `--show-request-id=${REQUEST_ID}`],
    });
    expect(scenario.calls.childExits).toEqual([{ value: { testOwnedChild: true }, timeoutMs: 250 }]);
    expect(scenario.calls.writes).toHaveLength(1);
    expect(result.manifest).toMatchObject({
      windowRequested: true,
      windowRequestedAt: REQUESTED_AT,
      windowRequestId: REQUEST_ID,
      windowRequestInstanceId: INSTANCE_A,
      windowRequestProfileId: PROFILE_ID,
      windowAcknowledgementStatus: 'accepted',
      windowAcknowledgementAttempts: 1,
      windowEvidenceRecordedAt: REQUESTED_AT,
    });
    expect(scenario.evidence).not.toBe(EVIDENCE_SENTINEL);
    expect(scenario.evidence).not.toContain(CREDENTIAL);
  });

  it('rejects a wrong executable hash before reading connection or touching a process/window', async () => {
    const scenario = createScenario({ hashes: [HASH_B] });
    await expectRejectedUnchanged(scenario, 'executable hash changed');
    expect(scenario.calls.connections).toEqual([]);
    expect(scenario.calls.processes).toEqual([]);
    expect(scenario.calls.health).toEqual([]);
    expect(scenario.calls.launches).toEqual([]);
  });

  it('rejects a substituted profile path before any injected side effect', async () => {
    const scenario = createScenario({ manifest: { profile: resolve('test-results', 'qa-show-owned-fixture', 'wrong-profile') } });
    await expectRejectedUnchanged(scenario, 'declared profile path has the wrong identity');
    expect(scenario.calls.hashes).toEqual([]);
    expect(scenario.calls.connections).toEqual([]);
    expect(scenario.calls.processes).toEqual([]);
    expect(scenario.calls.launches).toEqual([]);
  });

  it.each([
    ['PID', { pid: PID + 1 }, 'PID/URL identity changed'],
    ['URL', { url: 'http://127.0.0.1:48301/mcp' }, 'PID/URL identity changed'],
    ['UUID', { instanceId: INSTANCE_B }, 'instance identity changed'],
    ['profile', { profileId: OTHER_PROFILE_ID }, 'profile identity changed'],
  ])('rejects a wrong connection %s before process, health, or window access', async (_kind, override, message) => {
    const scenario = createScenario({ connections: [connection(override)] });
    await expectRejectedUnchanged(scenario, message);
    expect(scenario.calls.processes).toEqual([]);
    expect(scenario.calls.health).toEqual([]);
    expect(scenario.calls.launches).toEqual([]);
  });

  it('rechecks executable and connection identity immediately before launch', async () => {
    const changedHash = createScenario({ hashes: [HASH_A, HASH_B] });
    await expectRejectedUnchanged(changedHash, 'executable hash changed');
    expect(changedHash.calls.launches).toEqual([]);

    const changedConnection = createScenario({ connections: [connection(), connection({ instanceId: INSTANCE_B })] });
    await expectRejectedUnchanged(changedConnection, 'instance identity changed');
    expect(changedConnection.calls.launches).toEqual([]);
  });

  it.each([
    ['stale before health', [{ alive: false, identity: 'process-generation-A' }], 'is not alive', 0],
    ['exited during health', [{ alive: true, identity: 'process-generation-A' }, { alive: false, identity: 'process-generation-A' }], 'exited during initial health verification', 0],
    ['recycled during health', [{ alive: true, identity: 'process-generation-A' }, { alive: true, identity: 'process-generation-B' }], 'was recycled during initial health verification', 0],
    ['ambiguous before launch', [{ alive: true, identity: 'process-generation-A' }, { alive: true, identity: 'process-generation-A' }, { alive: true, identity: undefined }], 'was recycled before the attach signal', 0],
    ['exited after launch', [...repeated({ alive: true, identity: 'process-generation-A' }, 3), { alive: false, identity: 'process-generation-A' }], 'exited while the attach helper exited', 1],
    ['recycled during acknowledgement', [...repeated({ alive: true, identity: 'process-generation-A' }, 4), { alive: true, identity: 'process-generation-B' }], 'was recycled while waiting for receiver acknowledgement', 1],
    ['recycled before evidence', [...repeated({ alive: true, identity: 'process-generation-A' }, 5), { alive: true, identity: 'process-generation-B' }], 'was recycled before recording the show request', 1],
  ])('fails closed when the target is %s', async (_kind, processes, message, expectedLaunches) => {
    const scenario = createScenario({ processes });
    await expectRejectedUnchanged(scenario, message);
    expect(scenario.calls.processes.every((pid) => pid === PID)).toBe(true);
    expect(scenario.calls.launches).toHaveLength(expectedLaunches);
  });

  it('rejects missing or changing health ownership without mutating evidence', async () => {
    const ambiguous = createScenario({ healthProbes: [health({ instanceId: undefined, profileId: undefined })] });
    await expectRejectedUnchanged(ambiguous, 'Health endpoint instance mismatch');
    expect(ambiguous.calls.launches).toEqual([]);

    const changedBeforeLaunch = createScenario({ healthProbes: [health(), health({ instanceId: INSTANCE_B })] });
    await expectRejectedUnchanged(changedBeforeLaunch, 'Health endpoint instance mismatch');
    expect(changedBeforeLaunch.calls.launches).toEqual([]);

    const changedAfterLaunch = createScenario({ healthProbes: [health(), health(), health({ profileId: OTHER_PROFILE_ID })] });
    await expectRejectedUnchanged(changedAfterLaunch, 'Health endpoint profile mismatch');
    expect(changedAfterLaunch.calls.launches).toHaveLength(1);
  });

  it.each([
    ['timeout', null, 'did not return within 10 seconds'],
    ['failure', 7, 'exited with code 7'],
  ])('does not record evidence when the attach child reports %s', async (_kind, childExitCode, message) => {
    const scenario = createScenario({ childExitCode });
    await expectRejectedUnchanged(scenario, message);
    expect(scenario.calls.launches).toHaveLength(1);
  });

  it('does not treat helper exit zero as success without receiver acknowledgement', async () => {
    const scenario = createScenario({ healthProbes: [health(), health(), health()], acknowledgementTimeoutMs: 30, acknowledgementPollMs: 10 });
    await expectRejectedUnchanged(scenario, 'did not acknowledge the attach request before the deadline');
    expect(scenario.calls.childExits).toEqual([{ value: { testOwnedChild: true }, timeoutMs: 250 }]);
    expect(scenario.calls.sleeps).toEqual([10, 10, 10]);
  });

  it('times out on a receiver request that remains pending after helper exit', async () => {
    const pending = acknowledgement({ status: 'pending', acknowledgedAt: undefined });
    const pendingHealth = health({ showAcknowledgements: [pending] });
    const scenario = createScenario({ healthProbes: [health(), health(), pendingHealth], acknowledgementTimeoutMs: 20, acknowledgementPollMs: 10 });
    await expectRejectedUnchanged(scenario, 'did not acknowledge the attach request before the deadline');
    expect(scenario.calls.sleeps).toEqual([10, 10]);
  });

  it('accepts an acknowledgement that arrives after helper exit and rechecks it before evidence commit', async () => {
    const acknowledgedAt = new Date(REQUESTED_AT_MS + 10).toISOString();
    const accepted = health({ showAcknowledgements: [acknowledgement({ acknowledgedAt })] });
    const scenario = createScenario({ healthProbes: [health(), health(), health(), accepted, accepted] });
    const result = await scenario.run;
    expect(scenario.calls.sleeps).toEqual([10]);
    expect(result.acknowledgement).toMatchObject({ requestId: REQUEST_ID, status: 'accepted', acknowledgedAt });
    expect(result.manifest.windowEvidenceRecordedAt).toBe(acknowledgedAt);
  });

  it.each([
    ['wrong instance', 'instance-mismatch'],
    ['wrong profile', 'profile-mismatch'],
    ['malformed request', 'malformed-request'],
    ['window failure', 'window-error'],
  ])('fails closed when the verified receiver rejects a %s request', async (_kind, reason) => {
    const rejected = acknowledgement({ status: 'rejected', reason });
    const scenario = createScenario({ healthProbes: [health(), health(), health({ showAcknowledgements: [rejected] })] });
    await expectRejectedUnchanged(scenario, 'verified show receiver rejected');
  });

  it('rejects a stale prelaunch acknowledgement collision', async () => {
    const scenario = createScenario({ healthProbes: [health({ showAcknowledgements: [acknowledgement()] })] });
    await expectRejectedUnchanged(scenario, 'Stale show acknowledgement existed before launch');
    expect(scenario.calls.launches).toEqual([]);
  });

  it('rejects duplicate acknowledgement both immediately and between acceptance and commit', async () => {
    const duplicate = acknowledgement({ attempts: 2 });
    const immediate = createScenario({ healthProbes: [health(), health(), health({ showAcknowledgements: [duplicate] })] });
    await expectRejectedUnchanged(immediate, 'Duplicate show acknowledgement evidence');

    const accepted = health({ showAcknowledgements: [acknowledgement()] });
    const lateDuplicate = createScenario({ healthProbes: [health(), health(), accepted, health({ showAcknowledgements: [duplicate] })] });
    await expectRejectedUnchanged(lateDuplicate, 'Duplicate show acknowledgement evidence');
  });

  it('rejects two matching acknowledgement records as ambiguous evidence', async () => {
    const scenario = createScenario({ healthProbes: [health(), health(), health({ showAcknowledgements: [acknowledgement(), acknowledgement()] })] });
    await expectRejectedUnchanged(scenario, 'Duplicate show acknowledgement evidence');
  });

  it.each([
    ['wrong PID', { pid: PID + 1 }, 'engine identity mismatch'],
    ['string PID', { pid: String(PID) }, 'Malformed show acknowledgement evidence'],
    ['wrong UUID', { instanceId: INSTANCE_B }, 'engine identity mismatch'],
    ['wrong profile', { profileId: OTHER_PROFILE_ID }, 'profile identity mismatch'],
    ['bad status', { status: 'maybe' }, 'Malformed show acknowledgement evidence'],
    ['bad timestamp', { acknowledgedAt: 'not-a-time' }, 'Malformed show acknowledgement evidence'],
    ['non-canonical timestamp', { acknowledgedAt: '2026-08-05T04:00:00Z' }, 'Malformed show acknowledgement evidence'],
    ['stale timestamp', { acknowledgedAt: new Date(REQUESTED_AT_MS - 1).toISOString() }, 'Stale show acknowledgement evidence'],
    ['future timestamp', { acknowledgedAt: new Date(REQUESTED_AT_MS + 1).toISOString() }, 'Future show acknowledgement evidence'],
    ['credential field', { token: CREDENTIAL }, 'Malformed show acknowledgement evidence'],
  ])('rejects malformed acknowledgement evidence with %s', async (_kind, override, message) => {
    const scenario = createScenario({ healthProbes: [health(), health(), health({ showAcknowledgements: [acknowledgement(override)] })] });
    await expectRejectedUnchanged(scenario, message);
    expect(scenario.evidence).not.toContain(CREDENTIAL);
  });

  it('rejects an acknowledgement timestamp that precedes its receiver timestamp', async () => {
    const inconsistent = acknowledgement({ receivedAt: new Date(REQUESTED_AT_MS + 10).toISOString() });
    const scenario = createScenario({ healthProbes: [health(), health(), health(), health({ showAcknowledgements: [inconsistent] })] });
    await expectRejectedUnchanged(scenario, 'Inconsistent show acknowledgement evidence');
    expect(scenario.calls.sleeps).toEqual([10]);
  });

  it('rejects an acknowledgement timestamp beyond the receiver deadline', async () => {
    const late = acknowledgement({ acknowledgedAt: new Date(REQUESTED_AT_MS + 31).toISOString() });
    const scenario = createScenario({ healthProbes: [health(), health(), health({ showAcknowledgements: [late] })], acknowledgementTimeoutMs: 30 });
    await expectRejectedUnchanged(scenario, 'Late show acknowledgement evidence');
  });

  it('fails on health drift after one pending acknowledgement without touching evidence', async () => {
    const scenario = createScenario({ healthProbes: [health(), health(), health(), health({ instanceId: INSTANCE_B })] });
    await expectRejectedUnchanged(scenario, 'Health endpoint instance mismatch');
    expect(scenario.calls.sleeps).toEqual([10]);
  });

  it('requires a well-formed request UUID before any identity or launcher access', async () => {
    const scenario = createScenario({ requestId: 'malformed' });
    await expectRejectedUnchanged(scenario, 'Invalid QA show request ID');
    expect(scenario.calls.hashes).toEqual([]);
    expect(scenario.calls.launches).toEqual([]);
  });

  it('does not record evidence when the injected window launcher fails', async () => {
    const scenario = createScenario({ launchError: new Error('injected window/show rejection') });
    await expectRejectedUnchanged(scenario, 'injected window/show rejection');
    expect(scenario.calls.launches).toHaveLength(1);
    expect(scenario.calls.childExits).toEqual([]);
  });

  it('rejects credential-bearing public evidence before any identity or window access', async () => {
    const scenario = createScenario({ manifest: { token: CREDENTIAL } });
    await expectRejectedUnchanged(scenario, 'must not contain credential field token');
    expect(scenario.calls.hashes).toEqual([]);
    expect(scenario.calls.processes).toEqual([]);
    expect(scenario.calls.launches).toEqual([]);
  });

  it('propagates an atomic manifest-writer failure without replacing known-good evidence', async () => {
    const scenario = createScenario({ writeError: new Error('injected atomic manifest collision') });
    await expect(scenario.run).rejects.toThrow('injected atomic manifest collision');
    expect(scenario.calls.writes).toHaveLength(1);
    expect(scenario.evidence).toBe(EVIDENCE_SENTINEL);
    expect(JSON.stringify(scenario.calls.writes)).not.toContain(CREDENTIAL);
  });
});
