import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { coordinateStop, waitForConnectionReadiness } from '../../scripts/qa-lifecycle.mjs';

const PID = 99_999_993;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const MCP_URL = 'http://127.0.0.1:48300/mcp';
const PROFILE_ID = 'A'.repeat(64);
const createdRoots = [];

async function evidenceFixture() {
  const root = await mkdtemp(resolve('test-results', 'qa-lifecycle-'));
  createdRoots.push(root);
  const manifestPath = join(root, 'session.json');
  const connectionPath = join(root, 'connection.json');
  const manifestBytes = Buffer.from('{"sentinel":"known-good-manifest"}\n');
  const connectionBytes = Buffer.from('{"sentinel":"known-good-connection","token":"fake-test-credential"}\n');
  await writeFile(manifestPath, manifestBytes);
  await writeFile(connectionPath, connectionBytes);
  return {
    connectionPath,
    manifestPath,
    assertUnchanged: async () => {
      expect(await readFile(manifestPath)).toEqual(manifestBytes);
      expect(await readFile(connectionPath)).toEqual(connectionBytes);
    },
  };
}

function health(instanceId = INSTANCE_A, profileId) {
  return { name: 'AIMuse Engine', status: 'ok', pid: PID, instanceId, ...(profileId ? { profileId } : {}) };
}

afterEach(async () => {
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('QA connection readiness with an injected clock', () => {
  it('accepts a late connection only after malformed attempts become one complete matching identity', async () => {
    const fixture = await evidenceFixture();
    let clock = 0; let attempts = 0; const healthCalls = [];
    const result = await waitForConnectionReadiness({ connectionPath: fixture.connectionPath, expectedPid: PID, expectedProfileId: PROFILE_ID, startedAt: 0, timeoutMs: 50, pollMs: 10 }, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      statConnection: async () => { attempts += 1; if (attempts === 1) throw new Error('injected not found'); return { mtimeMs: 0 }; },
      readConnection: async () => attempts === 2
        ? '{"token":"fake-test-credential"'
        : JSON.stringify({ version: 1, url: MCP_URL, token: 'fake-test-credential', pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID }),
      probeHealth: async (url, pid, instanceId, profileId) => { healthCalls.push({ url, pid, instanceId, profileId }); return health(INSTANCE_A, PROFILE_ID); },
    });

    expect(attempts).toBe(3);
    expect(clock).toBe(20);
    expect(healthCalls).toEqual([{ url: MCP_URL, pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID }]);
    expect(result.connection).toMatchObject({ pid: PID, url: MCP_URL, instanceId: INSTANCE_A, profileId: PROFILE_ID });
    expect(result.health.subjectIdentity).toBe(`instance:${INSTANCE_A}/profile:${PROFILE_ID}`);
    await fixture.assertUnchanged();
  });

  it('times out deterministically without probing health when the connection stays malformed past its deadline', async () => {
    const fixture = await evidenceFixture();
    let clock = 0; let attempts = 0; let healthCalls = 0;
    const run = waitForConnectionReadiness({ connectionPath: fixture.connectionPath, expectedPid: PID, expectedProfileId: PROFILE_ID, startedAt: 0, timeoutMs: 30, pollMs: 10 }, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      statConnection: async () => { attempts += 1; return { mtimeMs: 0 }; },
      readConnection: async () => attempts >= 4
        ? JSON.stringify({ version: 1, url: MCP_URL, token: 'too-late', pid: PID, instanceId: INSTANCE_A, profileId: PROFILE_ID })
        : '{"token":"fake-test-credential"',
      probeHealth: async () => { healthCalls += 1; return health(); },
    });

    await expect(run).rejects.toThrow('AIMuse QA engine did not become ready');
    await expect(run).rejects.not.toThrow('fake-test-credential');
    expect(clock).toBe(30);
    expect(attempts).toBe(3);
    expect(healthCalls).toBe(0);
    await fixture.assertUnchanged();
  });
});

