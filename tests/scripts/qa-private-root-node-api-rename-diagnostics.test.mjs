import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadPrivateRootNodeApiRenameDiagnostics } from '../../scripts/qa-private-root-node-api-provider.mjs';
import { parseArguments } from '../../scripts/qa-private-root-node-api-integration.mjs';
import {
  RENAME_DIAGNOSTIC_CASE_IDS,
  runPrivateRootNodeApiRenameDiagnostics,
  validateRenameDiagnosticResult,
} from '../../scripts/qa-private-root-node-api-rename-diagnostics.mjs';

const ADDON = 'E:\\AIMuse\\test-results\\qa10-provider-fixture\\aimuse-qa-private-root-provider.node';
const ROOT = 'E:\\AIMuse\\test-results\\qa10-rename-diagnostics';
const IDENTITY = Object.freeze({ version: 1, canonicalPath: `${ROOT}\\rename-diagnostic-root`, device: '1', inode: '2' });
const EXECUTION_CWD = Object.freeze({
  path: `${ROOT}\\native-process-cwd`,
  runRoot: ROOT,
  identity: Object.freeze({ version: 1, canonicalPath: `${ROOT}\\native-process-cwd`, device: '1', inode: '3' }),
});

function diagnosticCase(id) {
  return {
    id,
    outcome: 'win32-error',
    phase: 'rename',
    errorCode: 87,
    targetExisted: !id.includes('-absent-'),
    parentAccessProfile: id.includes('add-file') ? 'add-file' : id.includes('delete-child') ? 'delete-child' : id.includes('full-parent') ? 'full-rename' : 'baseline-read',
    parentOpenReparsePoint: !id.includes('no-reparse'),
    informationClass: id.startsWith('legacy') ? 'legacy' : 'extended',
    bufferProfile: id.includes('exact') ? 'exact-tail' : 'padded-structure',
    stageProfile: id.includes('basic-stage') ? 'basic' : 'current',
    bufferAligned: true,
    targetInvariantPreserved: true,
    stageAbsentAfterFailure: true,
    committedIdentityVerified: false,
  };
}

function diagnosticResult() {
  return {
    version: 1,
    matrixVersion: 1,
    structure: { fileRenameInfoSize: 24, fileNameOffset: 20, alignment: 8, wideCharacterBytes: 2 },
    filesystem: { name: 'NTFS', maximumComponentLength: 255, flags: 0x0004_0000 },
    cases: RENAME_DIAGNOSTIC_CASE_IDS.map(diagnosticCase),
  };
}

describe('QA-10 private-root Node-API rename diagnostics', () => {
  it('loads only the explicit version 1 diagnostic surface and returns acknowledgment data', async () => {
    const nativeResult = diagnosticResult();
    const runRenameDiagnostics = vi.fn(() => nativeResult);
    const access = vi.fn();
    const load = vi.fn(() => ({ providerVersion: 2, runRenameDiagnostics }));
    const diagnostics = loadPrivateRootNodeApiRenameDiagnostics(ADDON, { access, load });
    await expect(diagnostics.run({ version: 1 })).resolves.toBe(nativeResult);
    expect(diagnostics).toEqual({ version: 2, addonPath: ADDON, run: expect.any(Function) });
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(access).toHaveBeenCalledWith(ADDON);
    expect(load).toHaveBeenCalledWith(ADDON);
    expect(() => loadPrivateRootNodeApiRenameDiagnostics(ADDON, { access: vi.fn(), load: () => ({ providerVersion: 2 }) })).toThrow('diagnostic surface');
  });

  it('accepts only the exact sanitized matrix and rejects private or inconsistent evidence', () => {
    expect(validateRenameDiagnosticResult(diagnosticResult()).cases.map((entry) => entry.id)).toEqual(RENAME_DIAGNOSTIC_CASE_IDS);
    expect(() => validateRenameDiagnosticResult({ ...diagnosticResult(), privateRoot: ROOT })).toThrow('unexpected public shape');
    const changed = diagnosticResult();
    changed.cases[0].targetInvariantPreserved = false;
    expect(() => validateRenameDiagnosticResult(changed)).toThrow('target/stage invariant');
  });

  it('protects and identity-binds one run-owned diagnostic root around the native matrix', async () => {
    const mkdir = vi.fn();
    const protectRoot = vi.fn();
    const assertRoot = vi.fn(async () => ({ identity: IDENTITY }));
    const assertExecutionCwd = vi.fn(async () => true);
    const run = vi.fn(async () => diagnosticResult());
    const loadDiagnostics = vi.fn(() => ({ run }));
    const result = await runPrivateRootNodeApiRenameDiagnostics({ runRoot: ROOT, addonPath: ADDON, executionCwd: EXECUTION_CWD }, {
      mkdir,
      protectRoot,
      assertRoot,
      assertExecutionCwd,
      loadDiagnostics,
      platform: 'win32',
      architecture: 'x64',
      release: '10.0.test',
    });
    expect(mkdir).toHaveBeenCalledWith(`${ROOT}\\rename-diagnostic-root`);
    expect(protectRoot).toHaveBeenCalledWith(`${ROOT}\\rename-diagnostic-root`);
    expect(assertRoot).toHaveBeenCalledTimes(2);
    expect(assertRoot).toHaveBeenNthCalledWith(1, { privateRoot: `${ROOT}\\rename-diagnostic-root`, paths: [], evidenceRoot: ROOT });
    expect(assertExecutionCwd).toHaveBeenCalledWith(EXECUTION_CWD);
    expect(assertExecutionCwd.mock.invocationCallOrder[0]).toBeLessThan(loadDiagnostics.mock.invocationCallOrder[0]);
    expect(run).toHaveBeenCalledWith({ version: 1, privateRoot: `${ROOT}\\rename-diagnostic-root`, expectedIdentity: IDENTITY });
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

  it('freezes an explicit mode and a documented, path-fallback-free native matrix', async () => {
    expect(parseArguments(['--run-root', ROOT, '--node-api-root', 'C:\\headers', '--mode', 'rename-diagnostics'])).toEqual({
      run_root: ROOT,
      node_api_root: 'C:\\headers',
      mode: 'rename-diagnostics',
    });
    const [source, integration] = await Promise.all([
      readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-integration.mjs'), 'utf8'),
    ]);
    for (const id of RENAME_DIAGNOSTIC_CASE_IDS) expect(source).toContain(`"${id}"`);
    for (const symbol of ['GetVolumeInformationByHandleW', 'FILE_ADD_FILE', 'FILE_DELETE_CHILD', 'GENERIC_READ', 'GENERIC_WRITE', 'GENERIC_EXECUTE', 'DELETE', 'FileRenameInfoEx', 'FileRenameInfo']) {
      expect(source).toContain(symbol);
    }
    expect(source).not.toMatch(/MoveFile|ReplaceFile|NtSetInformationFile|ZwSetInformationFile/);
    expect(integration).toContain("mode === 'rename-diagnostics'");
    expect(integration).toContain('runPrivateRootNodeApiRenameDiagnostics');
  });
});
