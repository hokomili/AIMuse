import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorityPolicy } from '@aimuse/core';
import { AuthorityManager } from '../../src/main/authority-manager';

describe('AuthorityManager', () => {
  let root: string;
  let approved: string;
  let overwrite: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-authority-'));
    approved = join(root, 'approved');
    overwrite = join(approved, 'existing.wav');
    await mkdir(approved);
    await writeFile(overwrite, 'existing');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function policy(): AuthorityPolicy {
    const now = Date.now();
    return {
      version: 1, id: 'test-policy', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), maxRuntimeMinutes: 5,
      readRoots: [approved], writeRoots: [approved], overwritePaths: [overwrite], pluginAllowlist: ['vst3:allowed'],
      allowMicrophone: false, allowMidiInput: true, allowMidiOutput: false,
    };
  }

  it('enforces canonical roots and exact overwrite paths', async () => {
    const authority = new AuthorityManager();
    expect(await authority.install(policy())).toEqual({ installed: true });
    await expect(authority.file(join(approved, 'new.wav'), 'write', false)).resolves.toEqual({ allowed: true });
    await expect(authority.file(overwrite, 'write', true)).resolves.toEqual({ allowed: true });
    const sibling = join(root, 'approved-escape', 'file.wav');
    expect((await authority.file(sibling, 'write', false)).allowed).toBe(false);
    expect((await authority.file(join(approved, 'other.wav'), 'write', true)).approvalKind).toBe('overwrite');
  });

  it('denies microphone and unlisted plug-ins by default', async () => {
    const authority = new AuthorityManager();
    await authority.install(policy());
    expect(authority.recording('microphone')).toMatchObject({ allowed: false, approvalKind: 'recording' });
    expect(authority.recording('midi-input')).toEqual({ allowed: true });
    expect(authority.plugin('vst3:unknown')).toMatchObject({ allowed: false, approvalKind: 'plugin' });
    expect(authority.plugin('vst3:allowed')).toEqual({ allowed: true });
  });
});
