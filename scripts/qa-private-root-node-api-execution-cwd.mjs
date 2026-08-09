import { watch } from 'node:fs';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { assertOwnerPrivateRoot, protectOwnerPrivateRoot } from './qa-private-root.mjs';

export const NATIVE_EXECUTION_CWD_NAME = 'native-process-cwd';

function samePath(left, right, platform) {
  return platform === 'win32'
    ? resolve(left).toUpperCase() === resolve(right).toUpperCase()
    : resolve(left) === resolve(right);
}

function sameIdentity(left, right, platform) {
  return left?.version === 1 && right?.version === 1 &&
    samePath(left.canonicalPath, right.canonicalPath, platform) &&
    left.device === right.device && left.inode === right.inode;
}

async function pathIdentity(path) {
  const [canonicalPath, info] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native execution CWD must remain one real directory object.');
  return {
    version: 1,
    canonicalPath: resolve(canonicalPath),
    device: String(info.dev),
    inode: String(info.ino),
  };
}

async function directoryMutationStamp(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native execution CWD mutation stamp requires one real directory.');
  return {
    size: String(info.size),
    modified: String(info.mtimeNs),
    changed: String(info.ctimeNs),
  };
}

function sameMutationStamp(left, right) {
  return left?.size === right?.size && left?.modified === right?.modified && left?.changed === right?.changed;
}

function startDirectoryMutationObserver(path) {
  let eventCount = 0;
  let observerError;
  const observer = watch(path, { persistent: false }, () => { eventCount += 1; });
  observer.on('error', (error) => { observerError = error; });
  return {
    async finish() {
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      observer.close();
      if (observerError) throw new Error('Native execution CWD mutation observation failed.', { cause: observerError });
      return { eventCount };
    },
  };
}

function publicEvidence(state) {
  const independentlyObserved = state.ownerPrivateEstablished === true &&
    state.initialIdentityVerified === true &&
    state.initialEntryCount === 0 &&
    state.callbackEnteredWithVerifiedRunOwnedCwd === true &&
    state.finalIdentityVerified === true &&
    state.directoryMetadataStable === true &&
    state.finalEntryCount === 0 &&
    state.mutationEventCount === 0 &&
    state.cwdRestored === true;
  return Object.freeze({
    version: 1,
    relativeName: NATIVE_EXECUTION_CWD_NAME,
    ownerPrivateEstablished: state.ownerPrivateEstablished === true,
    initialIdentityVerified: state.initialIdentityVerified === true,
    initialEntryCount: state.initialEntryCount ?? null,
    callbackEnteredWithVerifiedRunOwnedCwd: state.callbackEnteredWithVerifiedRunOwnedCwd === true,
    finalIdentityVerified: state.finalIdentityVerified === true,
    directoryMetadataStable: state.directoryMetadataStable === true,
    finalEntryCount: state.finalEntryCount ?? null,
    mutationEventCount: state.mutationEventCount ?? null,
    unexpectedMutationDetected: state.unexpectedMutationDetected === true,
    cwdRestored: state.cwdRestored === true,
    mutationContainmentIndependentlyObserved: independentlyObserved,
  });
}

function containmentError(message, cause, state) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'AIMUSE_QA_NATIVE_CWD_CONTAINMENT';
  error.containmentEvidence = publicEvidence(state);
  return error;
}

export async function assertNativeExecutionCwd(context, dependencies = {}) {
  if (!context || typeof context !== 'object' || typeof context.path !== 'string' || !isAbsolute(context.path) ||
      typeof context.runRoot !== 'string' || !isAbsolute(context.runRoot)) {
    throw new Error('A verified native execution CWD context is required before addon loading.');
  }
  const platform = dependencies.platform ?? process.platform;
  const getCurrentDirectory = dependencies.getCurrentDirectory ?? (() => process.cwd());
  const identify = dependencies.pathIdentity ?? pathIdentity;
  const expectedPath = join(resolve(context.runRoot), NATIVE_EXECUTION_CWD_NAME);
  if (!samePath(context.path, expectedPath, platform) || !samePath(dirname(context.path), context.runRoot, platform)) {
    throw new Error('Native execution CWD is not the dedicated child of the current run root.');
  }
  const current = resolve(getCurrentDirectory());
  if (!samePath(current, context.path, platform)) throw new Error('Native addon loading was denied outside the verified run-owned CWD.');
  const observed = await identify(context.path);
  if (!sameIdentity(observed, context.identity, platform)) throw new Error('Native execution CWD object identity changed before addon loading.');
  return true;
}

