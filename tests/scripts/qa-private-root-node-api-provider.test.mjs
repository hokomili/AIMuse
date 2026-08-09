import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { loadPrivateRootNodeApiProvider } from '../../scripts/qa-private-root-node-api-provider.mjs';
import { assertDirectChild, parseArguments } from '../../scripts/qa-private-root-node-api-integration.mjs';
import { createProviderCheckpointAuthority } from '../../scripts/qa-private-root-node-api-authority.mjs';
import {
  normalizeProviderNativeFailureEvidence,
  restoreNegativeAclFixture,
  runNativeAuthorityPhase,
  runNativeSnapshotPhase,
} from '../../scripts/qa-private-root-node-api-native-cases.mjs';

const ADDON = 'E:\\AIMuse\\test-results\\qa10-provider-fixture\\aimuse-qa-private-root-provider.node';

describe('QA-10 private-root Node-API provider boundary', () => {
  it('loads only an explicit absolute safe version 2 addon and adapts its acquisition result', async () => {
    const lease = { descriptor: { version: 1 } };
    const acquireLease = vi.fn(() => lease);
    const access = vi.fn();
    const load = vi.fn(() => ({ providerVersion: 2, acquireLease }));
    const provider = loadPrivateRootNodeApiProvider(ADDON, { access, load });
    const options = { version: 1, privateRoot: 'E:\\fixture' };
    await expect(provider.acquireLease(options)).resolves.toBe(lease);
    expect(provider).toEqual({ version: 2, addonPath: ADDON, acquireLease: expect.any(Function) });
    expect(Object.isFrozen(provider)).toBe(true);
    expect(access).toHaveBeenCalledWith(ADDON);
    expect(load).toHaveBeenCalledWith(ADDON);
    expect(acquireLease).toHaveBeenCalledWith(options);
  });

  it('rejects relative, missing-version, and missing-acquisition surfaces', () => {
    expect(() => loadPrivateRootNodeApiProvider('relative.node', { access: vi.fn(), load: vi.fn() })).toThrow('must be absolute');
    expect(() => loadPrivateRootNodeApiProvider(ADDON, { access: vi.fn(), load: () => ({ providerVersion: 1, acquireLease() {} }) })).toThrow('safe version 2');
    expect(() => loadPrivateRootNodeApiProvider(ADDON, { access: vi.fn(), load: () => ({ providerVersion: 2 }) })).toThrow('safe version 2');
  });

  it('keeps the addon opt-in and outside normal runtime staging', async () => {
    const cmake = await readFile(resolve('native/CMakeLists.txt'), 'utf8');
    const build = await readFile(resolve('scripts/native-build.mjs'), 'utf8');
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    expect(cmake).toContain('option(AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER');
    expect(cmake).toContain('if(AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER)');
    expect(build).not.toContain('aimuse-qa-private-root-provider');
    expect(packageJson.scripts['qa:windows-private-root-node-api']).toBe('node scripts/qa-private-root-node-api-integration.mjs');
  });

  it('pins module and runtime artifacts to one exact configuration-independent build-root path', async () => {
    const [cmake, integration] = await Promise.all([
      readFile(resolve('native/CMakeLists.txt'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-integration.mjs'), 'utf8'),
    ]);
    expect(cmake).toContain('LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"');
    expect(cmake).toContain('RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"');
    expect(cmake).toContain('"LIBRARY_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}"');
    expect(cmake).toContain('"RUNTIME_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}"');
    expect(integration).toContain("const addonPath = join(buildRoot, 'aimuse-qa-private-root-provider.node');");
    expect(integration).not.toMatch(/glob|readdir|RelWithDebInfo.*aimuse-qa-private-root-provider\.node/);
  });

  it('freezes one verified-absent direct-child run-root command surface', () => {
    expect(parseArguments(['--run-root', 'E:\\AIMuse\\test-results\\qa10-provider', '--node-api-root', 'C:\\headers'])).toEqual({
      run_root: 'E:\\AIMuse\\test-results\\qa10-provider',
      node_api_root: 'C:\\headers',
    });
    expect(assertDirectChild('E:\\AIMuse\\test-results\\qa10-provider', 'Run root')).toBe('E:\\AIMuse\\test-results\\qa10-provider');
    expect(() => assertDirectChild('E:\\AIMuse\\test-results', 'Run root')).toThrow('exact direct child');
    expect(() => assertDirectChild('E:\\AIMuse\\test-results\\nested\\qa10-provider', 'Run root')).toThrow('exact direct child');
  });

  it('binds provider verification to the explicit run root regardless of ambient CWD', async () => {
    const runRoot = 'E:\\AIMuse\\test-results\\qa10-provider';
    const privateRoot = `${runRoot}\\protected-root`;
    const paths = [`${privateRoot}\\connection.json`];
    const assertRoot = vi.fn(async (options) => ({ root: options.privateRoot }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('D:\\foreign-ambient-cwd');
    try {
      const authority = createProviderCheckpointAuthority(runRoot, { platform: 'win32', assertRoot });
      await expect(authority.assertPrivateRoot({ privateRoot, paths })).resolves.toEqual({ root: privateRoot });
      expect(authority.runRoot).toBe(runRoot);
      expect(assertRoot).toHaveBeenCalledWith({ privateRoot, paths, evidenceRoot: runRoot });
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects relative inputs and any attempt to broaden the bound provider run root', async () => {
    const runRoot = 'E:\\AIMuse\\test-results\\qa10-provider';
    expect(() => createProviderCheckpointAuthority('relative-run-root')).toThrow('explicit absolute run root');
    const assertRoot = vi.fn();
    const authority = createProviderCheckpointAuthority(runRoot, { platform: 'win32', assertRoot });
    await expect(authority.assertPrivateRoot({ privateRoot: 'relative-private-root', paths: [] }))
      .rejects.toThrow('explicit absolute root and paths');
    await expect(authority.assertPrivateRoot({
      privateRoot: `${runRoot}\\protected-root`,
      paths: ['relative-connection.json'],
    })).rejects.toThrow('explicit absolute root and paths');
    await expect(authority.assertPrivateRoot({
      privateRoot: `${runRoot}\\protected-root`,
      paths: [],
      evidenceRoot: 'E:\\AIMuse\\test-results',
    })).rejects.toThrow('cannot be overridden or broadened');
    expect(assertRoot).not.toHaveBeenCalled();
  });

  it('retains only fixed lifecycle and Win32-code evidence for a snapshot sharing failure', () => {
    let error;
    try {
      runNativeSnapshotPhase('rotation-during-external-replace', () => {
        throw new Error('CreateFileW(snapshot) failed with Windows error 32.');
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: 'Native snapshot phase rotation-during-external-replace failed with Windows error 32.',
      providerNativeFailureEvidence: {
        version: 1,
        kind: 'snapshot-open',
        phase: 'rotation-during-external-replace',
        win32Code: 32,
        providerAuthorityExplicitlyBound: true,
        sharedLeasePreflightCompleted: true,
        providerLeaseAcquired: true,
        providerAtomicReplaceCompleted: true,
        concurrentReplacementWorkerActive: true,
      },
    });
    expect(JSON.stringify(error.providerNativeFailureEvidence)).not.toMatch(/[A-Z]:\\|connection|token|handle|fileId/i);
    expect(normalizeProviderNativeFailureEvidence(error.providerNativeFailureEvidence))
      .toEqual(error.providerNativeFailureEvidence);
    expect(() => runNativeSnapshotPhase('unknown-phase', vi.fn())).toThrow('fixed phase');
    expect(() => normalizeProviderNativeFailureEvidence({
      ...error.providerNativeFailureEvidence,
      concurrentReplacementWorkerActive: false,
    })).toThrow('contradicts');

    const unrelated = new Error('mock non-snapshot failure');
    expect(() => runNativeSnapshotPhase('rotation-before-provider-commit', () => { throw unrelated; })).toThrow(unrelated);
  });

  it('retains only a fixed phase and boolean for a JS authority ACL failure', async () => {
    const underlying = new Error('Private path grants an unexpected principal: S-1-5-32-545.');
    let error;
    try {
      await runNativeAuthorityPhase('primary-final-observation', async () => { throw underlying; });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: 'Native authority phase primary-final-observation rejected an unexpected principal.',
      providerNativeFailureEvidence: {
        version: 1,
        kind: 'js-authority-acl',
        phase: 'primary-final-observation',
        providerAuthorityExplicitlyBound: true,
        unexpectedPrincipalDetected: true,
      },
    });
    expect(JSON.stringify(error.providerNativeFailureEvidence)).not.toMatch(/S-1-|[A-Z]:\\|connection|token|handle|fileId/i);
    expect(normalizeProviderNativeFailureEvidence(error.providerNativeFailureEvidence))
      .toEqual(error.providerNativeFailureEvidence);
    await expect(runNativeAuthorityPhase('unknown-phase', vi.fn())).rejects.toThrow('fixed phase');
    expect(() => normalizeProviderNativeFailureEvidence({
      ...error.providerNativeFailureEvidence,
      phase: 'unfixed-phase',
    })).toThrow('fixed authority matrix');
    const unrelated = new Error('mock non-authority failure');
    await expect(runNativeAuthorityPhase('sticky-acl-restoration', async () => { throw unrelated; })).rejects.toThrow(unrelated);
  });

  it('removes a propagated broad grant before reprotection and exact-object authority revalidation', async () => {
    const root = 'E:\\AIMuse\\test-results\\run-owned\\acl-drift-root';
    const paths = [`${root}\\connection.json`];
    const identity = { canonicalPath: root, device: '7', inode: '11' };
    const order = [];
    const removeBroadRead = vi.fn(() => order.push('remove'));
    const protectOwnerPrivateRoot = vi.fn(async () => order.push('protect'));
    const assertPrivateRoot = vi.fn(async () => {
      order.push('revalidate');
      return { identity, inspectedPaths: 2 };
    });
    await expect(restoreNegativeAclFixture({
      authority: { assertPrivateRoot }, root, paths, expectedIdentity: identity, phase: 'sticky-acl-restoration',
    }, { removeBroadRead, protectOwnerPrivateRoot })).resolves.toMatchObject({ identity, inspectedPaths: 2 });
    expect(order).toEqual(['remove', 'protect', 'revalidate']);
    expect(removeBroadRead).toHaveBeenCalledWith(root);
    expect(protectOwnerPrivateRoot).toHaveBeenCalledWith(root);
    expect(assertPrivateRoot).toHaveBeenCalledWith({ privateRoot: root, paths });

    assertPrivateRoot.mockRejectedValueOnce(new Error('Private path grants an unexpected principal: S-1-5-32-545.'));
    await expect(restoreNegativeAclFixture({
      authority: { assertPrivateRoot }, root, paths, expectedIdentity: identity, phase: 'sticky-acl-restoration',
    }, { removeBroadRead, protectOwnerPrivateRoot })).rejects.toMatchObject({
      message: 'Native authority phase sticky-acl-restoration rejected an unexpected principal.',
      providerNativeFailureEvidence: { kind: 'js-authority-acl', phase: 'sticky-acl-restoration' },
    });
  });

  it('uses documented Win32 handle primitives and no NT or PowerShell substitute', async () => {
    const source = await readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8');
    for (const symbol of ['CreateFileW', 'GetFinalPathNameByHandleW', 'GetSecurityInfo', 'GetFileInformationByHandle', 'GetFileInformationByHandleEx', 'SetFileInformationByHandle']) {
      expect(source).toContain(symbol);
    }
    for (const forbidden of ['NtCreateFile', 'NtSetInformationFile', 'ZwCreateFile', 'PowerShell', 'powershell.exe']) expect(source).not.toContain(forbidden);
  });

  it('binds atomic commit to the documented absolute destination under the pinned parent', async () => {
    const source = await readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8');
    const attempt = source.match(/DWORD AttemptRenameStage[\s\S]*?\n}/)?.[0];
    expect(attempt).toContain('offsetof(FILE_RENAME_INFO, FileName)');
    expect(attempt).toContain('sizeof(FILE_RENAME_INFO)');
    expect(attempt).toContain('rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS;');
    expect(attempt).toContain('rename->Flags |= FILE_RENAME_FLAG_POSIX_SEMANTICS;');
    expect(attempt).toContain('replacement_profile != RenameReplacementProfile::classic');
    expect(attempt).toContain('rename->ReplaceIfExists = TRUE;');
    expect(attempt).toContain('rename->RootDirectory = root_directory;');
    expect(attempt).toContain('rename->FileNameLength = static_cast<DWORD>(file_name_bytes);');
    expect(attempt).toContain('std::memcpy(rename->FileName, destination.data(), file_name_bytes);');
    expect(attempt).toContain('SetFileInformationByHandle(stage, information_class');
    expect(attempt).not.toMatch(/MoveFile|ReplaceFile|NtSetInformationFile|ZwSetInformationFile/);

    const productionRename = source.match(/void RenameStageToPinnedAbsoluteTarget[\s\S]*?\n}/)?.[0];
    expect(productionRename).toContain('IsFullyQualifiedWin32Path(absolute_target_path)');
    expect(productionRename).toContain('AttemptRenameStage(stage, nullptr, absolute_target_path');
    expect(productionRename).toContain('null-root relative name against the process current');
    expect(productionRename).toContain('RenameInformationProfile::extended');
    expect(productionRename).toContain('RenameBufferProfile::padded_structure');
    expect(productionRename).toContain('RenameReplacementProfile::subsequent_opens_bind_renamed_file');
    expect(productionRename).toContain('FileRenameInfoEx pinned absolute replacement');
    expect(productionRename).not.toMatch(/MoveFile|ReplaceFile|NtSetInformationFile|ZwSetInformationFile/);

    const targetBuilder = source.match(/std::wstring PinnedAbsoluteTargetPath[\s\S]*?\n}/)?.[0];
    expect(targetBuilder).toContain('IsFullyQualifiedWin32Path(allowed.path)');
    expect(targetBuilder).toContain('WithinRoot(state.root_path, allowed.path)');
    expect(targetBuilder).toContain('SamePath(ParentPath(allowed.path), parent.path)');
    expect(targetBuilder).toContain('SamePath(parent.identity.final_path, parent.path)');
    expect(targetBuilder).toContain("parent.path + L'\\\\' + BaseName(allowed.path)");
    expect(targetBuilder).toContain('SamePath(reconstructed, allowed.path)');

    const atomicReplace = source.match(/napi_value AtomicReplace[\s\S]*?\n}/)?.[0];
    expect(atomicReplace).toContain('const std::wstring absolute_target_path = PinnedAbsoluteTargetPath(allowed, parent, *state);');
    expect(atomicReplace).toContain('SamePath(initial_stage.final_path, stage_path)');
    expect(atomicReplace).toContain('RenameStageToPinnedAbsoluteTarget(stage.get(), absolute_target_path);');
    expect(atomicReplace).toContain('ValidateCommittedTarget(stage.get(), initial_stage, allowed, *state, bytes);');
    expect(atomicReplace?.split('renamed = true;')[1]).not.toContain('InspectObject(stage.get())');
    expect(atomicReplace).not.toMatch(/MoveFile|ReplaceFile|NtSetInformationFile|ZwSetInformationFile/);

    const diagnostics = source.match(/RenameDiagnosticOutcome RunRenameDiagnosticCase[\s\S]*?\n}/)?.[0];
    expect(diagnostics).toContain('AttemptRenameStage(stage.get(), parent.get(), target_name');
    expect(diagnostics).toContain('RenameReplacementProfile::classic');
  });

  it('rejects every older addon, forbids a null-root relative destination, and requires independent run-owned CWD containment', async () => {
    const [source, loader, integration, nativeCases, renameDiagnostics, replacementDiagnostics, authority] = await Promise.all([
      readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-provider.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-integration.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-native-cases.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-rename-diagnostics.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-replacement-identity-diagnostics.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-authority.mjs'), 'utf8'),
    ]);
    expect(source).toContain('"providerVersion", Integer(env, 2)');
    expect(loader).toContain('addon.providerVersion !== 2');
    expect(source).not.toContain('AttemptRenameStage(stage, nullptr, target_name');
    expect(source).not.toContain('AttemptRenameStage(stage.get(), nullptr, target_name');
    expect(source).toContain('AttemptRenameStage(stage, nullptr, absolute_target_path');
    expect(source).toContain('AttemptRenameStage(stage.get(), nullptr, target_path');
    expect(source).toContain("result.find(L':') != std::wstring::npos");
    expect(integration).toContain('withNativeExecutionCwd');
    expect(integration).toContain('mutationContainmentIndependentlyObserved = nativeExecution.evidence.mutationContainmentIndependentlyObserved');
    expect(integration).toContain('Native execution CWD containment was not independently observed.');
    expect(integration).toContain('providerAuthorityExplicitlyBound = summary.native?.boundaries?.providerAuthorityExplicitlyBound === true');
    expect(integration).toContain('Provider checkpoint authority was not explicitly bound to the run root.');
    expect(integration).toContain('normalizeProviderNativeFailureEvidence(error.providerNativeFailureEvidence)');
    expect(integration).toContain('summary.nativeFailure.providerAuthorityExplicitlyBound');
    expect(integration).not.toContain('PASS alone is not proof of run-root-only mutation');
    for (const runner of [nativeCases, renameDiagnostics, replacementDiagnostics]) {
      expect(runner).toContain('createProviderCheckpointAuthority(runRoot');
      expect(runner).toContain('await assertExecutionCwd(executionCwd);');
      const loadCall = [runner.indexOf('const provider = loadPrivateRootNodeApi'), runner.indexOf('const diagnostics = loadDiagnostics(addonPath)')]
        .find((index) => index >= 0);
      expect(loadCall).toBeGreaterThan(0);
      expect(runner.indexOf('await assertExecutionCwd(executionCwd);')).toBeLessThan(loadCall);
      expect(runner).toContain('mutationContainmentIndependentlyObserved: true');
      expect(runner).toContain('providerAuthorityExplicitlyBound: true');
    }
    expect(nativeCases).toContain('assertPrivateRoot: authority.assertPrivateRoot');
    for (const phase of [
      'visibility-after-provider-commit',
      'rotation-before-provider-commit',
      'rotation-after-provider-commit',
      'rotation-during-external-replace',
      'rotation-after-external-replace',
      'reparse-probe',
    ]) expect(nativeCases).toContain(`runNativeSnapshotPhase('${phase}'`);
    expect(authority).toContain('evidenceRoot: runRoot');
    expect(authority).toContain('cannot be overridden or broadened');
  });

  it('keeps old handles on the displaced object while subsequent opens bind to the renamed stage', async () => {
    const cases = await readFile(resolve('scripts/qa-private-root-node-api-native-cases.mjs'), 'utf8');
    expect(cases).toContain("record('replacement-visibility-binds-subsequent-open-to-stage'");
    expect(cases).toContain("const displaced = await open(visibilityTarget, 'r');");
    expect(cases).toContain('lease.atomicReplace(visibilityTarget, replacement)');
    expect(cases).toContain('lease.readSnapshot(visibilityTarget)');
    expect(cases).toContain("displaced.readFile('utf8')");
    expect(cases).toContain('subsequentOpenBoundRenamedFile: true, displacedHandlePreserved: true');
  });

  it('verifies the committed name through a fresh target handle while the staged identity stays delete-share locked', async () => {
    const source = await readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8');
    const targetOpen = source.match(/UniqueHandle OpenCommittedTargetForVerification[\s\S]*?\n}/)?.[0];
    expect(targetOpen).toContain('FILE_READ_ATTRIBUTES | READ_CONTROL');
    expect(targetOpen).toContain('FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE');
    expect(targetOpen).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
    expect(targetOpen).not.toContain('GENERIC_READ');

    const verification = source.match(/void ValidateCommittedTarget[\s\S]*?\n}/)?.[0];
    expect(verification).toContain('const FileIdentity committed_stage = InspectFileIdentity(stage);');
    expect(verification).toContain('UniqueHandle target = OpenCommittedTargetForVerification(allowed.path);');
    expect(verification).toContain('const FilesystemObject committed_target = InspectObject(target.get());');
    expect(verification).toContain('SamePath(committed_target.final_path, allowed.path)');
    expect(verification).toContain('committed_target.file_index != initial_stage.file_index');
    expect(verification).toContain('committed_target.file_index != committed_stage.file_index');
    expect(verification).toContain('ValidateSecurity(target.get(), state.security, false);');
    expect(verification).toContain('ValidateStageBytes(stage, expected);');
    expect(verification).not.toContain('SamePath(initial_stage.final_path, allowed.path)');

    const stageOpen = source.match(/const HANDLE raw = CreateFileW\(stage_path[\s\S]*?;\n/)?.[0];
    expect(stageOpen).toContain('READ_CONTROL, 0, nullptr, CREATE_NEW');
  });

  it('admits only delete sharing for atomic snapshot rotation and preserves every other handle contract', async () => {
    const [source, cases] = await Promise.all([
      readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-native-cases.mjs'), 'utf8'),
    ]);
    const snapshotOpen = source.match(/UniqueHandle OpenSnapshot[\s\S]*?\n}/)?.[0];
    expect(snapshotOpen).toContain('GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE');
    expect(snapshotOpen).not.toContain('FILE_SHARE_WRITE');
    expect(snapshotOpen).not.toContain('GENERIC_WRITE');
    expect(snapshotOpen).toContain('keep write sharing denied');

    const pinnedDirectory = source.match(/UniqueHandle OpenPinnedDirectory[\s\S]*?\n}/)?.[0];
    expect(pinnedDirectory).toContain('FILE_SHARE_READ | FILE_SHARE_WRITE');
    expect(pinnedDirectory).not.toContain('FILE_SHARE_DELETE');
    const atomicStage = source.match(/const HANDLE raw = CreateFileW\(stage_path[\s\S]*?;\n/)?.[0];
    expect(atomicStage).toContain('GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0');

    expect(cases.indexOf('writeFileSync(stage')).toBeLessThan(cases.indexOf('renameSync(stage'));
    expect(cases).toContain("runNativeSnapshotPhase('rotation-during-external-replace'");
    for (const phase of Object.keys({
      'visibility-after-provider-commit': true,
      'rotation-before-provider-commit': true,
      'rotation-after-provider-commit': true,
      'rotation-during-external-replace': true,
      'rotation-after-external-replace': true,
      'reparse-probe': true,
    })) expect(cases).toContain(`'${phase}'`);
  });

  it('isolates broad-principal fixtures and removes propagated grants before exact-object revalidation', async () => {
    const [cases, integration] = await Promise.all([
      readFile(resolve('scripts/qa-private-root-node-api-native-cases.mjs'), 'utf8'),
      readFile(resolve('scripts/qa-private-root-node-api-integration.mjs'), 'utf8'),
    ]);
    expect(cases).toContain("const aclDriftRoot = join(runRoot, 'acl-drift-root');");
    expect(cases).toContain("grantBroadRead(aclDriftRoot);");
    expect(cases).not.toContain('grantBroadRead(privateRoot);');
    expect(cases).toContain("run('icacls.exe', [path, '/remove:g', `*${USERS_SID}`, '/T']);");
    expect(cases).not.toMatch(/\/remove:g[^\n]*\/C/);
    const restoration = cases.match(/export async function restoreNegativeAclFixture[\s\S]*?\n}/)?.[0];
    expect(restoration).toContain('const removeGrant = dependencies.removeBroadRead ?? removeBroadRead;');
    expect(restoration).toContain('const protectRoot = dependencies.protectOwnerPrivateRoot ?? protectOwnerPrivateRoot;');
    expect(restoration).toContain('removeGrant(root);');
    expect(restoration).toContain('await protectRoot(root);');
    expect(restoration).toContain('authority.assertPrivateRoot({ privateRoot: root, paths })');
    expect(restoration).toContain('restored.identity');
    expect(restoration).toContain('restored.inspectedPaths === paths.length + 1');
    for (const phase of ['broad-principal-restoration', 'sticky-acl-restoration', 'primary-final-observation']) {
      expect(cases).toContain(`'${phase}'`);
    }
    expect(cases).toContain("await readFile(aclDriftFile, 'utf8') === 'acl-drift-sentinel'");
    expect(integration).toContain("summary.nativeFailure?.kind === 'js-authority-acl'");
    expect(integration).toContain('Unexpected principal detected: ${summary.nativeFailure.unexpectedPrincipalDetected}.');
    expect(integration).not.toContain('Unexpected principal SID');
  });

  it('validates decimal wide characters before explicitly narrowing their ASCII values', async () => {
    const source = await readFile(resolve('native/src/qa_private_root_provider.cpp'), 'utf8');
    const conversion = source.match(/std::string NarrowDigits[\s\S]*?\n}/)?.[0];
    expect(conversion).toContain("character >= L'0' && character <= L'9'");
    expect(conversion).toContain('static_cast<char>(character)');
    expect(conversion).not.toContain('std::string(value.begin(), value.end())');
  });

  it('does not wire the prototype into either production coordinator', async () => {
    const [session, mcp] = await Promise.all([
      readFile(join(resolve('scripts'), 'qa-session.mjs'), 'utf8'),
      readFile(join(resolve('scripts'), 'qa-mcp.mjs'), 'utf8'),
    ]);
    expect(session).not.toContain('qa-private-root-node-api-provider');
    expect(mcp).not.toContain('qa-private-root-node-api-provider');
    expect(session).not.toContain('aimuse-qa-private-root-provider');
    expect(mcp).not.toContain('aimuse-qa-private-root-provider');
  });
});
