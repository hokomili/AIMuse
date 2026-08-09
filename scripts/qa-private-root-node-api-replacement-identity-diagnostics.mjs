import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { protectOwnerPrivateRoot } from './qa-private-root.mjs';
import { loadPrivateRootNodeApiReplacementIdentityDiagnostics } from './qa-private-root-node-api-provider.mjs';
import { assertNativeExecutionCwd } from './qa-private-root-node-api-execution-cwd.mjs';
import { createProviderCheckpointAuthority } from './qa-private-root-node-api-authority.mjs';

export const REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES = Object.freeze([
  Object.freeze({ id: 'existing-classic-share-zero', targetExisted: true, posixVisibilityRequested: false, stageShareZero: true, retainedTargetHandleRequested: false }),
  Object.freeze({ id: 'existing-posix-share-zero', targetExisted: true, posixVisibilityRequested: true, stageShareZero: true, retainedTargetHandleRequested: false }),
  Object.freeze({ id: 'absent-posix-share-zero', targetExisted: false, posixVisibilityRequested: true, stageShareZero: true, retainedTargetHandleRequested: false }),
  Object.freeze({ id: 'existing-posix-shared-stage', targetExisted: true, posixVisibilityRequested: true, stageShareZero: false, retainedTargetHandleRequested: false }),
  Object.freeze({ id: 'existing-posix-share-zero-retained-target', targetExisted: true, posixVisibilityRequested: true, stageShareZero: true, retainedTargetHandleRequested: true }),
]);

const CODE_FIELDS = Object.freeze([
  'displacedOpenErrorCode',
  'stageOpenErrorCode',
  'renameErrorCode',
  'targetOpenWhileStageErrorCode',
  'targetOpenAfterStageCloseErrorCode',
]);

const BOOLEAN_FIELDS = Object.freeze([
  'targetExisted',
  'posixVisibilityRequested',
  'stageShareZero',
  'retainedTargetHandleRequested',
  'displacedOpenAttempted',
  'displacedIdentityObserved',
  'retainedTargetHandleOpened',
  'retainedTargetIdentityStable',
  'retainedTargetBytesOriginalAfterRename',
  'retainedTargetCloseSucceeded',
  'stageOpenAttempted',
  'stageOpened',
  'bufferAligned',
  'renameAttempted',
  'renameSucceeded',
  'stageIdentityStableBeforeClose',
  'stageRegularBeforeClose',
  'stageCloseAttempted',
  'stageCloseSucceeded',
  'targetOpenWhileStageAttempted',
  'targetOpenedWhileStage',
  'targetPathExactWhileStage',
  'targetContainedWhileStage',
  'targetRegularWhileStage',
  'targetSecurityValidWhileStage',
  'targetMatchesStageWhileStage',
  'targetMatchesDisplacedWhileStage',
  'targetOpenAfterStageCloseAttempted',
  'targetOpenedAfterStageClose',
  'targetPathExactAfterStageClose',
  'targetContainedAfterStageClose',
  'targetRegularAfterStageClose',
  'targetSecurityValidAfterStageClose',
  'targetMatchesStageAfterStageClose',
  'targetMatchesDisplacedAfterStageClose',
  'targetBindingChangedAfterStageClose',
  'replacementBytesVisibleAfterStageClose',
  'caseFilesystemInvariantPreserved',
]);

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has an unexpected public shape.`);
}

function requireUint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${label} must be one unsigned 32-bit integer.`);
  return value;
}

function openedExactlyWhenAttemptSucceeded(attempted, opened, errorCode) {
  return opened === (attempted && errorCode === 0);
}

