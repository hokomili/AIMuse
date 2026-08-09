import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNativeExecutionCwd,
  NATIVE_EXECUTION_CWD_NAME,
  withNativeExecutionCwd,
} from '../../scripts/qa-private-root-node-api-execution-cwd.mjs';

const EVIDENCE_ROOT = 'E:\\AIMuse\\test-results';
const RUN_ROOT = `${EVIDENCE_ROOT}\\qa10-native-cwd-fixture`;
const ORIGINAL_CWD = 'E:\\AIMuse';
const CWD_ROOT = join(RUN_ROOT, NATIVE_EXECUTION_CWD_NAME);
const ORIGINAL_IDENTITY = Object.freeze({ version: 1, canonicalPath: ORIGINAL_CWD, device: '1', inode: '10' });
const CWD_IDENTITY = Object.freeze({ version: 1, canonicalPath: CWD_ROOT, device: '1', inode: '20' });

function fixture(options = {}) {
  let currentDirectory = ORIGINAL_CWD;
  let directoryRead = 0;
  const mkdir = vi.fn();
  const protectRoot = vi.fn();
  const assertRoot = vi.fn(async () => ({ identity: CWD_IDENTITY }));
  const readdir = vi.fn(async () => {
    directoryRead += 1;
    return directoryRead === 1 ? [] : (options.finalEntries ?? []);
  });
  const pathIdentity = vi.fn(async (path) => {
    if (resolve(path).toUpperCase() === resolve(ORIGINAL_CWD).toUpperCase()) return ORIGINAL_IDENTITY;
    if (resolve(path).toUpperCase() === resolve(CWD_ROOT).toUpperCase()) return options.finalIdentity ?? CWD_IDENTITY;
    throw new Error('Unexpected identity path.');
  });
  const observeMutations = vi.fn(() => ({
    finish: vi.fn(async () => ({ eventCount: options.mutationEventCount ?? 0 })),
  }));
  let stampRead = 0;
  const directoryMutationStamp = vi.fn(async () => {
    stampRead += 1;
    return { size: '0', modified: options.metadataChanged && stampRead > 1 ? '2' : '1', changed: '1' };
  });
  const changeDirectory = vi.fn((path) => {
    if (options.restoreFailure && resolve(path).toUpperCase() === resolve(ORIGINAL_CWD).toUpperCase()) {
      throw new Error('mock restore denied');
    }
    currentDirectory = resolve(path);
  });
  const dependencies = {
    platform: 'win32',
    mkdir,
    protectRoot,
    assertRoot,
    readdir,
    pathIdentity,
    observeMutations,
    directoryMutationStamp,
    getCurrentDirectory: () => currentDirectory,
    changeDirectory,
  };
  return { dependencies, getCurrentDirectory: () => currentDirectory, mkdir, protectRoot, assertRoot, readdir, observeMutations, changeDirectory };
}

