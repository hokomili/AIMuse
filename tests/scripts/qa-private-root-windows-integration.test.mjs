import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  assertStablePrivateRootObservations,
  runPrivateRootWindowsIntegration,
  validateIntegrationRunRoot,
} from '../../scripts/qa-private-root-windows-integration.mjs';

const TEST_RESULTS = resolve('test-results');
const createdRoots = [];

afterEach(async () => {
  while (createdRoots.length) await rm(createdRoots.pop(), { recursive: true, force: true });
});

function freshRunRoot(label) {
  const root = join(TEST_RESULTS, `.qa10-windows-private-root-${label}-${randomUUID()}`);
  createdRoots.push(root);
  return root;
}

async function observation(path, overrides = {}) {
  const info = await lstat(path);
  return {
    root: path,
    platform: 'win32',
    owner: 'launching-user',
    allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
    inspectedPaths: 1,
    identity: {
      version: 1,
      canonicalPath: await realpath(path),
      device: String(info.dev),
      inode: String(info.ino),
      ...overrides,
    },
  };
}

function injectedDependencies(verifyRoot) {
  return {
    platform: 'win32',
    protectRoot: async () => ({
      platform: 'win32',
      owner: 'launching-user',
      allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
      inheritedFromBroadParent: false,
    }),
    verifyRoot,
  };
}

describe('QA-10 default Windows private-root integration harness', () => {
  it('accepts only an absolute direct child of the declared test-results root', () => {
    const root = freshRunRoot('path');
    expect(validateIntegrationRunRoot(root, TEST_RESULTS, 'win32')).toBe(root);
    expect(() => validateIntegrationRunRoot(join(root, 'nested'), TEST_RESULTS, 'win32')).toThrow('one direct child');
    expect(() => validateIntegrationRunRoot(dirname(TEST_RESULTS), TEST_RESULTS, 'win32')).toThrow('one direct child');
    expect(() => validateIntegrationRunRoot('relative-fixture', TEST_RESULTS, 'win32')).toThrow('absolute path');
  });

  it('requires three exact canonical/device/inode observations from the Windows owner contract', () => {
    const root = freshRunRoot('identity');
    const safe = {
      root,
      platform: 'win32',
      owner: 'launching-user',
      allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
      identity: { version: 1, canonicalPath: root, device: '17', inode: '42' },
    };
    expect(assertStablePrivateRootObservations([safe, structuredClone(safe), structuredClone(safe)], root, 'win32')).toEqual(safe.identity);
    const drifted = structuredClone(safe);
    drifted.identity.inode = '43';
    expect(() => assertStablePrivateRootObservations([safe, structuredClone(safe), drifted], root, 'win32')).toThrow('identity changed');
  });

  it('writes one credential-free PASS record only after protected acceptance, broad rejection and stable identity', async () => {
    const root = freshRunRoot('pass');
    const calls = [];
    const verifyRoot = vi.fn(async ({ privateRoot }) => {
      calls.push(privateRoot);
      if (privateRoot.endsWith('inherited-broad-sibling')) throw new Error('Private run root still inherits access rules.');
      return observation(privateRoot);
    });

    const result = await runPrivateRootWindowsIntegration(root, injectedDependencies(verifyRoot));
    expect(result).toMatchObject({
      outcome: 'PASS',
      runRoot: root,
      protectedRoot: { accepted: true, identityObservations: 3, inheritedFromBroadParent: false },
      inheritedBroadSibling: { rejected: true },
      boundaries: { defaultVerifier: true, credentialOrBearerAccessed: false, processInspectedOrSignaled: false },
      cleanup: { failureScope: root, failureRequiresMatchingDirectoryIdentity: true, passEvidenceRetained: true },
    });
    expect(calls.filter((path) => path.endsWith('protected-root'))).toHaveLength(3);
    expect(calls.filter((path) => path.endsWith('inherited-broad-sibling'))).toHaveLength(1);
    expect(JSON.parse(await readFile(result.artifacts.summary.path, 'utf8'))).toMatchObject({ outcome: 'PASS', runRoot: root });
    expect(await readFile(result.artifacts.report.path, 'utf8')).toContain('default, non-injected Windows private-root verifier');
  });

  it('fails closed and removes only its exact root when the broad sibling is accepted', async () => {
    const root = freshRunRoot('broad-accepted');
    const removePath = vi.fn(async (path, options) => rm(path, options));
    const dependencies = {
      ...injectedDependencies(async ({ privateRoot }) => observation(privateRoot)),
      removePath,
    };

    await expect(runPrivateRootWindowsIntegration(root, dependencies)).rejects.toThrow('accepted the inherited-broad sibling');
    expect(removePath).toHaveBeenCalledOnce();
    expect(removePath).toHaveBeenCalledWith(root, { recursive: true, force: false });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans the exact run root without writing evidence when protected identity drifts', async () => {
    const root = freshRunRoot('identity-drift');
    let protectedObservation = 0;
    const verifyRoot = async ({ privateRoot }) => {
      if (privateRoot.endsWith('inherited-broad-sibling')) throw new Error('Private run root still inherits access rules.');
      protectedObservation += 1;
      return observation(privateRoot, protectedObservation === 3 ? { inode: '999999' } : {});
    };

    await expect(runPrivateRootWindowsIntegration(root, injectedDependencies(verifyRoot))).rejects.toThrow('identity changed');
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses failure cleanup when the run-root directory object no longer matches', async () => {
    const root = freshRunRoot('cleanup-identity');
    let liveRootReads = 0;
    const lstatPath = async (path) => {
      const info = await lstat(path);
      if (resolve(path).toUpperCase() !== root.toUpperCase()) return info;
      liveRootReads += 1;
      if (liveRootReads < 2) return info;
      return {
        dev: info.dev,
        ino: String(info.ino) === '99999999999999999999' ? '88888888888888888888' : '99999999999999999999',
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
      };
    };
    const removePath = vi.fn(async (path, options) => rm(path, options));
    const dependencies = {
      ...injectedDependencies(async ({ privateRoot }) => observation(privateRoot)),
      lstatPath,
      removePath,
    };

    await expect(runPrivateRootWindowsIntegration(root, dependencies)).rejects.toThrow('exact-root cleanup also failed');
    expect(removePath).not.toHaveBeenCalled();
    expect((await lstat(root)).isDirectory()).toBe(true);
  });
});