describe('QA stop time-of-check-to-time-of-use coordination', () => {
  async function runFault(options) {
    const { processInspections, healthProbes } = options;
    const instanceId = Object.hasOwn(options, 'instanceId') ? options.instanceId : INSTANCE_A;
    const fixture = await evidenceFixture();
    const inspectedPids = []; const signals = []; let healthIndex = 0; let processIndex = 0;
    const run = coordinateStop({ pid: PID, mcpUrl: MCP_URL, instanceId }, {
      inspectProcess: async (pid) => { inspectedPids.push(pid); return processInspections[processIndex++]; },
      probeHealth: async () => healthProbes[healthIndex++],
      signal: async (target) => { signals.push(target); return 0; },
    });
    return { fixture, healthCalls: () => healthIndex, inspectedPids, run, signals };
  }

  it('does not signal when the PID exits between liveness checks', async () => {
    const scenario = await runFault({ processInspections: [{ alive: true, identity: 'process-A' }, { alive: false, identity: 'process-A' }], healthProbes: [health()] });
    await expect(scenario.run).rejects.toThrow('exited during initial health verification');
    expect(scenario.inspectedPids).toEqual([PID, PID]);
    expect(scenario.healthCalls()).toBe(1);
    expect(scenario.signals).toEqual([]);
    await scenario.fixture.assertUnchanged();
  });

  it('does not signal when the PID is recycled between liveness checks', async () => {
    const scenario = await runFault({ processInspections: [{ alive: true, identity: 'process-A' }, { alive: true, identity: 'process-B' }], healthProbes: [health()] });
    await expect(scenario.run).rejects.toThrow('was recycled during initial health verification');
    expect(scenario.inspectedPids).toEqual([PID, PID]);
    expect(scenario.healthCalls()).toBe(1);
    expect(scenario.signals).toEqual([]);
    await scenario.fixture.assertUnchanged();
  });

  it('does not signal when health instance identity changes between probes', async () => {
    const scenario = await runFault({ instanceId: undefined, processInspections: [{ alive: true, identity: 'process-A' }, { alive: true, identity: 'process-A' }], healthProbes: [health(INSTANCE_A), health(INSTANCE_B)] });
    await expect(scenario.run).rejects.toThrow('health identity changed between probes');
    expect(scenario.inspectedPids).toEqual([PID, PID]);
    expect(scenario.healthCalls()).toBe(2);
    expect(scenario.signals).toEqual([]);
    await scenario.fixture.assertUnchanged();
  });

  it('does not signal when the stop target changes immediately before signal dispatch', async () => {
    const scenario = await runFault({ processInspections: [{ alive: true, identity: 'process-A' }, { alive: true, identity: 'process-A' }, { alive: true, identity: 'process-B' }], healthProbes: [health(), health()] });
    await expect(scenario.run).rejects.toThrow('was recycled before the quit signal');
    expect(scenario.inspectedPids).toEqual([PID, PID, PID]);
    expect(scenario.healthCalls()).toBe(2);
    expect(scenario.signals).toEqual([]);
    await scenario.fixture.assertUnchanged();
  });

  it('signals exactly once with the verified process and health identities when every check stays stable', async () => {
    const scenario = await runFault({ processInspections: Array.from({ length: 3 }, () => ({ alive: true, identity: 'process-A' })), healthProbes: [health(), health()] });
    await expect(scenario.run).resolves.toMatchObject({ processIdentity: 'process-A', healthIdentity: `instance:${INSTANCE_A}`, instanceId: INSTANCE_A, signalResult: 0 });
    expect(scenario.inspectedPids).toEqual([PID, PID, PID]);
    expect(scenario.healthCalls()).toBe(2);
    expect(scenario.signals).toEqual([{ pid: PID, mcpUrl: MCP_URL, instanceId: INSTANCE_A, processIdentity: 'process-A', healthIdentity: `instance:${INSTANCE_A}` }]);
    await scenario.fixture.assertUnchanged();
  });
});
