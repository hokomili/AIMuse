import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorityPolicy } from '@aimuse/core';
import { readAuthorityPolicyFile } from '../../src/main/authority-policy-file';
import { EngineRuntime } from '../../src/main/engine-runtime';
import { profileIdForPath } from '../../src/main/profile-identity';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('authority policy files', () => {
  let root: string;
  let policyPath: string;
  let runtime: EngineRuntime;
  let policy: AuthorityPolicy;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-policy-file-'));
    policyPath = join(root, 'policy.json');
    const profile = join(root, 'profile');
    runtime = new EngineRuntime({ userDataPath: profile, profileId: profileIdForPath(profile), appVersion: 'test', mode: 'headless', authorityPolicyPath: policyPath });
    policy = {
      version: 1, id: '音楽-policy', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [root], writeRoots: [root], overwritePaths: [], pluginAllowlist: [],
      allowMicrophone: false, allowMidiInput: true, allowMidiOutput: false,
    };
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])('starts the engine with a UTF-8 policy (BOM: %s) and enforces its grants', async (bom) => {
    const json = Buffer.from(JSON.stringify(policy, null, 2).replace(/\n/g, '\r\n'), 'utf8');
    await writeFile(policyPath, bom ? Buffer.concat([UTF8_BOM, json]) : json);

    await runtime.start();

    expect(runtime.authority.snapshot().policy).toEqual(policy);
    expect(runtime.projects.getMcpInfo()).toMatchObject({ running: true });
    const connection = runtime.mcp.connection();
    const health = await fetch(new URL('/health', connection.url), { headers: { authorization: `Bearer ${connection.token}` } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ pid: process.pid, instanceId: connection.instanceId });
    expect(await runtime.authority.file(join(root, 'new.wav'), 'write', false)).toEqual({ allowed: true });
    expect(await runtime.authority.file(policyPath, 'write', true)).toMatchObject({ allowed: false, approvalKind: 'overwrite' });
    expect(await runtime.authority.file(join(root, '..', 'outside.wav'), 'write', false)).toMatchObject({ allowed: false });
    expect(runtime.authority.recording('microphone')).toMatchObject({ allowed: false });
    expect(runtime.authority.recording('midi-input')).toEqual({ allowed: true });
  });

  it('preserves U+FEFF inside JSON strings', async () => {
    policy.id = 'policy-\uFEFF-marker';
    await writeFile(policyPath, Buffer.concat([UTF8_BOM, Buffer.from(JSON.stringify(policy))]));
    expect(await readAuthorityPolicyFile(policyPath)).toEqual(policy);
  });

  it.each([
    ['empty file', ''],
    ['BOM alone', '\uFEFF'],
    ['malformed JSON', '\uFEFF{"private-value": "do-not-echo",}'],
    ['duplicate BOM', '\uFEFF\uFEFF{}'],
    ['marker after whitespace', ' \uFEFF{}'],
  ])('rejects %s with policy-file guidance before starting services', async (_label, content) => {
    await writeFile(policyPath, content, 'utf8');
    const error = await runtime.start().then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`Authority policy file ${JSON.stringify(policyPath)} is not valid JSON.`);
    expect((error as Error).message).toContain('UTF-8 JSON');
    expect((error as Error).message).not.toContain('do-not-echo');
    expect(runtime.authority.snapshot().policy).toBeUndefined();
    expect(runtime.mcp.connection().url).toBeUndefined();
  });

  it.each(['invalid schema', 'expired'] as const)('still rejects a BOM policy that is %s', async (failure) => {
    const value = failure === 'invalid schema' ? { ...policy, allowMicrophone: 'true' } : { ...policy, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    await writeFile(policyPath, Buffer.concat([UTF8_BOM, Buffer.from(JSON.stringify(value))]));
    await expect(runtime.start()).rejects.toThrow('Authority policy was rejected:');
    expect(runtime.authority.snapshot().policy).toBeUndefined();
    expect(runtime.mcp.connection().url).toBeUndefined();
  });

  it('retains the filesystem error when the policy is missing', async () => {
    await expect(runtime.start()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.authority.snapshot().policy).toBeUndefined();
    expect(runtime.mcp.connection().url).toBeUndefined();
  });
});
