import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseArguments } from '../../scripts/qa-private-root-node-api-integration.mjs';
import { loadPrivateRootNodeApiReplacementIdentityDiagnostics } from '../../scripts/qa-private-root-node-api-provider.mjs';
import {
  REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES,
  runPrivateRootNodeApiReplacementIdentityDiagnostics,
  validateReplacementIdentityDiagnosticResult,
} from '../../scripts/qa-private-root-node-api-replacement-identity-diagnostics.mjs';

const ADDON = 'E:\\AIMuse\\test-results\\qa10-provider-fixture\\aimuse-qa-private-root-provider.node';
const ROOT = 'E:\\AIMuse\\test-results\\qa10-replacement-identity-diagnostics';
const IDENTITY = Object.freeze({ version: 1, canonicalPath: `${ROOT}\\replacement-identity-diagnostic-root`, device: '1', inode: '2' });
const EXECUTION_CWD = Object.freeze({
  path: `${ROOT}\\native-process-cwd`,
  runRoot: ROOT,
  identity: Object.freeze({ version: 1, canonicalPath: `${ROOT}\\native-process-cwd`, device: '1', inode: '3' }),
});

function diagnosticCase(profile) {
  return {
    id: profile.id,
    displacedOpenErrorCode: 0,
    stageOpenErrorCode: 0,
    renameErrorCode: 0,
    targetOpenWhileStageErrorCode: 0,
    targetOpenAfterStageCloseErrorCode: 0,
    targetExisted: profile.targetExisted,
    posixVisibilityRequested: profile.posixVisibilityRequested,
    stageShareZero: profile.stageShareZero,
    retainedTargetHandleRequested: profile.retainedTargetHandleRequested,
    displacedOpenAttempted: profile.targetExisted,
    displacedIdentityObserved: profile.targetExisted,
    retainedTargetHandleOpened: profile.retainedTargetHandleRequested,
    retainedTargetIdentityStable: profile.retainedTargetHandleRequested,
    retainedTargetBytesOriginalAfterRename: profile.retainedTargetHandleRequested,
    retainedTargetCloseSucceeded: true,
    stageOpenAttempted: true,
    stageOpened: true,
    bufferAligned: true,
    renameAttempted: true,
    renameSucceeded: true,
    stageIdentityStableBeforeClose: true,
    stageRegularBeforeClose: true,
    stageCloseAttempted: true,
    stageCloseSucceeded: true,
    targetOpenWhileStageAttempted: true,
    targetOpenedWhileStage: true,
    targetPathExactWhileStage: true,
    targetContainedWhileStage: true,
    targetRegularWhileStage: true,
    targetSecurityValidWhileStage: true,
    targetMatchesStageWhileStage: true,
    targetMatchesDisplacedWhileStage: false,
    targetOpenAfterStageCloseAttempted: true,
    targetOpenedAfterStageClose: true,
    targetPathExactAfterStageClose: true,
    targetContainedAfterStageClose: true,
    targetRegularAfterStageClose: true,
    targetSecurityValidAfterStageClose: true,
    targetMatchesStageAfterStageClose: true,
    targetMatchesDisplacedAfterStageClose: false,
    targetBindingChangedAfterStageClose: false,
    replacementBytesVisibleAfterStageClose: true,
    caseFilesystemInvariantPreserved: true,
  };
}

function diagnosticResult() {
  return {
    version: 1,
    matrixVersion: 1,
    cases: REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES.map(diagnosticCase),
  };
}