export async function withNativeExecutionCwd({ runRoot, evidenceRoot, action }, dependencies = {}) {
  if (typeof runRoot !== 'string' || !isAbsolute(runRoot)) throw new Error('Native execution run root must be absolute.');
  if (typeof evidenceRoot !== 'string' || !isAbsolute(evidenceRoot) || !samePath(dirname(resolve(runRoot)), evidenceRoot, dependencies.platform ?? process.platform)) {
    throw new Error('Native execution evidence root must be the exact parent of the run root.');
  }
  if (typeof action !== 'function') throw new Error('Native execution action is required.');

  const platform = dependencies.platform ?? process.platform;
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const protect = dependencies.protectRoot ?? protectOwnerPrivateRoot;
  const assertRoot = dependencies.assertRoot ?? assertOwnerPrivateRoot;
  const readDirectory = dependencies.readdir ?? readdir;
  const identify = dependencies.pathIdentity ?? pathIdentity;
  const mutationStamp = dependencies.directoryMutationStamp ?? directoryMutationStamp;
  const observeMutations = dependencies.observeMutations ?? startDirectoryMutationObserver;
  const getCurrentDirectory = dependencies.getCurrentDirectory ?? (() => process.cwd());
  const changeDirectory = dependencies.changeDirectory ?? ((path) => process.chdir(path));
  const cwdRoot = join(resolve(runRoot), NATIVE_EXECUTION_CWD_NAME);
  if (!samePath(dirname(cwdRoot), runRoot, platform)) throw new Error('Native execution CWD escaped the run root.');

  const state = {
    ownerPrivateEstablished: false,
    initialIdentityVerified: false,
    initialEntryCount: null,
    callbackEnteredWithVerifiedRunOwnedCwd: false,
    finalIdentityVerified: false,
    directoryMetadataStable: false,
    finalEntryCount: null,
    mutationEventCount: null,
    unexpectedMutationDetected: false,
    cwdRestored: false,
  };
  let actionError;
  let containmentFailure;
  let result;
  let observer;
  let changedDirectory = false;
  let originalDirectory;
  let originalIdentity;
  let cwdIdentity;
  let initialMutationStamp;

  try {
    originalDirectory = resolve(getCurrentDirectory());
    originalIdentity = await identify(originalDirectory);
    await makeDirectory(cwdRoot);
    await protect(cwdRoot);
    const privateObservation = await assertRoot({ privateRoot: cwdRoot, paths: [], evidenceRoot: resolve(runRoot) });
    state.ownerPrivateEstablished = true;
    cwdIdentity = await identify(cwdRoot);
    if (!sameIdentity(cwdIdentity, privateObservation.identity, platform)) throw new Error('Native execution CWD protection observed a different directory object.');
    state.initialIdentityVerified = true;
    const initialEntries = await readDirectory(cwdRoot);
    state.initialEntryCount = initialEntries.length;
    if (initialEntries.length !== 0) throw new Error('Fresh native execution CWD was not empty.');
    initialMutationStamp = await mutationStamp(cwdRoot);
    observer = observeMutations(cwdRoot);
    changeDirectory(cwdRoot);
    changedDirectory = true;
    const executionContext = Object.freeze({ path: cwdRoot, runRoot: resolve(runRoot), identity: Object.freeze({ ...cwdIdentity }) });
    await assertNativeExecutionCwd(executionContext, { platform, getCurrentDirectory, pathIdentity: identify });
    state.callbackEnteredWithVerifiedRunOwnedCwd = true;
    try {
      result = await action(executionContext);
    } catch (error) {
      actionError = error;
    }

    if (!samePath(getCurrentDirectory(), cwdRoot, platform)) throw new Error('Native execution changed the process CWD unexpectedly.');
    await assertNativeExecutionCwd(executionContext, { platform, getCurrentDirectory, pathIdentity: identify });
    const finalObservation = await assertRoot({ privateRoot: cwdRoot, paths: [], evidenceRoot: resolve(runRoot) });
    if (!sameIdentity(cwdIdentity, finalObservation.identity, platform)) throw new Error('Native execution CWD owner-private identity changed.');
    state.finalIdentityVerified = true;
    const finalEntries = await readDirectory(cwdRoot);
    state.finalEntryCount = finalEntries.length;
    if (finalEntries.length !== 0) state.unexpectedMutationDetected = true;
    state.directoryMetadataStable = sameMutationStamp(initialMutationStamp, await mutationStamp(cwdRoot));
    if (!state.directoryMetadataStable) state.unexpectedMutationDetected = true;
  } catch (error) {
    containmentFailure = error;
    state.unexpectedMutationDetected = true;
  } finally {
    if (observer) {
      try {
        const observed = await observer.finish();
        state.mutationEventCount = observed.eventCount;
        if (observed.eventCount !== 0) state.unexpectedMutationDetected = true;
      } catch (error) {
        containmentFailure ??= error;
        state.unexpectedMutationDetected = true;
      }
    }
    if (changedDirectory) {
      try {
        changeDirectory(originalDirectory);
        const restoredIdentity = await identify(originalDirectory);
        if (!samePath(getCurrentDirectory(), originalDirectory, platform) || !sameIdentity(restoredIdentity, originalIdentity, platform)) {
          containmentFailure ??= new Error('Original process CWD identity was not restored.');
        } else {
          state.cwdRestored = true;
        }
      } catch (error) {
        containmentFailure ??= error;
      }
    }
  }

  if (state.finalEntryCount !== 0 || state.mutationEventCount !== 0 || !state.directoryMetadataStable) {
    containmentFailure ??= new Error('Unexpected mutation was observed inside the retained native execution CWD.');
  }
  if (containmentFailure) throw containmentError(containmentFailure.message, containmentFailure, state);
  const evidence = publicEvidence(state);
  if (!evidence.mutationContainmentIndependentlyObserved) {
    throw containmentError('Native execution CWD containment was not independently established.', undefined, state);
  }
  if (actionError) {
    const error = new Error(actionError?.message ?? String(actionError), { cause: actionError });
    error.containmentEvidence = evidence;
    if (actionError?.providerNativeFailureEvidence) {
      error.providerNativeFailureEvidence = actionError.providerNativeFailureEvidence;
    }
    throw error;
  }
  return Object.freeze({ value: result, evidence });
}
