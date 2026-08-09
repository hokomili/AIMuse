import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteJsonEvidence, buildRedactedConnection, validateRedactedConnection } from '../../scripts/qa-evidence.mjs';
import { buildStopManifest, waitForStopCompletion } from '../../scripts/qa-lifecycle.mjs';

const PID = 99_999_994;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const MCP_URL = 'http://127.0.0.1:48300/mcp';
const TOKEN = 'fake-test-credential-must-remain-private';
const COMPLETED_AT = '2026-08-05T00:00:00.000Z';
const createdRoots = [];

async function fixture() {
  const root = await mkdtemp(resolve('test-results', 'qa-stop-cleanup-'));
  createdRoots.push(root);
  const connectionPath = join(root, 'connection.json');
  const manifestPath = join(root, 'session.json');
  const manifest = { version: 1, pid: PID, instanceId: INSTANCE_A, mcpUrl: MCP_URL, connection: connectionPath, trustedFolders: [] };
  const connection = { version: 1, pid: PID, instanceId: INSTANCE_A, url: MCP_URL, token: TOKEN, activeProjectId: 'project_test' };
  const connectionBytes = Buffer.from(`${JSON.stringify(connection, null, 2)}\n`);
  await writeFile(connectionPath, connectionBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    connection,
    connectionBytes,
    connectionPath,
    manifest,
    manifestPath,
    persist: async (result) => {
      const updated = buildStopManifest(manifest, result, COMPLETED_AT);
      await atomicWriteJsonEvidence(manifestPath, updated);
      return updated;
    },
  };
}

function health(instanceId = INSTANCE_A) {
  return { name: 'AIMuse Engine', status: 'ok', pid: PID, instanceId };
}

async function scenario(options) {
  let clock = 0; let healthIndex = 0; let processIndex = 0; let redactions = 0;
  const inspectedPids = []; const healthCalls = [];
  const processInspections = options.processInspections;
  const healthProbes = options.healthProbes ?? [health()];
  const result = await waitForStopCompletion({
    pid: PID,
    mcpUrl: MCP_URL,
    instanceId: INSTANCE_A,
    processIdentity: 'process-A',
    healthIdentity: `instance:${INSTANCE_A}`,
    timeoutMs: options.timeoutMs ?? 30,
    pollMs: 10,
  }, {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    inspectProcess: async (pid) => {
      inspectedPids.push(pid);
      const value = processInspections[Math.min(processIndex, processInspections.length - 1)];
      processIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    probeHealth: async (url, pid, instanceId) => {
      healthCalls.push({ url, pid, instanceId });
      const value = healthProbes[Math.min(healthIndex, healthProbes.length - 1)];
      healthIndex += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    redact: async (identity) => {
      redactions += 1;
      return options.redact?.(identity);
    },
  });
  return { clock, healthCalls, inspectedPids, redactions, result };
}

afterEach(async () => {
  while (createdRoots.length) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('post-signal exit and credential-redaction polling', () => {
  it('redacts only after two matching-generation exit observations and records credential-free success evidence', async () => {
    const files = await fixture();
    const run = await scenario({
      processInspections: [{ alive: true, identity: 'process-A' }, { alive: true, identity: 'process-A' }, { alive: false }, { alive: false }],
      healthProbes: [health(), { unavailable: true }],
      redact: async (identity) => {
        expect(identity).toEqual({ pid: PID, instanceId: INSTANCE_A, processIdentity: 'process-A', healthIdentity: `instance:${INSTANCE_A}` });
        const redacted = buildRedactedConnection(files.manifest, files.connection, COMPLETED_AT);
        await atomicWriteJsonEvidence(files.connectionPath, redacted, { validate: (value) => validateRedactedConnection(value, files.manifest) });
        return redacted;
      },
    });
    const evidence = await files.persist(run.result);
    const redactedText = await readFile(files.connectionPath, 'utf8');

    expect(run.result).toMatchObject({ outcome: 'stopped-redacted', stopped: true, connectionCredentialsRedacted: true, polls: 3, healthUnavailable: true });
    expect(run.clock).toBe(20);
    expect(run.redactions).toBe(1);
    expect(run.inspectedPids).toEqual([PID, PID, PID, PID]);
    expect(JSON.parse(redactedText)).toMatchObject({ pid: PID, instanceId: INSTANCE_A, url: MCP_URL, credentialsRedacted: true });
    expect(redactedText).not.toContain(TOKEN);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(evidence).toMatchObject({ stopped: true, stopOutcome: 'stopped-redacted', connectionCredentialsRedacted: true });
  });

  it('times out on the same live generation without redaction and writes only credential-free public evidence', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: true, identity: 'process-A' }], healthProbes: [health()] });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'timeout', stopped: false, connectionCredentialsRedacted: false, polls: 4 });
    expect(run.clock).toBe(30);
    expect(run.redactions).toBe(0);
    expect(run.inspectedPids).toEqual([PID, PID, PID, PID]);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(evidence).toMatchObject({ stopped: false, stopOutcome: 'timeout', connectionCredentialsRedacted: false });
  });

  it('stops polling without redaction when the declared PID is recycled', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: true, identity: 'process-A' }, { alive: true, identity: 'process-B' }], healthProbes: [health()] });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'identity-changed', stopped: false, connectionCredentialsRedacted: false, polls: 2 });
    expect(run.redactions).toBe(0);
    expect(run.inspectedPids).toEqual([PID, PID]);
    expect(run.healthCalls).toHaveLength(1);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
  });

  it('stops polling without redaction when health instance identity changes', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: true, identity: 'process-A' }], healthProbes: [health(), health(INSTANCE_B)] });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'identity-changed', stopped: false, connectionCredentialsRedacted: false, polls: 2 });
    expect(run.redactions).toBe(0);
    expect(run.inspectedPids).toEqual([PID, PID]);
    expect(run.healthCalls).toHaveLength(2);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
  });

  it('does not redact when a not-alive observation becomes live during confirmation', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: false }, { alive: true, identity: 'process-A' }] });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'identity-ambiguous', stopped: false, connectionCredentialsRedacted: false, polls: 1 });
    expect(run.redactions).toBe(0);
    expect(run.healthCalls).toEqual([]);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
  });

  it('does not redact when process generation becomes unavailable', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: true, identity: undefined }] });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'identity-ambiguous', stopped: false, connectionCredentialsRedacted: false, polls: 1 });
    expect(run.redactions).toBe(0);
    expect(run.healthCalls).toEqual([]);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
  });

  it('records a redaction failure without corrupting the private connection sentinel', async () => {
    const files = await fixture();
    const run = await scenario({ processInspections: [{ alive: false }, { alive: false }], redact: async () => { throw new Error('injected redaction failure'); } });
    const evidence = await files.persist(run.result);

    expect(run.result).toMatchObject({ outcome: 'redaction-failed', stopped: true, connectionCredentialsRedacted: false, polls: 1 });
    expect(run.redactions).toBe(1);
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(evidence).toMatchObject({ stopped: true, stopOutcome: 'redaction-failed', connectionCredentialsRedacted: false });
  });

  it('rejects internally inconsistent public stop evidence', async () => {
    const files = await fixture();
    expect(() => buildStopManifest(files.manifest, {
      outcome: 'identity-changed',
      stopped: true,
      connectionCredentialsRedacted: false,
      reason: 'invalid test evidence',
      polls: 1,
      healthUnavailable: false,
    }, COMPLETED_AT)).toThrow('Inconsistent QA stop evidence');
    expect(await readFile(files.connectionPath)).toEqual(files.connectionBytes);
  });
});
