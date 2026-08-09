import { mkdir } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { protectOwnerPrivateRoot } from './qa-private-root.mjs';
import { loadPrivateRootNodeApiRenameDiagnostics } from './qa-private-root-node-api-provider.mjs';
import { assertNativeExecutionCwd } from './qa-private-root-node-api-execution-cwd.mjs';
import { createProviderCheckpointAuthority } from './qa-private-root-node-api-authority.mjs';

export const RENAME_DIAGNOSTIC_CASE_IDS = Object.freeze([
  'extended-baseline-existing-padded',
  'extended-baseline-absent-padded',
  'extended-baseline-existing-exact',
  'extended-add-file-absent-padded',
  'extended-delete-child-existing-padded',
  'extended-full-parent-existing-padded',
  'extended-full-parent-no-reparse-existing-padded',
  'extended-full-parent-no-reparse-existing-exact',
  'legacy-full-parent-no-reparse-existing-exact',
  'extended-full-parent-no-reparse-basic-stage',
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

export function validateRenameDiagnosticResult(value) {
  requireExactKeys(value, ['version', 'matrixVersion', 'structure', 'filesystem', 'cases'], 'Rename diagnostic result');
  if (value.version !== 1 || value.matrixVersion !== 1) throw new Error('Rename diagnostic result must use matrix version 1.');
  requireExactKeys(value.structure, ['fileRenameInfoSize', 'fileNameOffset', 'alignment', 'wideCharacterBytes'], 'Rename structure evidence');
  const structure = {
    fileRenameInfoSize: requireUint32(value.structure.fileRenameInfoSize, 'FILE_RENAME_INFO size'),
    fileNameOffset: requireUint32(value.structure.fileNameOffset, 'FILE_RENAME_INFO FileName offset'),
    alignment: requireUint32(value.structure.alignment, 'FILE_RENAME_INFO alignment'),
    wideCharacterBytes: requireUint32(value.structure.wideCharacterBytes, 'Wide-character size'),
  };
  if (structure.fileRenameInfoSize < structure.fileNameOffset + structure.wideCharacterBytes || structure.alignment === 0 ||
      (structure.alignment & (structure.alignment - 1)) !== 0 || structure.wideCharacterBytes !== 2) {
    throw new Error('Rename structure evidence is internally inconsistent for documented Windows UTF-16 layout.');
  }

  requireExactKeys(value.filesystem, ['name', 'maximumComponentLength', 'flags'], 'Rename filesystem evidence');
  if (typeof value.filesystem.name !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(value.filesystem.name)) {
    throw new Error('Rename filesystem evidence has an unsafe or missing name.');
  }
  const filesystem = {
    name: value.filesystem.name,
    maximumComponentLength: requireUint32(value.filesystem.maximumComponentLength, 'Filesystem maximum component length'),
    flags: requireUint32(value.filesystem.flags, 'Filesystem flags'),
  };
  if (filesystem.maximumComponentLength === 0) throw new Error('Rename filesystem evidence reports no valid component length.');

  if (!Array.isArray(value.cases) || value.cases.length !== RENAME_DIAGNOSTIC_CASE_IDS.length) {
    throw new Error('Rename diagnostic result does not contain the exact bounded case matrix.');
  }
  const cases = value.cases.map((entry, index) => {
    requireExactKeys(entry, [
      'id', 'outcome', 'phase', 'errorCode', 'targetExisted', 'parentAccessProfile', 'parentOpenReparsePoint',
      'informationClass', 'bufferProfile', 'stageProfile', 'bufferAligned', 'targetInvariantPreserved',
      'stageAbsentAfterFailure', 'committedIdentityVerified',
    ], `Rename diagnostic case ${index + 1}`);
    if (entry.id !== RENAME_DIAGNOSTIC_CASE_IDS[index]) throw new Error(`Rename diagnostic case ${index + 1} has the wrong fixed identity.`);
    if (!['renamed', 'win32-error'].includes(entry.outcome) || !['rename', 'parent-open'].includes(entry.phase)) {
      throw new Error(`Rename diagnostic case ${entry.id} has an invalid outcome or phase.`);
    }
    if (!['baseline-read', 'add-file', 'delete-child', 'full-rename'].includes(entry.parentAccessProfile) ||
        !['extended', 'legacy'].includes(entry.informationClass) || !['exact-tail', 'padded-structure'].includes(entry.bufferProfile) ||
        !['current', 'basic'].includes(entry.stageProfile)) {
      throw new Error(`Rename diagnostic case ${entry.id} has an invalid declared contract profile.`);
    }
    for (const field of ['targetExisted', 'parentOpenReparsePoint', 'bufferAligned', 'targetInvariantPreserved', 'stageAbsentAfterFailure', 'committedIdentityVerified']) {
      if (typeof entry[field] !== 'boolean') throw new Error(`Rename diagnostic case ${entry.id} has a non-boolean ${field}.`);
    }
    const errorCode = requireUint32(entry.errorCode, `Rename diagnostic case ${entry.id} error code`);
    if (!entry.targetInvariantPreserved || !entry.stageAbsentAfterFailure) {
      throw new Error(`Rename diagnostic case ${entry.id} did not preserve its target/stage invariant.`);
    }
    if (entry.outcome === 'renamed' && (errorCode !== 0 || !entry.bufferAligned || !entry.committedIdentityVerified)) {
      throw new Error(`Rename diagnostic case ${entry.id} reports an inconsistent successful commit.`);
    }
    if (entry.outcome === 'win32-error' && (errorCode === 0 || entry.committedIdentityVerified || (entry.phase === 'rename' && !entry.bufferAligned))) {
      throw new Error(`Rename diagnostic case ${entry.id} reports an inconsistent documented failure.`);
    }
    return Object.freeze({ ...entry, errorCode });
  });
  return Object.freeze({ version: 1, matrixVersion: 1, structure: Object.freeze(structure), filesystem: Object.freeze(filesystem), cases: Object.freeze(cases) });
}

export async function runPrivateRootNodeApiRenameDiagnostics({ runRoot, addonPath, executionCwd }, dependencies = {}) {
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const protect = dependencies.protectRoot ?? protectOwnerPrivateRoot;
  const assertExecutionCwd = dependencies.assertExecutionCwd ?? assertNativeExecutionCwd;
  const loadDiagnostics = dependencies.loadDiagnostics ?? loadPrivateRootNodeApiRenameDiagnostics;
  const authority = createProviderCheckpointAuthority(runRoot, { assertRoot: dependencies.assertRoot });
  const diagnosticRoot = join(runRoot, 'rename-diagnostic-root');
  await makeDirectory(diagnosticRoot);
  await protect(diagnosticRoot);
  const before = await authority.assertPrivateRoot({ privateRoot: diagnosticRoot, paths: [] });
  await assertExecutionCwd(executionCwd);
  const diagnostics = loadDiagnostics(addonPath);
  const result = validateRenameDiagnosticResult(await diagnostics.run({
    version: 1,
    privateRoot: diagnosticRoot,
    expectedIdentity: before.identity,
  }));
  const after = await authority.assertPrivateRoot({ privateRoot: diagnosticRoot, paths: [] });
  if (JSON.stringify(after.identity) !== JSON.stringify(before.identity)) throw new Error('Rename diagnostic root identity changed across the native matrix.');
  return {
    ...result,
    system: {
      platform: dependencies.platform ?? process.platform,
      architecture: dependencies.architecture ?? arch(),
      release: dependencies.release ?? release(),
    },
    diagnosticRootIdentity: before.identity,
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
