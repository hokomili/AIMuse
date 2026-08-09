import { mkdir, open, readFile, readdir, realpath, rename, symlink, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { normalizePrivateRootLeaseDescriptor, withPrivateRootHandleLease } from './qa-private-root-lease-contract.mjs';
import { protectOwnerPrivateRoot } from './qa-private-root.mjs';
import { loadPrivateRootNodeApiProvider } from './qa-private-root-node-api-provider.mjs';
import { assertNativeExecutionCwd } from './qa-private-root-node-api-execution-cwd.mjs';
import { createProviderCheckpointAuthority } from './qa-private-root-node-api-authority.mjs';

const USERS_SID = 'S-1-5-32-545';

export const NATIVE_SNAPSHOT_PHASES = Object.freeze({
  'visibility-after-provider-commit': Object.freeze({ providerAtomicReplaceCompleted: true, concurrentReplacementWorkerActive: false }),
  'rotation-before-provider-commit': Object.freeze({ providerAtomicReplaceCompleted: false, concurrentReplacementWorkerActive: false }),
  'rotation-after-provider-commit': Object.freeze({ providerAtomicReplaceCompleted: true, concurrentReplacementWorkerActive: false }),
  'rotation-during-external-replace': Object.freeze({ providerAtomicReplaceCompleted: true, concurrentReplacementWorkerActive: true }),
  'rotation-after-external-replace': Object.freeze({ providerAtomicReplaceCompleted: true, concurrentReplacementWorkerActive: false }),
  'reparse-probe': Object.freeze({ providerAtomicReplaceCompleted: false, concurrentReplacementWorkerActive: false }),
});

export const NATIVE_AUTHORITY_PHASES = Object.freeze([
  'broad-principal-restoration',
  'sticky-acl-restoration',
  'primary-final-observation',
]);

const SNAPSHOT_OPEN_ERROR = /^CreateFileW\(snapshot\) failed with Windows error (\d+)\.$/;
const UNEXPECTED_PRINCIPAL_ERROR = /^Private path grants an unexpected principal: S-[0-9-]+\.$/;

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function normalizeProviderNativeFailureEvidence(value) {
  if (value?.kind === 'snapshot-open') {
    const keys = [
      'version', 'kind', 'phase', 'win32Code', 'providerAuthorityExplicitlyBound', 'sharedLeasePreflightCompleted',
      'providerLeaseAcquired', 'providerAtomicReplaceCompleted', 'concurrentReplacementWorkerActive',
    ];
    if (!exactKeys(value, keys) || value.version !== 1 ||
        !Object.hasOwn(NATIVE_SNAPSHOT_PHASES, value.phase) || !Number.isInteger(value.win32Code) ||
        value.win32Code < 0 || value.win32Code > 0xffff_ffff || value.providerAuthorityExplicitlyBound !== true ||
        value.sharedLeasePreflightCompleted !== true || value.providerLeaseAcquired !== true) {
      throw new Error('Provider native failure evidence is malformed or outside the fixed snapshot matrix.');
    }
    const phase = NATIVE_SNAPSHOT_PHASES[value.phase];
    if (value.providerAtomicReplaceCompleted !== phase.providerAtomicReplaceCompleted ||
        value.concurrentReplacementWorkerActive !== phase.concurrentReplacementWorkerActive) {
      throw new Error('Provider native failure evidence contradicts its fixed snapshot phase.');
    }
    return Object.freeze({ ...value });
  }
  const keys = ['version', 'kind', 'phase', 'providerAuthorityExplicitlyBound', 'unexpectedPrincipalDetected'];
  if (!exactKeys(value, keys) || value.version !== 1 || value.kind !== 'js-authority-acl' ||
      !NATIVE_AUTHORITY_PHASES.includes(value.phase) || value.providerAuthorityExplicitlyBound !== true ||
      value.unexpectedPrincipalDetected !== true) {
    throw new Error('Provider native failure evidence is malformed or outside the fixed authority matrix.');
  }
  return Object.freeze({ ...value });
}

export function runNativeSnapshotPhase(phase, action) {
  if (!Object.hasOwn(NATIVE_SNAPSHOT_PHASES, phase) || typeof action !== 'function') {
    throw new Error('Native snapshot discriminator requires one fixed phase and action.');
  }
  try {
    return action();
  } catch (error) {
    const match = SNAPSHOT_OPEN_ERROR.exec(String(error?.message ?? error));
    if (!match) throw error;
    const profile = NATIVE_SNAPSHOT_PHASES[phase];
    const evidence = normalizeProviderNativeFailureEvidence({
      version: 1,
      kind: 'snapshot-open',
      phase,
      win32Code: Number(match[1]),
      providerAuthorityExplicitlyBound: true,
      sharedLeasePreflightCompleted: true,
      providerLeaseAcquired: true,
      providerAtomicReplaceCompleted: profile.providerAtomicReplaceCompleted,
      concurrentReplacementWorkerActive: profile.concurrentReplacementWorkerActive,
    });
    const sanitized = new Error(`Native snapshot phase ${phase} failed with Windows error ${evidence.win32Code}.`, { cause: error });
    sanitized.providerNativeFailureEvidence = evidence;
    throw sanitized;
  }
}

export async function runNativeAuthorityPhase(phase, action) {
  if (!NATIVE_AUTHORITY_PHASES.includes(phase) || typeof action !== 'function') {
    throw new Error('Native authority discriminator requires one fixed phase and action.');
  }
  try {
    return await action();
  } catch (error) {
    if (!UNEXPECTED_PRINCIPAL_ERROR.test(String(error?.message ?? error))) throw error;
    const evidence = normalizeProviderNativeFailureEvidence({
      version: 1,
      kind: 'js-authority-acl',
      phase,
      providerAuthorityExplicitlyBound: true,
      unexpectedPrincipalDetected: true,
    });
    const sanitized = new Error(`Native authority phase ${phase} rejected an unexpected principal.`, { cause: error });
    sanitized.providerNativeFailureEvidence = evidence;
    throw sanitized;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(action, pattern, label) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  if (error?.providerNativeFailureEvidence) throw error;
  assert(error instanceof Error, `${label} unexpectedly succeeded.`);
  if (pattern) assert(pattern.test(error.message), `${label} failed with the wrong diagnostic: ${error.message}`);
  return error;
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} returned ${result.status}: ${(result.stderr || result.stdout).trim()}`);
}

function grantBroadRead(path) {
  run('icacls.exe', [path, '/grant', `*${USERS_SID}:(OI)(CI)(R)`]);
}

function removeBroadRead(path) {
  run('icacls.exe', [path, '/remove:g', `*${USERS_SID}`, '/T']);
}

export async function restoreNegativeAclFixture({ authority, root, paths, expectedIdentity, phase }, dependencies = {}) {
  const removeGrant = dependencies.removeBroadRead ?? removeBroadRead;
  const protectRoot = dependencies.protectOwnerPrivateRoot ?? protectOwnerPrivateRoot;
  removeGrant(root);
  await protectRoot(root);
  const restored = await runNativeAuthorityPhase(phase,
    () => authority.assertPrivateRoot({ privateRoot: root, paths }));
  assert(JSON.stringify(restored.identity) === JSON.stringify(expectedIdentity),
    'Negative ACL fixture identity changed during restoration.');
  assert(restored.inspectedPaths === paths.length + 1,
    'Negative ACL fixture restoration did not revalidate every affected object.');
  return restored;
}

async function objectIdentity(path) {
  const [canonicalPath, info] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  return { canonicalPath: resolve(canonicalPath), device: String(info.dev), inode: String(info.ino) };
}

async function raceSnapshots(lease, target, root) {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const state = new Int32Array(shared);
  const payloadA = `race-a-${'a'.repeat(8185)}`;
  const payloadB = `race-b-${'b'.repeat(8185)}`;
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const { writeFileSync, renameSync } = require('node:fs');
    const { join } = require('node:path');
    const state = new Int32Array(workerData.shared);
    Atomics.store(state, 0, 1); Atomics.notify(state, 0);
    let successes = 0;
    for (let index = 0; index < 500; index += 1) {
      const stage = join(workerData.root, '.race-' + (index % 2) + '.tmp');
      try {
        writeFileSync(stage, index % 2 ? workerData.payloadA : workerData.payloadB);
        renameSync(stage, workerData.target);
        successes += 1;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code)) throw error;
      }
    }
    Atomics.store(state, 1, successes);
    Atomics.store(state, 0, 2); Atomics.notify(state, 0);
  `, { eval: true, workerData: { shared, root, target, payloadA, payloadB } });
  if (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0, 10_000);
  assert(Atomics.load(state, 0) >= 1, 'Replacement worker did not start.');
  const accepted = new Set(['rotation-b', payloadA, payloadB]);
  const observed = new Set();
  let reads = 0;
  while ((Atomics.load(state, 0) === 1 || reads < 100) && reads < 5_000) {
    const value = Buffer.from(runNativeSnapshotPhase('rotation-during-external-replace', () => lease.readSnapshot(target)).bytes).toString('utf8');
    assert(accepted.has(value), 'A handle snapshot returned mixed or unrecognized replacement bytes.');
    observed.add(value);
    reads += 1;
  }
  if (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1, 10_000);
  await worker.terminate();
  const finalValue = Buffer.from(runNativeSnapshotPhase('rotation-after-external-replace', () => lease.readSnapshot(target)).bytes).toString('utf8');
  assert(accepted.has(finalValue), 'The final handle snapshot returned mixed replacement bytes.');
  observed.add(finalValue);
  assert(Atomics.load(state, 1) > 0, 'The concurrent replacement worker never completed an atomic child replacement.');
  assert(observed.has(payloadA) || observed.has(payloadB), 'Fresh snapshots did not observe any completed concurrent replacement.');
  return { reads, replacements: Atomics.load(state, 1), distinctCompletePayloads: observed.size };
}