export function validateReplacementIdentityDiagnosticResult(value) {
  requireExactKeys(value, ['version', 'matrixVersion', 'cases'], 'Replacement identity diagnostic result');
  if (value.version !== 1 || value.matrixVersion !== 1) throw new Error('Replacement identity diagnostic result must use matrix version 1.');
  if (!Array.isArray(value.cases) || value.cases.length !== REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES.length) {
    throw new Error('Replacement identity diagnostic result does not contain the exact bounded case matrix.');
  }
  const cases = value.cases.map((entry, index) => {
    requireExactKeys(entry, ['id', ...CODE_FIELDS, ...BOOLEAN_FIELDS], `Replacement identity diagnostic case ${index + 1}`);
    const expected = REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES[index];
    if (entry.id !== expected.id) throw new Error(`Replacement identity diagnostic case ${index + 1} has the wrong fixed identity.`);
    for (const field of CODE_FIELDS) requireUint32(entry[field], `Replacement identity diagnostic case ${entry.id} ${field}`);
    for (const field of BOOLEAN_FIELDS) {
      if (typeof entry[field] !== 'boolean') throw new Error(`Replacement identity diagnostic case ${entry.id} has a non-boolean ${field}.`);
    }
    for (const field of ['targetExisted', 'posixVisibilityRequested', 'stageShareZero', 'retainedTargetHandleRequested']) {
      if (entry[field] !== expected[field]) throw new Error(`Replacement identity diagnostic case ${entry.id} changed its fixed ${field} profile.`);
    }
    if (entry.displacedOpenAttempted !== entry.targetExisted ||
        entry.displacedIdentityObserved !== (entry.displacedOpenAttempted && entry.displacedOpenErrorCode === 0)) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent displaced-object observation.`);
    }
    if (entry.retainedTargetHandleOpened && (!entry.retainedTargetHandleRequested || !entry.displacedIdentityObserved)) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent retained-target state.`);
    }
    if (!openedExactlyWhenAttemptSucceeded(entry.stageOpenAttempted, entry.stageOpened, entry.stageOpenErrorCode) ||
        entry.renameAttempted !== entry.stageOpened ||
        entry.renameSucceeded !== (entry.renameAttempted && entry.renameErrorCode === 0) ||
        entry.stageCloseAttempted !== entry.stageOpened ||
        (entry.stageCloseSucceeded && !entry.stageCloseAttempted)) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent stage/rename lifecycle.`);
    }
    if (entry.targetOpenWhileStageAttempted !== entry.renameSucceeded ||
        !openedExactlyWhenAttemptSucceeded(entry.targetOpenWhileStageAttempted, entry.targetOpenedWhileStage, entry.targetOpenWhileStageErrorCode) ||
        entry.targetOpenAfterStageCloseAttempted !== entry.stageCloseAttempted ||
        !openedExactlyWhenAttemptSucceeded(entry.targetOpenAfterStageCloseAttempted, entry.targetOpenedAfterStageClose,
          entry.targetOpenAfterStageCloseErrorCode)) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent target-open lifecycle.`);
    }
    if ((entry.targetMatchesStageWhileStage && entry.targetMatchesDisplacedWhileStage) ||
        (entry.targetMatchesStageAfterStageClose && entry.targetMatchesDisplacedAfterStageClose) ||
        (!entry.targetExisted && (entry.targetMatchesDisplacedWhileStage || entry.targetMatchesDisplacedAfterStageClose)) ||
        (entry.targetBindingChangedAfterStageClose && (!entry.targetOpenedWhileStage || !entry.targetOpenedAfterStageClose))) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent identity classification.`);
    }
    if (entry.replacementBytesVisibleAfterStageClose && (!entry.renameSucceeded || !entry.targetOpenedAfterStageClose) ||
        entry.retainedTargetBytesOriginalAfterRename && (!entry.renameSucceeded || !entry.retainedTargetHandleOpened)) {
      throw new Error(`Replacement identity diagnostic case ${entry.id} has inconsistent byte-invariant evidence.`);
    }
    return Object.freeze({ ...entry });
  });
  return Object.freeze({ version: 1, matrixVersion: 1, cases: Object.freeze(cases) });
}

export async function runPrivateRootNodeApiReplacementIdentityDiagnostics({ runRoot, addonPath, executionCwd }, dependencies = {}) {
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const protect = dependencies.protectRoot ?? protectOwnerPrivateRoot;
  const assertExecutionCwd = dependencies.assertExecutionCwd ?? assertNativeExecutionCwd;
  const loadDiagnostics = dependencies.loadDiagnostics ?? loadPrivateRootNodeApiReplacementIdentityDiagnostics;
  const authority = createProviderCheckpointAuthority(runRoot, { assertRoot: dependencies.assertRoot });
  const diagnosticRoot = join(runRoot, 'replacement-identity-diagnostic-root');
  await makeDirectory(diagnosticRoot);
  await protect(diagnosticRoot);
  const before = await authority.assertPrivateRoot({ privateRoot: diagnosticRoot, paths: [] });
  await assertExecutionCwd(executionCwd);
  const diagnostics = loadDiagnostics(addonPath);
  const result = validateReplacementIdentityDiagnosticResult(await diagnostics.run({
    version: 1,
    privateRoot: diagnosticRoot,
    expectedIdentity: before.identity,
  }));
  const after = await authority.assertPrivateRoot({ privateRoot: diagnosticRoot, paths: [] });
  if (JSON.stringify(after.identity) !== JSON.stringify(before.identity)) {
    throw new Error('Replacement identity diagnostic root identity changed across the native matrix.');
  }
  return {
    ...result,
    boundaries: {
      applicationLaunches: 0,
      nativeHelperProcesses: 0,
      packageActions: 0,
      networkCalls: 0,
      credentialAccesses: 0,
      retainedRootAccesses: 0,
      mutationContainmentIndependentlyObserved: true,
      providerAuthorityExplicitlyBound: true,
      automaticCleanup: false,
    },
  };
}
