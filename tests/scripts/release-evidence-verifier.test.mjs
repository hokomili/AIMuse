import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseEvidence } from '../../scripts/release-evidence-verifier.mjs';

const roots = [];
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function identity(role, path) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath);
  return { role, requestedPath: resolve(path), canonicalPath, bytes: info.size, sha256: sha256(await readFile(canonicalPath)) };
}
async function writePrivate(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'aimuse-release-verifier-')));
  const executionTemp = await realpath(await mkdtemp(join(tmpdir(), 'aimuse-release-verifier-temp-')));
  roots.push(workspace, executionTemp);
  const runRoot = join(workspace, 'test-results', 'luna-high', 'fresh-run');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const contractBytes = await readFile(resolve('scripts/formal-release-contract.json'));
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const contractPath = join(workspace, 'scripts', 'formal-release-contract.json');
  await writePrivate(contractPath, contractBytes);
  const dummyPath = join(workspace, 'tool.bin');
  await writePrivate(dummyPath, 'tool');
  const actualVerifierPath = resolve('scripts/release-evidence-verifier.mjs');
  const actualWitnessPath = resolve('scripts/release-command-witness.mjs');
  const controls = {};
  for (const path of contract.declaredTooling.controlPaths) {
    const selected = path === 'scripts/release-evidence-verifier.mjs'
      ? actualVerifierPath
      : path === 'scripts/release-command-witness.mjs'
        ? actualWitnessPath
        : path === 'scripts/formal-release-contract.json' ? contractPath : dummyPath;
    controls[path] = await identity(path, selected);
  }
  const javascriptTools = {};
  for (const role of Object.keys(contract.declaredTooling.javascriptTools)) javascriptTools[role] = await identity(role, dummyPath);
  const externalRoles = [
    ...contract.declaredTooling.requiredExternalToolRoles,
    ...(process.platform === 'darwin' ? contract.declaredTooling.darwinExternalToolRoles : []),
  ];
  const externalTools = {};
  for (const role of externalRoles) externalTools[role] = await identity(role, role === 'node' ? process.execPath : dummyPath);
  const contentRoles = [
    ...Object.keys(contract.declaredTooling.contentTrees),
    ...(process.platform === 'darwin' ? Object.keys(contract.declaredTooling.darwinContentTrees) : []),
  ];
  const contentRoots = {};
  const contentInventoryObjects = {};
  const contentInventories = {};
  for (const role of contentRoles) {
    const contentRoot = join(workspace, `content-${role}`);
    await mkdir(contentRoot, { mode: 0o700 });
    const entryBytes = Buffer.from(`${role}\n`);
    await writePrivate(join(contentRoot, 'implementation.bin'), entryBytes);
    const entries = [{ path: 'implementation.bin', type: 'file', mode: 0o600, bytes: entryBytes.length, sha256: sha256(entryBytes) }];
    const inventory = {
      schemaVersion: 1,
      kind: 'aimuse-declared-content-tree',
      role,
      root: contentRoot,
      rootMode: 0o700,
      files: 1,
      directories: 0,
      symlinks: 0,
      entriesSha256: sha256(Buffer.from(JSON.stringify(entries))),
      entries,
    };
    const inventoryPath = join(runRoot, `content-tree-${role}.json`);
    const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
    await writePrivate(inventoryPath, inventoryBytes);
    contentRoots[role] = { role, root: contentRoot, allowedExternalRoots: [] };
    contentInventoryObjects[role] = inventory;
    contentInventories[role] = {
      root: contentRoot,
      rootMode: inventory.rootMode,
      files: inventory.files,
      directories: inventory.directories,
      symlinks: inventory.symlinks,
      entriesSha256: inventory.entriesSha256,
      inventory: { path: relative(runRoot, inventoryPath).split(sep).join('/'), bytes: inventoryBytes.length, sha256: sha256(inventoryBytes) },
    };
  }
  const sourceInputs = {
    scope: 'manifest-authorized-clean-commit', rootWasEnumerated: false, protectedRootsAccessed: false,
    gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), sourceManifestSha256: 'C'.repeat(64),
    workspaceInputFiles: 3, workspaceInputsSha256: 'D'.repeat(64), entries: [],
  };
  const dependencyPath = join(runRoot, 'dependency-inventory.json');
  const dependencyBytes = Buffer.from('{}\n');
  await writePrivate(dependencyPath, dependencyBytes);
  const npmUserConfigPath = join(runRoot, 'npm-user-config');
  const npmGlobalConfigPath = join(runRoot, 'npm-global-config');
  await Promise.all([writePrivate(npmUserConfigPath, Buffer.alloc(0)), writePrivate(npmGlobalConfigPath, Buffer.alloc(0))]);
  const miniaudioSourceDirectory = join(runRoot, 'declared-inputs', 'miniaudio');
  const miniaudioFile = join(miniaudioSourceDirectory, 'miniaudio.h');
  const miniaudioBytes = Buffer.from('declared miniaudio\n');
  await writePrivate(miniaudioFile, miniaudioBytes);
  const miniaudioEntries = [{ path: 'miniaudio.h', mode: '100644', bytes: miniaudioBytes.length, sha256: sha256(miniaudioBytes) }];
  const miniaudioInventory = {
    schemaVersion: 1,
    kind: 'aimuse-declared-native-dependency',
    dependency: 'miniaudio',
    revision: contract.declaredTooling.nativeDependencies.miniaudio.revision,
    files: miniaudioEntries.length,
    entriesSha256: sha256(Buffer.from(JSON.stringify(miniaudioEntries))),
    entries: miniaudioEntries,
  };
  const miniaudioInventoryPath = join(runRoot, 'native-dependency-miniaudio.json');
  const miniaudioInventoryBytes = Buffer.from(`${JSON.stringify(miniaudioInventory, null, 2)}\n`);
  await writePrivate(miniaudioInventoryPath, miniaudioInventoryBytes);
  const executionHome = join(runRoot, 'execution-home');
  const npmCache = join(runRoot, 'npm-cache');
  await Promise.all([executionHome, npmCache].map((path) => mkdir(path, { mode: 0o700 })));
  const rootInfo = await lstat(runRoot);
  const protectedIdentity = { version: 1, canonicalPath: await realpath(runRoot), device: String(rootInfo.dev), inode: String(rootInfo.ino) };
  const executionTempInfo = await lstat(executionTemp);
  const protectedExecutionTempIdentity = { version: 1, canonicalPath: executionTemp, device: String(executionTempInfo.dev), inode: String(executionTempInfo.ino) };
  const toolPath = [join(workspace, 'scripts', 'npm-shims'), ...new Set(Object.values(externalTools).flatMap((tool) => [dirname(tool.requestedPath), dirname(tool.canonicalPath)]))].join(delimiter);
  const executionEnvironment = {
    HOME: executionHome,
    TMPDIR: executionTemp,
    TEMP: executionTemp,
    TMP: executionTemp,
    XDG_CACHE_HOME: join(executionHome, '.cache'),
    XDG_CONFIG_HOME: join(executionHome, '.config'),
    PATH: toolPath,
    SHELL: externalTools.scriptShell.requestedPath,
    npm_config_script_shell: externalTools.scriptShell.requestedPath,
    npm_config_userconfig: npmUserConfigPath,
    npm_config_globalconfig: npmGlobalConfigPath,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: npmUserConfigPath,
    GIT_CONFIG_SYSTEM: npmGlobalConfigPath,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    AIMUSE_NODE24_EXE: externalTools.node.canonicalPath,
    AIMUSE_NPM_CLI: externalTools.npm.canonicalPath,
    AIMUSE_CMAKE: externalTools.cmake.requestedPath,
    ...(externalTools.make ? { AIMUSE_MAKE: externalTools.make.requestedPath } : {}),
    CC: externalTools.cCompiler.requestedPath,
    CXX: externalTools.cppCompiler.requestedPath,
    AIMUSE_RENDERER_BROWSER_EXECUTABLE: externalTools.rendererBrowser.requestedPath,
    AIMUSE_NATIVE_BUILD_DIR: join(runRoot, 'native-build'),
    AIMUSE_NATIVE_DIST_DIR: join(runRoot, 'native'),
    AIMUSE_MINIAUDIO_SOURCE_DIR: miniaudioSourceDirectory,
    AIMUSE_TARGET_ARCH: 'arm64',
    AIMUSE_VERIFY_PACKAGE_ARCH: 'arm64',
    AIMUSE_ENABLE_COREAUDIO: '1',
    AIMUSE_ENABLE_WASAPI: '1',
    ...(process.platform === 'win32' ? {
      USERPROFILE: executionHome,
      LOCALAPPDATA: join(executionHome, 'AppData', 'Local'),
      APPDATA: join(executionHome, 'AppData', 'Roaming'),
      ComSpec: externalTools.scriptShell.requestedPath,
    } : {}),
  };
  const inputPath = join(runRoot, 'declared-release-inputs.json');
  const inputs = {
    schemaVersion: 2,
    kind: 'aimuse-declared-release-inputs',
    createdAt: new Date(0).toISOString(),
    acceptanceVerdict: null,
    level: 2,
    implementationTaskId: 'implementation-task',
    expectedIndependentTester: { model: 'gpt-6-astra', reasoningEffort: 'high', distinctTaskRequired: true },
    protectedRunRoot: { identity: protectedIdentity, owner: 'launching-user', allowedPrincipals: ['launching-user'] },
    protectedExecutionTemp: { identity: protectedExecutionTempIdentity, owner: 'launching-user', allowedPrincipals: ['launching-user'] },
    sourceInputs,
    paths: {
      workspace,
      formalRunRoot: runRoot,
      forgeOutDirectory: join(runRoot, 'package-output'),
      packageSubjectManifest: join(runRoot, 'package-subject.json'),
      packagedPlaywrightOutput: join(workspace, 'test-results', 'playwright', 'fresh-run'),
      packagedPlaywrightHtmlReport: join(workspace, 'test-results', 'playwright', 'fresh-run-html-report'),
      rendererPlaywrightOutput: join(runRoot, 'renderer-playwright'),
      workspaceViteOutputDirectory: join(workspace, '.vite'),
      executionHome,
      executionTemp,
      npmCache,
      nativeBuildDirectory: join(runRoot, 'native-build'),
      nativeDistributionDirectory: join(runRoot, 'native'),
      miniaudioSourceDirectory,
      architecture: 'arm64',
    },
    contract: { path: 'scripts/formal-release-contract.json', bytes: contractBytes.length, sha256: sha256(contractBytes) },
    controls,
    toolchain: {
      platform: process.platform,
      architecture: process.arch,
      externalTools,
      javascriptTools,
      contentInventories,
      dependencyInventory: { path: 'dependency-inventory.json', bytes: dependencyBytes.length, sha256: sha256(dependencyBytes) },
      npmConfiguration: {
        user: { path: 'npm-user-config', bytes: 0, sha256: sha256(Buffer.alloc(0)) },
        global: { path: 'npm-global-config', bytes: 0, sha256: sha256(Buffer.alloc(0)) },
      },
      nativeDependencies: {
        miniaudio: {
          revision: miniaudioInventory.revision,
          sourceDirectory: 'declared-inputs/miniaudio',
          files: miniaudioInventory.files,
          entriesSha256: miniaudioInventory.entriesSha256,
          inventory: { path: 'native-dependency-miniaudio.json', bytes: miniaudioInventoryBytes.length, sha256: sha256(miniaudioInventoryBytes) },
        },
      },
    },
    executionEnvironment,
  };
  const inputBytes = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
  await writePrivate(inputPath, inputBytes);
  const inputSha256 = sha256(inputBytes);
  const packagePath = join(runRoot, 'package-subject.json');
  await writePrivate(packagePath, '{}\n');
  const packageSha256 = 'E'.repeat(64);
  const subjectIdentity = 'F'.repeat(64);
  const expectedEnvironment = (withSubject) => Object.fromEntries(Object.entries({
    ...executionEnvironment,
    AIMUSE_FORMAL_RUN_ROOT: runRoot,
    AIMUSE_FORGE_OUT_DIR: inputs.paths.forgeOutDirectory,
    AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR: inputs.paths.packagedPlaywrightOutput,
    AIMUSE_RENDERER_PLAYWRIGHT_OUTPUT_DIR: inputs.paths.rendererPlaywrightOutput,
    AIMUSE_NPM_CLI: externalTools.npm.canonicalPath,
    ...(withSubject ? { AIMUSE_PACKAGE_SUBJECT_MANIFEST: packagePath, AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256: packageSha256 } : {}),
  }).sort(([left], [right]) => left.localeCompare(right)));
  const stages = [...contract.stages.base, ...contract.stages.level2];
  const receiptDeclarations = [];
  const receiptObjects = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const prefix = `${String(index + 1).padStart(2, '0')}-${stage.id}`;
    const stdoutPath = join(runRoot, 'execution', `${prefix}.stdout.log`);
    const stderrPath = join(runRoot, 'execution', `${prefix}.stderr.log`);
    const stdoutBytes = Buffer.from(`${stage.id}\n`);
    const stderrBytes = Buffer.alloc(0);
    await writePrivate(stdoutPath, stdoutBytes);
    await writePrivate(stderrPath, stderrBytes);
    const command = stage.command.type === 'npm-script'
      ? { logical: stage.command, executable: externalTools.node, arguments: [externalTools.npm.requestedPath, 'run', stage.command.name] }
      : { logical: stage.command, executable: externalTools.node, arguments: [stage.command.path] };
    const receipt = {
      schemaVersion: 2,
      kind: 'aimuse-witnessed-command-execution',
      createdAt: new Date(0).toISOString(),
      acceptanceVerdict: null,
      stageId: stage.id,
      declaredInputs: { path: 'declared-release-inputs.json', sha256: inputSha256 },
      contract: { path: inputs.contract.path, sha256: inputs.contract.sha256 },
      attribution: { witnessPath: 'scripts/release-command-witness.mjs', witnessSha256: controls['scripts/release-command-witness.mjs'].sha256, witnessPid: 10 + index, childPid: 100 + index },
      command,
      environment: expectedEnvironment(stage.packageSubjectRequired),
      timing: { startedAt: new Date(index * 1000).toISOString(), finishedAt: new Date(index * 1000 + 10).toISOString(), durationMs: 10 },
      termination: { exitCode: 0, signal: null },
      stdout: { path: relative(runRoot, stdoutPath).split(sep).join('/'), bytes: stdoutBytes.length, sha256: sha256(stdoutBytes) },
      stderr: { path: relative(runRoot, stderrPath).split(sep).join('/'), bytes: 0, sha256: sha256(stderrBytes) },
      ...(stage.packageSubjectRequired ? { packageSubject: { path: 'package-subject.json', sha256: packageSha256 } } : {}),
    };
    const receiptPath = join(runRoot, 'execution', `${prefix}.receipt.json`);
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    await writePrivate(receiptPath, receiptBytes);
    receiptObjects.push(receipt);
    receiptDeclarations.push({ stageId: stage.id, path: relative(runRoot, receiptPath).split(sep).join('/'), bytes: receiptBytes.length, sha256: sha256(receiptBytes) });
  }
  const leasePath = join(runRoot, 'run-lease.json');
  const leaseBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 2, kind: 'aimuse-formal-run-lease', createdAt: new Date(0).toISOString(), acceptanceVerdict: null, declaredInputsSha256: inputSha256, protectedRunRootIdentity: protectedIdentity })}\n`);
  await writePrivate(leasePath, leaseBytes);
  const observations = {
    schemaVersion: 2,
    kind: 'aimuse-formal-release-automation-observations',
    createdAt: new Date(0).toISOString(),
    acceptanceVerdict: null,
    releasePhase: 'AUTOMATION_COMPLETE_AWAITING_INDEPENDENT_VERIFICATION',
    level: 2,
    protectedRunRoot: { path: 'test-results/luna-high/fresh-run', identity: protectedIdentity, owner: 'launching-user', allowedPrincipals: ['launching-user'] },
    runLease: { path: 'run-lease.json', bytes: leaseBytes.length, sha256: sha256(leaseBytes) },
    declaredInputs: { path: 'declared-release-inputs.json', bytes: inputBytes.length, sha256: inputSha256 },
    packageSubject: { path: 'package-subject.json', sha256: packageSha256, identitySha256: subjectIdentity },
    executionReceipts: receiptDeclarations,
  };
  const observationPath = join(runRoot, 'automation-observations.json');
  const writeObservations = async () => {
    const bytes = Buffer.from(`${JSON.stringify(observations, null, 2)}\n`);
    await writePrivate(observationPath, bytes);
    return sha256(bytes);
  };
  const verifyPackageSubject = async () => ({
    assertions: {
      requiredRuntimeEntries: true, minimumComponentSizes: true, exactMcpToolSurface: true,
      providerFreeProductBoundary: true, rendererAuthorityIsolation: true,
      ...(process.platform === 'darwin' ? { macosBundleContract: true, repoOwnedIcon: true, deepStrictSignature: true } : {}),
    },
    manifest: {
      inputs: sourceInputs,
      subject: {
        identitySha256: subjectIdentity, packageDirectory: 'test-results/luna-high/fresh-run/package-output/AIMuse-darwin-arm64', architecture: 'arm64', signature: { kind: 'ad-hoc' },
        files: { applicationExecutable: { sha256: '1'.repeat(64) }, applicationAsar: { sha256: '2'.repeat(64) } },
      },
    },
  });
  return {
    workspace, runRoot, executionTemp, inputPath, inputSha256, observationPath, observations, receiptObjects, contentInventoryObjects,
    writeObservations, verifyPackageSubject,
    verifierSha256: sha256(await readFile(actualVerifierPath)),
    witnessSha256: controls['scripts/release-command-witness.mjs'].sha256,
    resolveContentTrees: async () => contentRoots,
    reproduceContentInventory: async ({ role }) => contentInventoryObjects[role],
  };
}

function verificationArguments(value, observationSha256) {
  return {
    workspace: value.workspace,
    formalRunRoot: value.runRoot,
    observationManifestPath: value.observationPath,
    expectedObservationManifestSha256: observationSha256,
    declaredInputsPath: value.inputPath,
    expectedDeclaredInputsSha256: value.inputSha256,
    expectedVerifierSha256: value.verifierSha256,
    expectedWitnessSha256: value.witnessSha256,
  };
}

describe('independent release evidence verifier', () => {
  it('derives only an automated-gates disposition from exact witnessed commands and declared tooling', async () => {
    const value = await fixture();
    const observationSha256 = await value.writeObservations();
    const result = await verifyReleaseEvidence(verificationArguments(value, observationSha256), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({}),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: value.reproduceContentInventory,
    });
    expect(result).toMatchObject({
      verdict: 'AUTOMATED_GATES_PASS',
      levelCertification: 'PENDING_INDEPENDENT_MCP_AND_COMPUTER_USE',
      execution: { independentlyAttributed: true },
    });
    expect(result.execution.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ stageId: 'verify-source' })]));
  });

  it('rejects producer judgement and a forged successful termination', async () => {
    const value = await fixture();
    value.observations.acceptanceVerdict = 'PASS';
    let digest = await value.writeObservations();
    await expect(verifyReleaseEvidence(verificationArguments(value, digest), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({}),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: value.reproduceContentInventory,
    })).rejects.toThrow(/stored an acceptance verdict/u);

    value.observations.acceptanceVerdict = null;
    const receipt = value.receiptObjects[0];
    receipt.termination.exitCode = 1;
    const path = join(value.runRoot, value.observations.executionReceipts[0].path);
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    await writePrivate(path, bytes);
    value.observations.executionReceipts[0].bytes = bytes.length;
    value.observations.executionReceipts[0].sha256 = sha256(bytes);
    digest = await value.writeObservations();
    await expect(verifyReleaseEvidence(verificationArguments(value, digest), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({}),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: value.reproduceContentInventory,
    })).rejects.toThrow(/did not terminate successfully/u);
  });

  it('rejects replacement of the declared external execution temporary directory', async () => {
    const value = await fixture();
    const observationSha256 = await value.writeObservations();
    await rm(value.executionTemp, { recursive: true });
    await mkdir(value.executionTemp, { mode: 0o700 });
    await expect(verifyReleaseEvidence(verificationArguments(value, observationSha256), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({}),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: value.reproduceContentInventory,
    })).rejects.toThrow(/temporary-directory identity drifted/u);
  });

  it('rejects content-tree byte drift and an unhealthy reproduced dependency graph', async () => {
    const value = await fixture();
    const observationSha256 = await value.writeObservations();
    const changedRole = Object.keys(value.contentInventoryObjects)[0];
    await expect(verifyReleaseEvidence(verificationArguments(value, observationSha256), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({}),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: async ({ role }) => role === changedRole
        ? { ...value.contentInventoryObjects[role], entriesSha256: '0'.repeat(64) }
        : value.contentInventoryObjects[role],
    })).rejects.toThrow(/content tree drifted/u);

    await expect(verifyReleaseEvidence(verificationArguments(value, observationSha256), {
      verifyPackageSubject: value.verifyPackageSubject,
      reproduceDependencyInventory: () => ({ problems: ['extraneous: surprise@1.0.0'] }),
      resolveContentTrees: value.resolveContentTrees,
      reproduceContentInventory: value.reproduceContentInventory,
    })).rejects.toThrow(/dependency tree is not clean/u);
  });
});