function acquire(provider, privateRoot, paths, identity) {
  return provider.acquireLease({ version: 1, privateRoot, paths, expectedIdentity: identity });
}

export async function runPrivateRootNodeApiNativeCases({ runRoot, addonPath, executionCwd }, dependencies = {}) {
  if (process.platform !== 'win32') throw new Error('The real private-root Node-API cases require Windows.');
  const assertExecutionCwd = dependencies.assertExecutionCwd ?? assertNativeExecutionCwd;
  await assertExecutionCwd(executionCwd);
  const authority = createProviderCheckpointAuthority(runRoot, { assertRoot: dependencies.assertRoot });
  const provider = loadPrivateRootNodeApiProvider(addonPath);
  const privateRoot = join(runRoot, 'protected-root');
  const closeRoot = join(runRoot, 'close-root');
  const closeMoved = join(runRoot, 'close-root-moved');
  const unsafeRoot = join(runRoot, 'unsafe-root');
  const aclDriftRoot = join(runRoot, 'acl-drift-root');
  const outside = join(runRoot, 'outside-target');
  for (const path of [privateRoot, closeRoot, unsafeRoot, aclDriftRoot, outside]) await mkdir(path);
  await protectOwnerPrivateRoot(privateRoot);
  await protectOwnerPrivateRoot(closeRoot);
  await protectOwnerPrivateRoot(unsafeRoot);
  await protectOwnerPrivateRoot(aclDriftRoot);

  const connection = join(privateRoot, 'connection.json');
  const manifest = join(privateRoot, 'session.json');
  const visibilityTarget = join(privateRoot, 'rename-visibility.json');
  const directoryTarget = join(privateRoot, 'directory-target');
  const reparseTarget = join(privateRoot, 'reparse-target');
  await writeFile(connection, 'rotation-a');
  await writeFile(manifest, 'known-good-manifest');
  await writeFile(visibilityTarget, 'displaced-target-bytes');
  await mkdir(directoryTarget);
  const paths = [connection, manifest, visibilityTarget, directoryTarget, reparseTarget];
  const observation = await authority.assertPrivateRoot({ privateRoot, paths });
  const results = [];
  const record = async (name, action) => {
    const detail = await action();
    results.push({ name, outcome: 'PASS', ...(detail ?? {}) });
  };

  await record('contract-adapter-and-handle-descriptor', async () => {
    const value = await withPrivateRootHandleLease(
      { privateRoot, paths: [connection, manifest], persistedRoot: privateRoot, persistedIdentity: observation.identity },
      (context) => context.runSensitive('test-owned mediated marker', async () => 'mediated'),
      { platform: 'win32', acquireLease: provider.acquireLease, assertPrivateRoot: authority.assertPrivateRoot },
    );
    assert(value === 'mediated', 'The native provider did not satisfy the established mediated lease contract.');
    return { mediated: true };
  });

  await record('replacement-visibility-binds-subsequent-open-to-stage', async () => {
    const displaced = await open(visibilityTarget, 'r');
    const lease = await acquire(provider, privateRoot, paths, observation.identity);
    try {
      const replacement = 'renamed-stage-bytes';
      const result = lease.atomicReplace(visibilityTarget, replacement);
      assert(result.committed === true && result.stagedAndRenamedByHandle === true && result.pinnedAbsoluteTarget === true,
        'Pinned absolute-path replacement did not report an exact commit.');
      const current = Buffer.from(runNativeSnapshotPhase('visibility-after-provider-commit',
        () => lease.readSnapshot(visibilityTarget)).bytes).toString('utf8');
      assert(current === replacement, 'A subsequent target-name open did not bind to the renamed stage.');
      const displacedBytes = await displaced.readFile('utf8');
      assert(displacedBytes === 'displaced-target-bytes', 'The pre-existing target handle did not remain on the displaced object.');
      return { subsequentOpenBoundRenamedFile: true, displacedHandlePreserved: true };
    } finally {
      try { lease.close(); } finally { await displaced.close(); }
    }
  });

  await record('fresh-snapshot-rotation-and-child-race', async () => {
    const lease = await acquire(provider, privateRoot, paths, observation.identity);
    try {
      normalizePrivateRootLeaseDescriptor(lease.descriptor, privateRoot, observation.identity, 'win32');
      const first = Buffer.from(runNativeSnapshotPhase('rotation-before-provider-commit',
        () => lease.readSnapshot(connection)).bytes).toString('utf8');
      assert(first === 'rotation-a', 'The first handle snapshot returned the wrong bytes.');
      const replaced = lease.atomicReplace(connection, Buffer.from('rotation-b'));
      assert(replaced.committed === true && replaced.stagedAndRenamedByHandle === true && replaced.pinnedAbsoluteTarget === true,
        'The pinned absolute-path rotation did not report an exact commit.');
      const second = Buffer.from(runNativeSnapshotPhase('rotation-after-provider-commit',
        () => lease.readSnapshot(connection)).bytes).toString('utf8');
      assert(second === 'rotation-b', 'A fresh handle snapshot reused stale rotation bytes.');
      return await raceSnapshots(lease, connection, privateRoot);
    } finally {
      lease.close();
    }
  });

  await record('final-component-reparse-rejection', async () => {
    await symlink(outside, reparseTarget, 'junction');
    const lease = await acquire(provider, privateRoot, paths, observation.identity);
    try {
      await expectFailure(() => runNativeSnapshotPhase('reparse-probe', () => lease.readSnapshot(reparseTarget)),
        /non-reparse|final path/i, 'Reparse snapshot');
      await expectFailure(() => lease.assertCurrent(), /non-reparse|final path/i, 'Sticky reparse failure');
    } finally {
      lease.close();
    }
    return { sticky: true };
  });

  await record('handle-relative-replace-and-failed-stage-cleanup', async () => {
    const lease = await acquire(provider, privateRoot, paths, observation.identity);
    const before = await readFile(manifest, 'utf8');
    try {
      const replacement = 'replacement-is-complete';
      const result = lease.atomicReplace(manifest, replacement);
      assert(result.byteLength === Buffer.byteLength(replacement), 'Atomic replacement reported the wrong byte count.');
      assert(await readFile(manifest, 'utf8') === replacement, 'Atomic replacement did not publish exact bytes.');
    } finally {
      lease.close();
    }
    const failureLease = await acquire(provider, privateRoot, paths, observation.identity);
    try {
      await expectFailure(() => failureLease.atomicReplace(directoryTarget, 'must-not-replace-directory'), /FileRenameInfo|atomic/i, 'Directory collision');
    } finally {
      failureLease.close();
    }
    const stages = (await readdir(privateRoot)).filter((name) => name.startsWith('.aimuse-stage-'));
    assert(stages.length === 0, 'A failed atomic replacement abandoned a stage file.');
    assert(await readFile(manifest, 'utf8') !== before, 'The successful replacement did not supersede the known-good sentinel.');
    assert((await lstat(directoryTarget)).isDirectory(), 'The rejected directory target was mutated.');
    return { abandonedStages: 0 };
  });

  await record('broad-principal-acquisition-rejection', async () => {
    const unsafeFile = join(unsafeRoot, 'connection.json');
    await writeFile(unsafeFile, 'unsafe-root-sentinel');
    const unsafeObservation = await authority.assertPrivateRoot({ privateRoot: unsafeRoot, paths: [unsafeFile] });
    grantBroadRead(unsafeRoot);
    try {
      await expectFailure(() => acquire(provider, unsafeRoot, [unsafeFile], unsafeObservation.identity), /unexpected principal/i, 'Broad-principal acquisition');
    } finally {
      await restoreNegativeAclFixture({
        authority,
        root: unsafeRoot,
        paths: [unsafeFile],
        expectedIdentity: unsafeObservation.identity,
        phase: 'broad-principal-restoration',
      });
    }
    assert(await readFile(unsafeFile, 'utf8') === 'unsafe-root-sentinel', 'Broad-principal rejection mutated its sentinel.');
    return { sentinelPreserved: true, affectedObjectsRevalidated: 2 };
  });

  await record('acl-drift-is-sticky', async () => {
    const aclDriftFile = join(aclDriftRoot, 'connection.json');
    await writeFile(aclDriftFile, 'acl-drift-sentinel');
    const aclDriftObservation = await authority.assertPrivateRoot({ privateRoot: aclDriftRoot, paths: [aclDriftFile] });
    const lease = await acquire(provider, aclDriftRoot, [aclDriftFile], aclDriftObservation.identity);
    grantBroadRead(aclDriftRoot);
    let first;
    try {
      first = await expectFailure(() => lease.assertCurrent(), /unexpected principal/i, 'Handle-derived ACL drift');
    } finally {
      await restoreNegativeAclFixture({
        authority,
        root: aclDriftRoot,
        paths: [aclDriftFile],
        expectedIdentity: aclDriftObservation.identity,
        phase: 'sticky-acl-restoration',
      });
    }
    try {
      const second = await expectFailure(() => lease.assertCurrent(), /unexpected principal/i, 'Sticky ACL drift');
      assert(second.message === first.message, 'The native provider did not preserve the first sticky validation failure.');
    } finally {
      lease.close();
    }
    assert(await readFile(aclDriftFile, 'utf8') === 'acl-drift-sentinel', 'ACL-drift restoration mutated its sentinel.');
    return { sticky: true, isolatedFromAcceptedRoot: true, affectedObjectsRevalidated: 2 };
  });

  await record('non-delete-share-and-exactly-once-close', async () => {
    const closeFile = join(closeRoot, 'connection.json');
    await writeFile(closeFile, 'close-sentinel');
    const closeObservation = await authority.assertPrivateRoot({ privateRoot: closeRoot, paths: [closeFile] });
    const beforeIdentity = await objectIdentity(closeRoot);
    const lease = await acquire(provider, closeRoot, [closeFile], closeObservation.identity);
    await expectFailure(() => rename(closeRoot, closeMoved), /EPERM|EACCES|EBUSY/i, 'Root replacement while leased');
    lease.close();
    await expectFailure(() => lease.close(), /already closed/i, 'Duplicate close');
    await rename(closeRoot, closeMoved);
    try {
      assert(await readFile(join(closeMoved, 'connection.json'), 'utf8') === 'close-sentinel', 'Post-close move changed the root sentinel.');
    } finally {
      await rename(closeMoved, closeRoot);
    }
    const afterIdentity = await objectIdentity(closeRoot);
    assert(JSON.stringify(afterIdentity) === JSON.stringify(beforeIdentity), 'The post-close rename round trip changed root object identity.');
    return { exactObjectPreserved: true };
  });

  const finalObservation = await runNativeAuthorityPhase('primary-final-observation',
    () => authority.assertPrivateRoot({ privateRoot, paths: [connection, manifest, directoryTarget] }));
  assert(JSON.stringify(finalObservation.identity) === JSON.stringify(observation.identity), 'The protected-root identity changed across native cases.');
  return {
    providerVersion: provider.version,
    caseCount: results.length,
    cases: results,
    privateRootIdentity: finalObservation.identity,
    closeRootIdentity: await objectIdentity(closeRoot),
    boundaries: {
      applicationLaunches: 0,
      nativeHelperProcesses: 0,
      networkCalls: 0,
      credentialAccesses: 0,
      retainedRootAccesses: 0,
      mutationContainmentIndependentlyObserved: true,
      providerAuthorityExplicitlyBound: true,
      automaticCleanup: false,
    },
  };
}