describe('QA-10 private-root replacement identity diagnostics', () => {
  it('loads only the explicit version 1 diagnostic surface', async () => {
    const nativeResult = diagnosticResult();
    const runReplacementIdentityDiagnostics = vi.fn(() => nativeResult);
    const access = vi.fn();
    const load = vi.fn(() => ({ providerVersion: 2, runReplacementIdentityDiagnostics }));
    const diagnostics = loadPrivateRootNodeApiReplacementIdentityDiagnostics(ADDON, { access, load });
    await expect(diagnostics.run({ version: 1 })).resolves.toBe(nativeResult);
    expect(diagnostics).toEqual({ version: 2, addonPath: ADDON, run: expect.any(Function) });
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(() => loadPrivateRootNodeApiReplacementIdentityDiagnostics(ADDON, {
      access: vi.fn(),
      load: () => ({ providerVersion: 2 }),
    })).toThrow('replacement identity diagnostic surface');
  });

  it('accepts only fixed IDs, Win32 codes and invariant booleans', () => {
    const validated = validateReplacementIdentityDiagnosticResult(diagnosticResult());
    expect(validated.cases.map((entry) => entry.id)).toEqual(REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES.map((entry) => entry.id));
    expect(() => validateReplacementIdentityDiagnosticResult({ ...diagnosticResult(), privateRoot: ROOT })).toThrow('unexpected public shape');
    const leaked = diagnosticResult();
    leaked.cases[0].fileId = '123';
    expect(() => validateReplacementIdentityDiagnosticResult(leaked)).toThrow('unexpected public shape');
    const inconsistent = diagnosticResult();
    inconsistent.cases[0].targetMatchesDisplacedWhileStage = true;
    expect(() => validateReplacementIdentityDiagnosticResult(inconsistent)).toThrow('identity classification');
  });

  it('protects and identity-binds one run-owned root without returning its private identity', async () => {
    const mkdir = vi.fn();
    const protectRoot = vi.fn();
    const assertRoot = vi.fn(async () => ({ identity: IDENTITY }));
    const assertExecutionCwd = vi.fn(async () => true);
    const run = vi.fn(async () => diagnosticResult());
    const loadDiagnostics = vi.fn(() => ({ run }));
    const result = await runPrivateRootNodeApiReplacementIdentityDiagnostics({ runRoot: ROOT, addonPath: ADDON, executionCwd: EXECUTION_CWD }, {
      mkdir,
      protectRoot,
      assertRoot,
      assertExecutionCwd,
      loadDiagnostics,
    });
    expect(mkdir).toHaveBeenCalledWith(`${ROOT}\\replacement-identity-diagnostic-root`);
    expect(protectRoot).toHaveBeenCalledWith(`${ROOT}\\replacement-identity-diagnostic-root`);
    expect(assertRoot).toHaveBeenCalledTimes(2);
    expect(assertRoot).toHaveBeenNthCalledWith(1, { privateRoot: `${ROOT}\\replacement-identity-diagnostic-root`, paths: [], evidenceRoot: ROOT });
    expect(assertExecutionCwd).toHaveBeenCalledWith(EXECUTION_CWD);
    expect(assertExecutionCwd.mock.invocationCallOrder[0]).toBeLessThan(loadDiagnostics.mock.invocationCallOrder[0]);
    expect(run).toHaveBeenCalledWith({
      version: 1,
      privateRoot: `${ROOT}\\replacement-identity-diagnostic-root`,
      expectedIdentity: IDENTITY,
    });
    expect(result).not.toHaveProperty('diagnosticRootIdentity');
    expect(result.boundaries).toEqual({
      applicationLaunches: 0,
      nativeHelperProcesses: 0,
      packageActions: 0,
      networkCalls: 0,
      credentialAccesses: 0,
      retainedRootAccesses: 0,
      mutationContainmentIndependentlyObserved: true,
      providerAuthorityExplicitlyBound: true,
      automaticCleanup: false,
    });
  });

  it('confines the five-case surface to absolute diagnostic-root targets without changing the historical explicit-parent diagnostic', async () => {
    expect(parseArguments(['--run-root', ROOT, '--node-api-root', 'C:\\headers', '--mode', 'replacement-identity-diagnostics'])).toEqual({
      run_root: ROOT,
      node_api_root: 'C:\\headers',
      mode: 'replacement-identity-diagnostics',
    });
    const [source, integration] = await Promise.all([
      readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-integration.mjs'), 'utf8'),
    ]);
    for (const profile of REPLACEMENT_IDENTITY_DIAGNOSTIC_CASES) expect(source).toContain(`"${profile.id}"`);
    const newDiagnostic = source.match(/napi_value RunReplacementIdentityDiagnostics[\s\S]*?\n}/)?.[0];
    expect(newDiagnostic).toContain('RunReplacementIdentityDiagnosticCase');
    const newCase = source.match(/ReplacementIdentityDiagnosticOutcome RunReplacementIdentityDiagnosticCase[\s\S]*?\n}/)?.[0];
    expect(newCase).toContain('AttemptRenameStage(stage.get(), nullptr, target_path');
    expect(newCase).not.toContain('AttemptRenameStage(stage.get(), nullptr, target_name');
    expect(newCase).toContain('ObserveReplacementDiagnosticTarget');
    expect(newCase).toContain('stage.reset()');
    expect(newCase).not.toMatch(/MoveFile|ReplaceFile|NtSetInformationFile|ZwSetInformationFile/);
    const historical = source.match(/RenameDiagnosticOutcome RunRenameDiagnosticCase[\s\S]*?\n}/)?.[0];
    expect(historical).toContain('AttemptRenameStage(stage.get(), parent.get(), target_name');
    expect(historical).toContain('RenameReplacementProfile::classic');
    expect(integration).toContain("mode === 'replacement-identity-diagnostics'");
    expect(integration).toContain('runPrivateRootNodeApiReplacementIdentityDiagnostics');
  });
});
