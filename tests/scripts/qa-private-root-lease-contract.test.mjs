import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  PRIVATE_ROOT_LEASE_CAPABILITIES,
  normalizePrivateRootLeaseDescriptor,
  withPrivateRootHandleLease,
} from '../../scripts/qa-private-root-lease-contract.mjs';

const ROOT = 'E:\\AIMuse\\test-results\\qa10-handle-contract-fixture';
const MANIFEST = join(ROOT, 'session.json');
const CONNECTION = join(ROOT, 'connection.json');
const IDENTITY = { version: 1, canonicalPath: ROOT, device: '17', inode: '42' };

function descriptor(overrides = {}) {
  return {
    version: 1,
    root: ROOT,
    identity: IDENTITY,
    security: {
      owner: 'launching-user',
      protected: true,
      allowOnly: true,
      ownerFullControl: true,
      allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'],
    },
    object: { directory: true, reparsePoint: false, deleteShareDenied: true },
    capabilities: Object.fromEntries(PRIVATE_ROOT_LEASE_CAPABILITIES.map((name) => [name, true])),
    ...overrides,
  };
}

function observation() {
  return { root: ROOT, identity: IDENTITY, platform: 'win32', owner: 'launching-user', allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'], inspectedPaths: 3 };
}

function snapshot(path, bytes, inode = '100') {
  return {
    version: 1,
    path,
    rootIdentity: IDENTITY,
    fileIdentity: { version: 1, canonicalPath: path, device: '17', inode },
    contained: true,
    reparsePoint: false,
    securityValidated: true,
    bytes,
  };
}

function replaceResult(path, bytes) {
  return {
    version: 1,
    path,
    rootIdentity: IDENTITY,
    committed: true,
    stagedAndRenamedByHandle: true,
    pinnedAbsoluteTarget: true,
    byteLength: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength,
  };
}

function fixture(overrides = {}) {
  const leaseDescriptor = descriptor();
  const lease = {
    descriptor: leaseDescriptor,
    assertCurrent: vi.fn(async () => leaseDescriptor),
    readSnapshot: vi.fn(async (path) => snapshot(path, Buffer.from('snapshot'))),
    atomicReplace: vi.fn(async (path, bytes) => replaceResult(path, bytes)),
    close: vi.fn(async () => undefined),
    ...overrides.lease,
  };
  const dependencies = {
    platform: 'win32',
    assertPrivateRoot: vi.fn(async () => observation()),
    acquireLease: vi.fn(async () => lease),
    ...overrides.dependencies,
  };
  const options = { privateRoot: ROOT, paths: [MANIFEST, CONNECTION], persistedRoot: ROOT, persistedIdentity: IDENTITY };
  return { lease, dependencies, options };
}

describe('QA-10 Windows handle-bound private-root lease contract', () => {
  it('fails closed on legacy state without persisted root identity before lease or sensitive access', async () => {
    const { dependencies, options } = fixture();
    const action = vi.fn();
    await expect(withPrivateRootHandleLease({ ...options, persistedIdentity: undefined }, action, dependencies)).rejects.toThrow('Persisted private root identity');
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('requires architecture review when no approved handle provider exists', async () => {
    const { dependencies, options } = fixture();
    delete dependencies.acquireLease;
    const action = vi.fn();
    await expect(withPrivateRootHandleLease(options, action, dependencies)).rejects.toThrow('Architecture review required');
    expect(action).not.toHaveBeenCalled();
  });

  it('holds one validated lease around a sensitive action and closes it', async () => {
    const { lease, dependencies, options } = fixture();
    const sensitive = vi.fn(async () => 'done');
    const result = await withPrivateRootHandleLease(options, (context) => context.runSensitive('process inspection', sensitive), dependencies);
    expect(result).toBe('done');
    expect(sensitive).toHaveBeenCalledOnce();
    expect(lease.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(dependencies.assertPrivateRoot.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong root identity', { identity: { ...IDENTITY, inode: '43' } }, 'does not match'],
    ['wrong owner', { security: { ...descriptor().security, owner: 'foreign-user' } }, 'owner-private ACL'],
    ['broad principal', { security: { ...descriptor().security, allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators', 'Users'] } }, 'allowed principals'],
    ['inherited ACL', { security: { ...descriptor().security, protected: false } }, 'owner-private ACL'],
    ['reparse root', { object: { ...descriptor().object, reparsePoint: true } }, 'non-reparse directory'],
    ['delete sharing', { object: { ...descriptor().object, deleteShareDenied: false } }, 'against delete/rename'],
    ['missing atomic replace', { capabilities: { ...descriptor().capabilities, pinnedAbsolutePathAtomicReplace: false } }, 'missing required capability'],
    ['private metadata', { token: 'fixture-private-value' }, 'unsupported field'],
  ])('rejects %s before the operation', async (_case, mutation, message) => {
    const { lease, dependencies, options } = fixture({ lease: { descriptor: descriptor(mutation) } });
    const action = vi.fn();
    await expect(withPrivateRootHandleLease(options, action, dependencies)).rejects.toThrow(message);
    expect(action).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('makes a handle or path revalidation failure sticky before later sensitive work', async () => {
    const { lease, dependencies, options } = fixture();
    const drift = new Error('handle identity drift');
    lease.assertCurrent.mockResolvedValueOnce(descriptor()).mockResolvedValueOnce(descriptor()).mockRejectedValue(drift);
    const action = vi.fn();
    await expect(withPrivateRootHandleLease(options, async (context) => {
      await expect(context.guard()).rejects.toBe(drift);
      const callsAfterFailure = lease.assertCurrent.mock.calls.length;
      await expect(context.runSensitive('must not run', action)).rejects.toBe(drift);
      expect(lease.assertCurrent).toHaveBeenCalledTimes(callsAfterFailure);
    }, dependencies)).rejects.toBe(drift);
    expect(action).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('reopens each handle-validated snapshot so bearer rotation cannot be cached', async () => {
    const { lease, dependencies, options } = fixture();
    lease.readSnapshot.mockResolvedValueOnce(snapshot(CONNECTION, Buffer.from('mock-rotation-a'), '100')).mockResolvedValueOnce(snapshot(CONNECTION, Buffer.from('mock-rotation-b'), '101'));
    const values = await withPrivateRootHandleLease(options, async (context) => [
      (await context.readSnapshot(CONNECTION)).toString('utf8'),
      (await context.readSnapshot(CONNECTION)).toString('utf8'),
    ], dependencies);
    expect(values).toEqual(['mock-rotation-a', 'mock-rotation-b']);
    expect(lease.readSnapshot).toHaveBeenCalledTimes(2);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('rejects an escaped or reparse snapshot before returning its bytes', async () => {
    const { lease, dependencies, options } = fixture();
    lease.readSnapshot.mockResolvedValue({ ...snapshot(CONNECTION, Buffer.from('must-not-return')), reparsePoint: true });
    const received = vi.fn();
    await expect(withPrivateRootHandleLease(options, async (context) => received(await context.readSnapshot(CONNECTION)), dependencies)).rejects.toThrow('contained, non-reparse');
    expect(received).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('allows only an exact allowlisted pinned absolute-path atomic replace and verifies byte count', async () => {
    const { lease, dependencies, options } = fixture();
    const bytes = Buffer.from('{"credentialFree":true}\n');
    const result = await withPrivateRootHandleLease(options, (context) => context.atomicReplace(MANIFEST, bytes), dependencies);
    expect(result).toMatchObject({ path: MANIFEST, committed: true, stagedAndRenamedByHandle: true, pinnedAbsoluteTarget: true, byteLength: bytes.byteLength });
    expect(lease.atomicReplace).toHaveBeenCalledWith(MANIFEST, bytes);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('rejects non-allowlisted paths before native read or write mediation', async () => {
    const { lease, dependencies, options } = fixture();
    const outside = 'E:\\AIMuse\\test-results\\foreign\\state.json';
    await expect(withPrivateRootHandleLease(options, (context) => context.readSnapshot(outside), dependencies)).rejects.toThrow('not allowlisted');
    expect(lease.readSnapshot).not.toHaveBeenCalled();
    expect(lease.atomicReplace).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('closes the lease when the guarded operation fails', async () => {
    const { lease, dependencies, options } = fixture();
    const failure = new Error('injected operation failure');
    await expect(withPrivateRootHandleLease(options, async () => { throw failure; }, dependencies)).rejects.toBe(failure);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('surfaces a lease-close failure without retrying an ambiguous close', async () => {
    const closeFailure = new Error('injected close failure');
    const { lease, dependencies, options } = fixture({ lease: { close: vi.fn(async () => { throw closeFailure; }) } });
    await expect(withPrivateRootHandleLease(options, async () => 'complete', dependencies)).rejects.toBe(closeFailure);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('normalizes only credential-free strict descriptors', () => {
    expect(normalizePrivateRootLeaseDescriptor(descriptor(), ROOT, IDENTITY, 'win32')).toMatchObject({ root: ROOT, identity: IDENTITY });
  });
});