describe('QA-10 native provider process-CWD containment', () => {
  it('enters one fresh owner-private run-owned CWD, proves callback identity, observes no mutation, and restores the caller', async () => {
    const subject = fixture();
    const action = vi.fn(async (context) => {
      expect(subject.getCurrentDirectory()).toBe(resolve(CWD_ROOT));
      await expect(assertNativeExecutionCwd(context, subject.dependencies)).resolves.toBe(true);
      return 'native-result';
    });
    const result = await withNativeExecutionCwd({ runRoot: RUN_ROOT, evidenceRoot: EVIDENCE_ROOT, action }, subject.dependencies);
    expect(result.value).toBe('native-result');
    expect(result.evidence).toEqual({
      version: 1,
      relativeName: NATIVE_EXECUTION_CWD_NAME,
      ownerPrivateEstablished: true,
      initialIdentityVerified: true,
      initialEntryCount: 0,
      callbackEnteredWithVerifiedRunOwnedCwd: true,
      finalIdentityVerified: true,
      directoryMetadataStable: true,
      finalEntryCount: 0,
      mutationEventCount: 0,
      unexpectedMutationDetected: false,
      cwdRestored: true,
      mutationContainmentIndependentlyObserved: true,
    });
    expect(subject.getCurrentDirectory()).toBe(resolve(ORIGINAL_CWD));
    expect(subject.mkdir).toHaveBeenCalledWith(CWD_ROOT);
    expect(subject.protectRoot).toHaveBeenCalledWith(CWD_ROOT);
    expect(subject.assertRoot).toHaveBeenNthCalledWith(1, { privateRoot: CWD_ROOT, paths: [], evidenceRoot: resolve(RUN_ROOT) });
    expect(subject.assertRoot).toHaveBeenNthCalledWith(2, { privateRoot: CWD_ROOT, paths: [], evidenceRoot: resolve(RUN_ROOT) });
    expect(subject.changeDirectory.mock.calls.map(([path]) => resolve(path))).toEqual([resolve(CWD_ROOT), resolve(ORIGINAL_CWD)]);
  });

  it('fails before the callback when the owner-private CWD cannot be established', async () => {
    const subject = fixture();
    subject.dependencies.protectRoot = vi.fn(async () => { throw new Error('mock ACL rejection'); });
    const action = vi.fn();
    await expect(withNativeExecutionCwd({ runRoot: RUN_ROOT, evidenceRoot: EVIDENCE_ROOT, action }, subject.dependencies))
      .rejects.toMatchObject({ code: 'AIMUSE_QA_NATIVE_CWD_CONTAINMENT', containmentEvidence: { mutationContainmentIndependentlyObserved: false } });
    expect(action).not.toHaveBeenCalled();
    expect(subject.getCurrentDirectory()).toBe(resolve(ORIGINAL_CWD));
  });

  it('restores and reports a clean independently observed boundary when the native callback fails', async () => {
    const subject = fixture();
    const nativeFailure = Object.freeze({
      version: 1,
      kind: 'snapshot-open',
      phase: 'rotation-during-external-replace',
      win32Code: 32,
      providerAuthorityExplicitlyBound: true,
      sharedLeasePreflightCompleted: true,
      providerLeaseAcquired: true,
      providerAtomicReplaceCompleted: true,
      concurrentReplacementWorkerActive: true,
    });
    const action = vi.fn(async () => {
      const failure = new Error('mock native case failure');
      failure.providerNativeFailureEvidence = nativeFailure;
      throw failure;
    });
    let error;
    try {
      await withNativeExecutionCwd({ runRoot: RUN_ROOT, evidenceRoot: EVIDENCE_ROOT, action }, subject.dependencies);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ message: 'mock native case failure', providerNativeFailureEvidence: nativeFailure, containmentEvidence: {
      mutationContainmentIndependentlyObserved: true,
      unexpectedMutationDetected: false,
      cwdRestored: true,
    } });
    expect(subject.getCurrentDirectory()).toBe(resolve(ORIGINAL_CWD));
  });

  it('fails closed and retains evidence when a callback leaves or transiently causes a CWD mutation', async () => {
    const subject = fixture({ finalEntries: ['unexpected.dat'], mutationEventCount: 2, metadataChanged: true });
    let error;
    try {
      await withNativeExecutionCwd({ runRoot: RUN_ROOT, evidenceRoot: EVIDENCE_ROOT, action: async () => 'done' }, subject.dependencies);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'AIMUSE_QA_NATIVE_CWD_CONTAINMENT', containmentEvidence: {
      finalEntryCount: 1,
      directoryMetadataStable: false,
      mutationEventCount: 2,
      unexpectedMutationDetected: true,
      cwdRestored: true,
      mutationContainmentIndependentlyObserved: false,
    } });
    expect(subject.getCurrentDirectory()).toBe(resolve(ORIGINAL_CWD));
  });

  it('treats restoration failure as containment failure rather than continuing silently', async () => {
    const subject = fixture({ restoreFailure: true });
    await expect(withNativeExecutionCwd({ runRoot: RUN_ROOT, evidenceRoot: EVIDENCE_ROOT, action: async () => 'done' }, subject.dependencies))
      .rejects.toMatchObject({ code: 'AIMUSE_QA_NATIVE_CWD_CONTAINMENT', containmentEvidence: {
        cwdRestored: false,
        mutationContainmentIndependentlyObserved: false,
      } });
    expect(subject.getCurrentDirectory()).toBe(resolve(CWD_ROOT));
  });

  it('rejects a callback context that does not name the dedicated child of the current run root', async () => {
    const subject = fixture();
    await expect(assertNativeExecutionCwd({
      path: `${RUN_ROOT}\\other-cwd`,
      runRoot: RUN_ROOT,
      identity: CWD_IDENTITY,
    }, subject.dependencies)).rejects.toThrow('dedicated child');
  });
});
