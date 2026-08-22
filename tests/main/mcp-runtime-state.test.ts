import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPrivateWindowsAcl,
  clearMcpRuntimeState,
  mcpRuntimeStateLocation,
  prepareMcpRuntimeStateRoot,
  publishMcpRuntimeState,
  readMcpRuntimeState,
  readPreparedMcpRuntimeState,
  type McpRuntimeState,
} from '../../src/main/mcp-runtime-state';

const PROFILE_ID = 'A'.repeat(64);

describe('private engine-scoped MCP run-state', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function createRoot(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'aimuse-mcp-state-'));
    return root;
  }

  function state(tokenByte: number, overrides: Partial<McpRuntimeState> = {}): McpRuntimeState {
    return {
      version: 1,
      transport: 'streamable-http',
      authorityLifetime: 'engine',
      pid: process.pid,
      instanceId: randomUUID(),
      profileId: PROFILE_ID,
      url: 'http://127.0.0.1:49152/mcp',
      token: Buffer.alloc(32, tokenByte).toString('base64url'),
      startedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('publishes atomically below a user-private root and removes only the matching authority', async () => {
    const userData = await createRoot();
    const expected = state(0x31);
    await expect(publishMcpRuntimeState(userData, expected)).resolves.toEqual(expected);
    await expect(readMcpRuntimeState(userData, PROFILE_ID)).resolves.toEqual(expected);

    if (process.platform !== 'win32') {
      const location = mcpRuntimeStateLocation(userData);
      expect((await lstat(location.root)).mode & 0o777).toBe(0o700);
      expect((await lstat(location.path)).mode & 0o777).toBe(0o600);
    }

    await expect(clearMcpRuntimeState(userData, expected)).resolves.toBe(true);
    await expect(access(mcpRuntimeStateLocation(userData).path)).rejects.toThrow();
  });

  it('does not let stale cleanup unlink a replacement engine authority', async () => {
    const userData = await createRoot();
    const first = state(0x32);
    const replacement = state(0x33, { startedAt: new Date(Date.now() + 1).toISOString() });
    await publishMcpRuntimeState(userData, first);
    await publishMcpRuntimeState(userData, replacement, { processAlive: () => false });
    await expect(clearMcpRuntimeState(userData, first)).resolves.toBe(false);
    await expect(readMcpRuntimeState(userData, PROFILE_ID)).resolves.toEqual(replacement);
  });

  it('fails closed when an existing live PID has an ambiguous engine identity', async () => {
    const userData = await createRoot();
    const first = state(0x41);
    const replacement = state(0x42, { startedAt: new Date(Date.now() + 1).toISOString() });
    await publishMcpRuntimeState(userData, first);
    await expect(publishMcpRuntimeState(userData, replacement)).rejects.toThrow(/PID is still live.*ambiguous/u);
    await expect(readMcpRuntimeState(userData, PROFILE_ID)).resolves.toEqual(first);
  });

  it('rejects linked or group-readable runtime boundaries', async () => {
    const userData = await createRoot();
    const linkedTarget = join(userData, 'linked-target');
    await mkdir(linkedTarget);
    await symlink(linkedTarget, mcpRuntimeStateLocation(userData).root);
    await expect(prepareMcpRuntimeStateRoot(userData)).rejects.toThrow(/real directory/u);

    await rm(mcpRuntimeStateLocation(userData).root);
    const location = await prepareMcpRuntimeStateRoot(userData);
    await publishMcpRuntimeState(userData, state(0x34));
    if (process.platform !== 'win32') {
      await chmod(location.path, 0o644);
      await expect(readMcpRuntimeState(userData, PROFILE_ID)).rejects.toThrow(/group\/world accessible/u);
    }
  });

  it('rejects replacement of the already-verified private runtime directory object', async () => {
    const userData = await createRoot();
    const prepared = await prepareMcpRuntimeStateRoot(userData);
    await rename(prepared.root, join(userData, 'displaced-runtime'));
    await mkdir(prepared.root, { mode: 0o700 });
    await expect(readPreparedMcpRuntimeState(prepared, PROFILE_ID)).rejects.toThrow(/filesystem identity changed/u);
  });

  it('accepts only a protected Windows ACL limited to the user and OS administrators', () => {
    const sid = 'S-1-5-21-111-222-333-1001';
    const valid = {
      protected: true,
      ownerSid: sid,
      rules: [
        { sid, type: 'Allow', inherited: false, rights: 'FullControl' },
        { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
        { sid: 'S-1-5-32-544', type: 'Allow', inherited: false, rights: 'FullControl' },
      ],
    };
    expect(() => assertPrivateWindowsAcl(valid, sid, true)).not.toThrow();
    expect(() => assertPrivateWindowsAcl({ ...valid, rules: [...valid.rules, { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' }] }, sid, true)).toThrow(/unexpected principal/u);
    expect(() => assertPrivateWindowsAcl({ ...valid, protected: false }, sid, true)).toThrow(/inherits/u);
  });
});
