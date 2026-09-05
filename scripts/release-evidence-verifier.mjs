import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { verifyPackageSubject } from './package-subject-verifier.mjs';
import { inspectProtectedRunRoot } from './release-protected-root-verifier.mjs';

const DECLARED_INPUT_FIELDS = ['schemaVersion', 'kind', 'createdAt', 'acceptanceVerdict', 'level', 'implementationTaskId', 'expectedIndependentTester', 'protectedRunRoot', 'sourceInputs', 'paths', 'contract', 'controls', 'toolchain', 'executionEnvironment'];
const AUTOMATION_OBSERVATION_FIELDS = ['schemaVersion', 'kind', 'createdAt', 'acceptanceVerdict', 'releasePhase', 'level', 'protectedRunRoot', 'runLease', 'declaredInputs', 'packageSubject', 'executionReceipts'];
const EXECUTION_RECEIPT_BASE_FIELDS = ['schemaVersion', 'kind', 'createdAt', 'acceptanceVerdict', 'stageId', 'declaredInputs', 'contract', 'attribution', 'command', 'environment', 'timing', 'termination', 'stdout', 'stderr'];

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[A-F\d]{64}$/iu.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value.toUpperCase();
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function assertExactKeys(value, expected, label) {
  if (stableStringify(Object.keys(value ?? {}).sort()) !== stableStringify([...expected].sort())) throw new Error(`${label} schema fields do not exactly match the stable contract.`);
}
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function relativeEvidencePath(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split(/[\\/]/u).includes('..')) throw new Error(`Invalid formal evidence path: ${String(value)}`);
  const path = resolve(root, value);
  if (!strictChild(root, path)) throw new Error(`Formal evidence path escaped its protected root: ${value}`);
  return path;
}
function parseCli(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return values;
}
function required(values, key) { const value = values.get(key); if (!value) throw new Error(`--${key} is required.`); return value; }
function stagePlan(contract, level) {
  if (contract?.schemaVersion !== 2 || contract.kind !== 'aimuse-formal-release-contract' || contract.schemas?.automationObservations !== 2 || !Array.isArray(contract.stages?.base)) throw new Error('Formal release contract schema is unsupported.');
  if (level === 1) return [...contract.stages.base];
  if (level === 2 && Array.isArray(contract.stages.level2)) return [...contract.stages.base, ...contract.stages.level2];
  throw new Error(`Formal release contract does not support Level ${level}.`);
}
function forbiddenJudgementKeys(value, path = '$') {
  const failures = [];
  if (Array.isArray(value)) {
    value.forEach((child, index) => failures.push(...forbiddenJudgementKeys(child, `${path}[${index}]`)));
    return failures;
  }
  if (!value || typeof value !== 'object') return failures;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/^(?:verdict|pass|passed|result|status)$/iu.test(key)) failures.push(childPath);
    failures.push(...forbiddenJudgementKeys(child, childPath));
  }
  return failures;
}
async function assertOwnerPrivateFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${label} is not owned by the verifier user.`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible.`);
  }
  return info;
}
async function assertOwnerPrivateDirectory(path, root, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(path);
  if (!strictChild(await realpath(root), canonical)) throw new Error(`${label} escaped the protected run root.`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${label} is not owned by the verifier user.`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} is group/world accessible.`);
  }
}
async function publishExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite independent automated verification: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}
async function readBoundFile(path, declaration, label) {
  await assertOwnerPrivateFile(path, label);
  const info = await stat(path);
  const bytes = await readFile(path);
  if (declaration?.bytes !== undefined && declaration.bytes !== info.size) throw new Error(`${label} size drifted.`);
  if (sha256Bytes(bytes) !== assertSha256(declaration?.sha256, `${label} digest`)) throw new Error(`${label} bytes drifted.`);
  return bytes;
}
async function assertToolIdentity(declaration, label) {
  if (!declaration || typeof declaration !== 'object' || !isAbsolute(declaration.requestedPath ?? '') || !isAbsolute(declaration.canonicalPath ?? '')) throw new Error(`${label} declaration is invalid.`);
  const canonical = await realpath(declaration.requestedPath);
  if (canonical !== declaration.canonicalPath) throw new Error(`${label} canonical path drifted.`);
  const info = await stat(canonical);
  if (!info.isFile() || info.size !== declaration.bytes || await sha256File(canonical) !== assertSha256(declaration.sha256, `${label} digest`)) throw new Error(`${label} bytes drifted from declared inputs.`);
}
function environmentFor(inputs, subject) {
  const environment = {
    ...inputs.executionEnvironment,
    AIMUSE_FORMAL_RUN_ROOT: inputs.paths.formalRunRoot,
    AIMUSE_FORGE_OUT_DIR: inputs.paths.forgeOutDirectory,
    AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR: inputs.paths.packagedPlaywrightOutput,
    AIMUSE_RENDERER_PLAYWRIGHT_OUTPUT_DIR: inputs.paths.rendererPlaywrightOutput,
    AIMUSE_NPM_CLI: inputs.toolchain.externalTools.npm.canonicalPath,
  };
  if (subject) {
    environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST = subject.path;
    environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256 = subject.sha256;
  }
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}
function expectedCommand(stage, inputs) {
  if (stage.command?.type === 'npm-script') return {
    logical: stage.command,
    executable: inputs.toolchain.externalTools.node,
    arguments: [inputs.toolchain.externalTools.npm.requestedPath, 'run', stage.command.name],
  };
  if (stage.command?.type === 'node-script') return {
    logical: stage.command,
    executable: inputs.toolchain.externalTools.node,
    arguments: [stage.command.path],
  };
  throw new Error(`Unsupported command type for stage ${stage.id}.`);
}
function validateTiming(timing, stageId) {
  assertExactKeys(timing, ['startedAt', 'finishedAt', 'durationMs'], `Witness timing ${stageId}`);
  const started = Date.parse(timing?.startedAt);
  const finished = Date.parse(timing?.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || typeof timing.durationMs !== 'number' || !Number.isFinite(timing.durationMs) || timing.durationMs < 0) throw new Error(`Witness timing is invalid for ${stageId}.`);
}
function validateExecutionEnvironment(inputs, runRoot) {
  const environment = inputs.executionEnvironment;
  const tools = inputs.toolchain.externalTools;
  const allowed = new Set([
    'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SystemRoot', 'ProgramFiles',
    'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
    'HOME', 'USERPROFILE', 'ComSpec', 'TMPDIR', 'TEMP', 'TMP', 'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME', 'PATH', 'SHELL', 'npm_config_script_shell', 'npm_config_userconfig',
    'npm_config_globalconfig', 'npm_config_cache', 'npm_config_update_notifier',
    'npm_config_audit', 'npm_config_fund', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
    'AIMUSE_CMAKE', 'AIMUSE_NINJA', 'AIMUSE_MAKE', 'CC', 'CXX',
    'AIMUSE_RENDERER_BROWSER_EXECUTABLE', 'AIMUSE_TARGET_ARCH', 'AIMUSE_VERIFY_PACKAGE_ARCH',
    'AIMUSE_ENABLE_COREAUDIO', 'AIMUSE_ENABLE_WASAPI', 'AIMUSE_NATIVE_BUILD_DIR',
    'AIMUSE_NATIVE_DIST_DIR', 'AIMUSE_MINIAUDIO_SOURCE_DIR',
  ]);
  if (!environment || Object.keys(environment).some((key) => !allowed.has(key))) throw new Error('Declared execution environment contains an ambient or unsupported key.');
  const expectedToolPath = [...new Set(Object.values(tools).flatMap((tool) => [dirname(tool.requestedPath), dirname(tool.canonicalPath)]))].join(delimiter);
  const npmConfigPath = relativeEvidencePath(runRoot, inputs.toolchain.npmConfiguration?.path);
  const expected = {
    HOME: inputs.paths.executionHome,
    TMPDIR: inputs.paths.executionTemp,
    TEMP: inputs.paths.executionTemp,
    TMP: inputs.paths.executionTemp,
    XDG_CACHE_HOME: join(inputs.paths.executionHome, '.cache'),
    XDG_CONFIG_HOME: join(inputs.paths.executionHome, '.config'),
    PATH: expectedToolPath,
    SHELL: tools.scriptShell.requestedPath,
    npm_config_script_shell: tools.scriptShell.requestedPath,
    npm_config_userconfig: npmConfigPath,
    npm_config_globalconfig: npmConfigPath,
    npm_config_cache: inputs.paths.npmCache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: npmConfigPath,
    GIT_CONFIG_SYSTEM: npmConfigPath,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    AIMUSE_CMAKE: tools.cmake.requestedPath,
    ...(tools.ninja ? { AIMUSE_NINJA: tools.ninja.requestedPath } : {}),
    ...(tools.make ? { AIMUSE_MAKE: tools.make.requestedPath } : {}),
    CC: tools.cCompiler.requestedPath,
    CXX: tools.cppCompiler.requestedPath,
    AIMUSE_RENDERER_BROWSER_EXECUTABLE: tools.rendererBrowser.requestedPath,
    AIMUSE_NATIVE_BUILD_DIR: inputs.paths.nativeBuildDirectory,
    AIMUSE_NATIVE_DIST_DIR: inputs.paths.nativeDistributionDirectory,
    AIMUSE_MINIAUDIO_SOURCE_DIR: inputs.paths.miniaudioSourceDirectory,
    AIMUSE_TARGET_ARCH: inputs.paths.architecture,
    AIMUSE_VERIFY_PACKAGE_ARCH: inputs.paths.architecture,
  };
  for (const [key, value] of Object.entries(expected)) if (environment[key] !== value) throw new Error(`Declared execution environment does not isolate ${key}.`);
  if (!['0', '1'].includes(environment.AIMUSE_ENABLE_COREAUDIO) || !['0', '1'].includes(environment.AIMUSE_ENABLE_WASAPI)) throw new Error('Declared native backend flags must be 0 or 1.');
  if (process.platform === 'win32' && (
    environment.USERPROFILE !== inputs.paths.executionHome ||
    environment.LOCALAPPDATA !== join(inputs.paths.executionHome, 'AppData', 'Local') ||
    environment.APPDATA !== join(inputs.paths.executionHome, 'AppData', 'Roaming') ||
    environment.ComSpec !== tools.scriptShell.requestedPath
  )) throw new Error('Declared Windows execution environment is not isolated.');
  return npmConfigPath;
}
async function reproduceNativeDependencyInventory(sourceDirectory, declaration) {
  const entries = [];
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'))) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Declared native dependency contains a symbolic link: ${path}`);
      if (info.isDirectory()) {
        await assertOwnerPrivateDirectory(path, sourceDirectory, 'Declared native dependency directory');
        await visit(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Declared native dependency contains an unsupported entry: ${path}`);
      await assertOwnerPrivateFile(path, 'Declared native dependency file');
      const bytes = await readFile(path);
      entries.push({
        path: relative(sourceDirectory, path).split(sep).join('/'),
        mode: (info.mode & 0o100) !== 0 ? '100755' : '100644',
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
      });
    }
  };
  await visit(sourceDirectory);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return {
    schemaVersion: 1,
    kind: 'aimuse-declared-native-dependency',
    dependency: 'miniaudio',
    revision: declaration.revision,
    files: entries.length,
    entriesSha256: sha256Bytes(Buffer.from(JSON.stringify(entries))),
    entries,
  };
}
function runDependencyInventory(inputs, workspace) {
  const node = inputs.toolchain.externalTools.node.canonicalPath;
  const npm = inputs.toolchain.externalTools.npm.canonicalPath;
  const result = spawnSync(node, [npm, 'ls', '--all', '--json'], {
    cwd: workspace,
    env: inputs.executionEnvironment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`Declared dependency inventory cannot be reproduced: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return JSON.parse(result.stdout);
}

export async function verifyReleaseEvidence({
  workspace = process.cwd(), formalRunRoot, observationManifestPath,
  expectedObservationManifestSha256, declaredInputsPath, expectedDeclaredInputsSha256,
  expectedVerifierSha256, expectedWitnessSha256,
} = {}, dependencies = {}) {
  const root = resolve(workspace);
  const runRoot = resolve(formalRunRoot ?? '');
  if (!formalRunRoot || !observationManifestPath || !declaredInputsPath) throw new Error('Formal run root, observation manifest, and declared inputs are required.');
  const observationPath = resolve(observationManifestPath);
  const inputPath = resolve(declaredInputsPath);
  if (!strictChild(runRoot, observationPath) || !strictChild(runRoot, inputPath)) throw new Error('Automation observations and declared inputs must be strict children of the formal run root.');
  const verifierPath = fileURLToPath(import.meta.url);
  const verifierSha256 = await sha256File(verifierPath);
  if (verifierSha256 !== assertSha256(expectedVerifierSha256, 'Expected independent verifier digest')) throw new Error('The independently selected verifier bytes do not match the caller-controlled digest.');
  const [observationBytes, inputBytes] = await Promise.all([
    readBoundFile(observationPath, { sha256: expectedObservationManifestSha256 }, 'Automation observation manifest'),
    readBoundFile(inputPath, { sha256: expectedDeclaredInputsSha256 }, 'Declared release input manifest'),
  ]);
  const observations = JSON.parse(observationBytes.toString('utf8'));
  const inputs = JSON.parse(inputBytes.toString('utf8'));
  if (observations?.schemaVersion !== 2 || observations.kind !== 'aimuse-formal-release-automation-observations' || observations.releasePhase !== 'AUTOMATION_COMPLETE_AWAITING_INDEPENDENT_VERIFICATION') throw new Error('Automation observation schema is unsupported or unstable.');
  if (inputs?.schemaVersion !== 2 || inputs.kind !== 'aimuse-declared-release-inputs') throw new Error('Declared release input schema is unsupported or unstable.');
  assertExactKeys(observations, AUTOMATION_OBSERVATION_FIELDS, 'Automation observations');
  assertExactKeys(inputs, DECLARED_INPUT_FIELDS, 'Declared release inputs');
  assertExactKeys(inputs.expectedIndependentTester, ['model', 'reasoningEffort', 'distinctTaskRequired'], 'Expected independent tester');
  assertExactKeys(inputs.protectedRunRoot, ['identity', 'owner', 'allowedPrincipals'], 'Declared protected run root');
  assertExactKeys(inputs.paths, ['workspace', 'formalRunRoot', 'forgeOutDirectory', 'packageSubjectManifest', 'packagedPlaywrightOutput', 'packagedPlaywrightHtmlReport', 'rendererPlaywrightOutput', 'executionHome', 'executionTemp', 'npmCache', 'nativeBuildDirectory', 'nativeDistributionDirectory', 'miniaudioSourceDirectory', 'architecture'], 'Declared release paths');
  assertExactKeys(inputs.contract, ['path', 'bytes', 'sha256'], 'Declared release contract');
  assertExactKeys(inputs.toolchain, ['platform', 'architecture', 'externalTools', 'javascriptTools', 'dependencyInventory', 'npmConfiguration', 'nativeDependencies'], 'Declared toolchain');
  assertExactKeys(inputs.toolchain.dependencyInventory, ['path', 'bytes', 'sha256'], 'Declared dependency inventory');
  assertExactKeys(inputs.toolchain.npmConfiguration, ['path', 'bytes', 'sha256'], 'Declared npm configuration');
  assertExactKeys(inputs.toolchain.nativeDependencies, ['miniaudio'], 'Declared native dependencies');
  assertExactKeys(inputs.toolchain.nativeDependencies.miniaudio, ['revision', 'sourceDirectory', 'files', 'entriesSha256', 'inventory'], 'Declared miniaudio dependency');
  assertExactKeys(inputs.toolchain.nativeDependencies.miniaudio.inventory, ['path', 'bytes', 'sha256'], 'Declared miniaudio inventory');
  assertExactKeys(observations.protectedRunRoot, ['path', 'identity', 'owner', 'allowedPrincipals'], 'Observed protected run root');
  assertExactKeys(observations.runLease, ['path', 'bytes', 'sha256'], 'Observed run lease');
  assertExactKeys(observations.declaredInputs, ['path', 'bytes', 'sha256'], 'Observed declared inputs');
  assertExactKeys(observations.packageSubject, ['path', 'sha256', 'identitySha256'], 'Observed package subject');
  if (!Number.isFinite(Date.parse(inputs.createdAt)) || !Number.isFinite(Date.parse(observations.createdAt))) throw new Error('Release evidence timestamps are invalid.');
  if (typeof inputs.implementationTaskId !== 'string' || !inputs.implementationTaskId || inputs.expectedIndependentTester.model !== 'gpt-5.6-luna' || inputs.expectedIndependentTester.reasoningEffort !== 'high' || inputs.expectedIndependentTester.distinctTaskRequired !== true) throw new Error('Independent tester attribution contract is invalid.');
  if (inputs.toolchain.platform !== process.platform || inputs.toolchain.architecture !== process.arch) throw new Error('Declared host platform or architecture drifted.');
  if (observations.acceptanceVerdict !== null || inputs.acceptanceVerdict !== null) throw new Error('A producer stored an acceptance verdict.');
  const producerJudgements = forbiddenJudgementKeys({ ...observations, acceptanceVerdict: undefined });
  if (producerJudgements.length) throw new Error(`Producer evidence contains forbidden judgement fields: ${producerJudgements.join(', ')}`);
  const inputDigest = sha256Bytes(inputBytes);
  if (observations.declaredInputs?.sha256 !== inputDigest || relativeEvidencePath(runRoot, observations.declaredInputs?.path) !== inputPath || observations.declaredInputs?.bytes !== inputBytes.length) throw new Error('Automation observations do not bind the caller-declared inputs exactly.');
  if (resolve(inputs.paths?.workspace ?? '') !== root || resolve(inputs.paths?.formalRunRoot ?? '') !== runRoot || inputs.level !== observations.level) throw new Error('Declared workspace, run root, or level disagrees with automation observations.');
  for (const key of ['forgeOutDirectory', 'packageSubjectManifest', 'rendererPlaywrightOutput', 'executionHome', 'executionTemp', 'npmCache', 'nativeBuildDirectory', 'nativeDistributionDirectory', 'miniaudioSourceDirectory']) {
    if (!strictChild(runRoot, resolve(inputs.paths[key] ?? ''))) throw new Error(`Declared release path escaped the protected run root: ${key}`);
  }
  for (const [key, label] of [['executionHome', 'Execution home'], ['executionTemp', 'Execution temporary directory'], ['npmCache', 'npm cache']]) {
    const selected = resolve(inputs.paths[key] ?? '');
    if (!strictChild(runRoot, selected)) throw new Error(`${label} escaped the protected run root.`);
    await assertOwnerPrivateDirectory(selected, runRoot, label);
  }
  const npmConfigPath = validateExecutionEnvironment(inputs, runRoot);
  const protectedRoot = await inspectProtectedRunRoot({ workspace: root, formalRunRoot: runRoot, paths: [observationPath, inputPath] });
  if (stableStringify(protectedRoot.identity) !== stableStringify(observations.protectedRunRoot?.identity) || stableStringify(protectedRoot.identity) !== stableStringify(inputs.protectedRunRoot?.identity)) throw new Error('Protected run-root identity drifted across input declaration, execution, and verification.');
  const leasePath = relativeEvidencePath(runRoot, observations.runLease?.path);
  const lease = JSON.parse((await readBoundFile(leasePath, observations.runLease, 'Formal run lease')).toString('utf8'));
  assertExactKeys(lease, ['schemaVersion', 'kind', 'createdAt', 'acceptanceVerdict', 'declaredInputsSha256', 'protectedRunRootIdentity'], 'Formal run lease');
  if (lease?.schemaVersion !== 2 || lease.kind !== 'aimuse-formal-run-lease' || lease.acceptanceVerdict !== null || lease.declaredInputsSha256 !== inputDigest || stableStringify(lease.protectedRunRootIdentity) !== stableStringify(protectedRoot.identity)) throw new Error('Formal run lease does not bind the declared inputs and protected root.');
  const contractPath = resolve(root, inputs.contract?.path ?? '');
  if (!strictChild(root, contractPath)) throw new Error('Declared formal release contract escaped the workspace.');
  const contractBytes = await readFile(contractPath);
  if (contractBytes.length !== inputs.contract?.bytes || sha256Bytes(contractBytes) !== assertSha256(inputs.contract?.sha256, 'Formal release contract digest')) throw new Error('Formal release contract drifted from declared inputs.');
  const contract = JSON.parse(contractBytes.toString('utf8'));
  for (const [name, expected] of [
    ['declaredInputs', DECLARED_INPUT_FIELDS],
    ['automationObservations', AUTOMATION_OBSERVATION_FIELDS],
    ['executionReceiptBase', EXECUTION_RECEIPT_BASE_FIELDS],
    ['executionReceiptPackageExtension', ['packageSubject']],
  ]) if (stableStringify(contract.schemaFields?.[name]) !== stableStringify(expected)) throw new Error(`Formal release contract ${name} fields disagree with verifier schema.`);
  const stages = stagePlan(contract, inputs.level);
  const miniaudioDeclaration = inputs.toolchain.nativeDependencies.miniaudio;
  if (miniaudioDeclaration.revision !== contract.declaredTooling?.nativeDependencies?.miniaudio?.revision) throw new Error('Declared miniaudio revision disagrees with the formal release contract.');
  const miniaudioSource = relativeEvidencePath(runRoot, miniaudioDeclaration.sourceDirectory);
  if (resolve(inputs.paths.miniaudioSourceDirectory) !== miniaudioSource) throw new Error('Declared miniaudio source path drifted.');
  await assertOwnerPrivateDirectory(miniaudioSource, runRoot, 'Declared miniaudio source');
  const requiredControls = contract.declaredTooling?.controlPaths;
  const requiredJavascriptTools = Object.keys(contract.declaredTooling?.javascriptTools ?? {});
  const requiredExternalTools = [
    ...(contract.declaredTooling?.requiredExternalToolRoles ?? []),
    ...(process.platform === 'darwin' ? contract.declaredTooling?.darwinExternalToolRoles ?? [] : []),
  ];
  const allowedExternalTools = [...requiredExternalTools, ...(contract.declaredTooling?.optionalExternalToolRoles ?? [])];
  if (!Array.isArray(requiredControls) || stableStringify(Object.keys(inputs.controls ?? {}).sort()) !== stableStringify([...requiredControls].sort())) throw new Error('Declared inputs do not bind the exact contract control set.');
  if (stableStringify(Object.keys(inputs.toolchain?.javascriptTools ?? {}).sort()) !== stableStringify(requiredJavascriptTools.sort())) throw new Error('Declared inputs do not bind the exact JavaScript tool set.');
  const externalRoles = Object.keys(inputs.toolchain?.externalTools ?? {});
  if (requiredExternalTools.some((role) => !externalRoles.includes(role)) || externalRoles.some((role) => !allowedExternalTools.includes(role))) throw new Error('Declared inputs do not bind the exact required external tool set.');
  const declaredVerifier = inputs.controls?.['scripts/release-evidence-verifier.mjs'];
  const declaredWitness = inputs.controls?.['scripts/release-command-witness.mjs'];
  if (declaredVerifier?.sha256 !== verifierSha256 || declaredWitness?.sha256 !== assertSha256(expectedWitnessSha256, 'Expected execution witness digest')) throw new Error('Caller-pinned verifier or witness does not match declared controls.');
  const toolDeclarations = [
    ...Object.entries(inputs.controls ?? {}).map(([name, value]) => [value, `Control ${name}`]),
    ...Object.entries(inputs.toolchain?.externalTools ?? {}).map(([name, value]) => [value, `External tool ${name}`]),
    ...Object.entries(inputs.toolchain?.javascriptTools ?? {}).map(([name, value]) => [value, `JavaScript tool ${name}`]),
  ];
  for (const [declaration, label] of toolDeclarations) await assertToolIdentity(declaration, label);
  const dependencyPath = relativeEvidencePath(runRoot, inputs.toolchain?.dependencyInventory?.path);
  const npmConfigBytes = await readBoundFile(npmConfigPath, inputs.toolchain.npmConfiguration, 'Declared npm configuration');
  if (npmConfigBytes.length !== 0) throw new Error('Declared npm configuration must be empty.');
  const nativeInventoryPath = relativeEvidencePath(runRoot, miniaudioDeclaration.inventory.path);
  const nativeInventoryBytes = await readBoundFile(nativeInventoryPath, miniaudioDeclaration.inventory, 'Declared miniaudio inventory');
  const nativeInventory = JSON.parse(nativeInventoryBytes.toString('utf8'));
  const reproduceNativeInventory = dependencies.reproduceNativeDependencyInventory ?? reproduceNativeDependencyInventory;
  const reproducedNativeInventory = await reproduceNativeInventory(miniaudioSource, miniaudioDeclaration);
  if (stableStringify(nativeInventory) !== stableStringify(reproducedNativeInventory) || nativeInventory.files !== miniaudioDeclaration.files || nativeInventory.entriesSha256 !== miniaudioDeclaration.entriesSha256) throw new Error('Declared miniaudio dependency bytes drifted.');
  const dependencyBytes = await readBoundFile(dependencyPath, inputs.toolchain.dependencyInventory, 'Declared dependency inventory');
  const reproduceInventory = dependencies.reproduceDependencyInventory ?? runDependencyInventory;
  if (stableStringify(JSON.parse(dependencyBytes.toString('utf8'))) !== stableStringify(reproduceInventory(inputs, root))) throw new Error('Installed dependency inventory drifted from declared tooling inputs.');
  if (!Array.isArray(observations.executionReceipts) || observations.executionReceipts.length !== stages.length) throw new Error('Automation observations do not contain the exact contract stage receipt set.');
  const subjectPath = relativeEvidencePath(runRoot, observations.packageSubject?.path);
  const subjectBinding = { path: subjectPath, sha256: assertSha256(observations.packageSubject?.sha256, 'Package subject digest') };
  const receiptIdentities = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const declaration = observations.executionReceipts[index];
    assertExactKeys(declaration, ['stageId', 'path', 'bytes', 'sha256'], `Execution receipt declaration ${stage.id}`);
    const expectedReceiptPath = join(runRoot, 'execution', `${String(index + 1).padStart(2, '0')}-${stage.id}.receipt.json`);
    if (declaration?.stageId !== stage.id || relativeEvidencePath(runRoot, declaration?.path) !== expectedReceiptPath) throw new Error(`Execution receipt order/path drifted for ${stage.id}.`);
    const receiptBytes = await readBoundFile(expectedReceiptPath, declaration, `Execution receipt ${stage.id}`);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    if (receipt?.schemaVersion !== 2 || receipt.kind !== 'aimuse-witnessed-command-execution' || receipt.acceptanceVerdict !== null || receipt.stageId !== stage.id) throw new Error(`Execution receipt schema is invalid for ${stage.id}.`);
    assertExactKeys(receipt, [...EXECUTION_RECEIPT_BASE_FIELDS, ...(stage.packageSubjectRequired ? ['packageSubject'] : [])], `Execution receipt ${stage.id}`);
    const receiptJudgements = forbiddenJudgementKeys({ ...receipt, acceptanceVerdict: undefined });
    if (receiptJudgements.length) throw new Error(`Execution receipt contains forbidden judgement fields for ${stage.id}: ${receiptJudgements.join(', ')}`);
    if (receipt.declaredInputs?.sha256 !== inputDigest || relativeEvidencePath(runRoot, receipt.declaredInputs?.path) !== inputPath || receipt.contract?.sha256 !== inputs.contract.sha256 || receipt.contract?.path !== inputs.contract.path) throw new Error(`Execution receipt input/contract attribution drifted for ${stage.id}.`);
    assertExactKeys(receipt.declaredInputs, ['path', 'sha256'], `Execution receipt input binding ${stage.id}`);
    assertExactKeys(receipt.contract, ['path', 'sha256'], `Execution receipt contract binding ${stage.id}`);
    assertExactKeys(receipt.attribution, ['witnessPath', 'witnessSha256', 'witnessPid', 'childPid'], `Execution witness attribution ${stage.id}`);
    assertExactKeys(receipt.command, ['logical', 'executable', 'arguments'], `Witnessed command ${stage.id}`);
    assertExactKeys(receipt.termination, ['exitCode', 'signal'], `Witness termination ${stage.id}`);
    assertExactKeys(receipt.stdout, ['path', 'bytes', 'sha256'], `Witness stdout ${stage.id}`);
    assertExactKeys(receipt.stderr, ['path', 'bytes', 'sha256'], `Witness stderr ${stage.id}`);
    if (receipt.attribution?.witnessSha256 !== declaredWitness.sha256 || receipt.attribution?.witnessPath !== 'scripts/release-command-witness.mjs' || !Number.isSafeInteger(receipt.attribution?.witnessPid) || receipt.attribution.witnessPid <= 0 || !Number.isSafeInteger(receipt.attribution?.childPid) || receipt.attribution.childPid <= 0) throw new Error(`Execution witness attribution is invalid for ${stage.id}.`);
    if (stableStringify(receipt.command) !== stableStringify(expectedCommand(stage, inputs))) throw new Error(`Witnessed command differs from the declared contract for ${stage.id}.`);
    const expectedSubject = stage.packageSubjectRequired ? subjectBinding : undefined;
    if (stableStringify(receipt.environment) !== stableStringify(environmentFor(inputs, expectedSubject))) throw new Error(`Witnessed execution environment drifted for ${stage.id}.`);
    if (stage.packageSubjectRequired) {
      assertExactKeys(receipt.packageSubject, ['path', 'sha256'], `Witness package subject ${stage.id}`);
      if (receipt.packageSubject?.sha256 !== subjectBinding.sha256 || relativeEvidencePath(runRoot, receipt.packageSubject?.path) !== subjectPath) throw new Error(`Witnessed package binding drifted for ${stage.id}.`);
    } else if ('packageSubject' in receipt) throw new Error(`Pre-subject stage ${stage.id} contains an invalid package binding.`);
    validateTiming(receipt.timing, stage.id);
    if (receipt.termination?.exitCode !== 0 || receipt.termination?.signal !== null) throw new Error(`Witnessed stage ${stage.id} did not terminate successfully.`);
    for (const stream of ['stdout', 'stderr']) {
      const streamPath = relativeEvidencePath(runRoot, receipt[stream]?.path);
      await readBoundFile(streamPath, receipt[stream], `${stage.id} ${stream}`);
    }
    receiptIdentities.push({ stageId: stage.id, receiptSha256: declaration.sha256, witnessPid: receipt.attribution.witnessPid, childPid: receipt.attribution.childPid });
  }
  const packageResult = await (dependencies.verifyPackageSubject ?? verifyPackageSubject)({
    workspace: root,
    manifestPath: subjectPath,
    expectedManifestSha256: subjectBinding.sha256,
    formalRunRoot: runRoot,
    platform: process.platform,
    toolchain: inputs.toolchain.externalTools,
    executionEnvironment: inputs.executionEnvironment,
  });
  const requiredPackageAssertions = [
    'requiredRuntimeEntries', 'minimumComponentSizes', 'exactMcpToolSurface',
    'providerFreeProductBoundary', 'rendererAuthorityIsolation',
    ...(process.platform === 'darwin' ? ['macosBundleContract', 'repoOwnedIcon', 'deepStrictSignature'] : []),
  ];
  for (const assertion of requiredPackageAssertions) if (packageResult.assertions?.[assertion] !== true) throw new Error(`Independent package assertion was not earned: ${assertion}`);
  if (packageResult.manifest.subject.identitySha256 !== observations.packageSubject?.identitySha256 || stableStringify(packageResult.manifest.inputs) !== stableStringify(inputs.sourceInputs)) throw new Error('Package subject does not bind the caller-declared clean source identity.');
  const historicalPattern = /autonomous-output\/aimuse-corrected|\/private\/tmp\/aimuse-correction/iu;
  if (historicalPattern.test(observationBytes.toString('utf8')) || historicalPattern.test(inputBytes.toString('utf8')) || historicalPattern.test(JSON.stringify(packageResult.manifest))) throw new Error('Fresh release evidence depends on excluded historical candidate material.');
  const report = {
    schemaVersion: 2,
    reportKind: 'independently-derived-automated-release-verification',
    verdict: 'AUTOMATED_GATES_PASS',
    levelCertification: 'PENDING_INDEPENDENT_MCP_AND_COMPUTER_USE',
    eligibleForIndependentCertification: true,
    verifierSha256,
    witnessSha256: declaredWitness.sha256,
    declaredInputsSha256: inputDigest,
    observationManifestSha256: sha256Bytes(observationBytes),
    source: {
      commit: packageResult.manifest.inputs.gitHead,
      tree: packageResult.manifest.inputs.gitTree,
      manifestSha256: packageResult.manifest.inputs.sourceManifestSha256,
      entries: packageResult.manifest.inputs.workspaceInputFiles,
      entriesSha256: packageResult.manifest.inputs.workspaceInputsSha256,
    },
    package: {
      manifestSha256: subjectBinding.sha256,
      subjectIdentitySha256: packageResult.manifest.subject.identitySha256,
      executableSha256: packageResult.manifest.subject.files.applicationExecutable.sha256,
      applicationAsarSha256: packageResult.manifest.subject.files.applicationAsar.sha256,
      signature: packageResult.manifest.subject.signature.kind,
      architecture: packageResult.manifest.subject.architecture,
    },
    execution: { independentlyAttributed: true, receipts: receiptIdentities },
    checks: [
      'caller-declared-source-and-toolchain-inputs',
      'caller-pinned-verifier-and-execution-witness',
      'producer-has-no-acceptance-verdict',
      'protected-run-root-identity',
      'exact-contract-stage-execution-receipts',
      'declared-environment-and-tool-byte-bindings',
      'reproduced-installed-dependency-inventory',
      'reproduced-native-dependency-byte-inventory',
      'independent-package-byte-and-semantic-verification',
      'historical-candidate-material-excluded',
    ],
    limitations: [
      'AUTOMATED_GATES_PASS is not a Level 1 or Level 2 PASS.',
      'A full level result requires a distinct Luna/high tester, isolated MCP, native Computer Use, both cross-surface directions, cleanup, and final package re-verification.',
      'An ad-hoc signature does not earn Developer ID, Gatekeeper, notarization, stapling, updater, or distribution claims.',
    ],
  };
  assertExactKeys(report, contract.schemaFields.automatedVerification, 'Independent automated verification');
  return report;
}

async function main() {
  const values = parseCli(process.argv.slice(2));
  const runRoot = required(values, 'formal-run-root');
  const outputPath = resolve(required(values, 'output'));
  if (!strictChild(resolve(runRoot), outputPath)) throw new Error('Independent verification output must be a strict child of the formal run root.');
  const report = await verifyReleaseEvidence({
    workspace: values.get('workspace') || process.cwd(),
    formalRunRoot: runRoot,
    observationManifestPath: required(values, 'observations'),
    expectedObservationManifestSha256: required(values, 'expected-observations-sha256'),
    declaredInputsPath: required(values, 'declared-inputs'),
    expectedDeclaredInputsSha256: required(values, 'expected-declared-inputs-sha256'),
    expectedVerifierSha256: required(values, 'expected-verifier-sha256'),
    expectedWitnessSha256: required(values, 'expected-witness-sha256'),
  });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const artifact = await publishExclusive(outputPath, bytes);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 2, kind: 'aimuse-automated-verification-reference', verdict: report.verdict, levelCertification: report.levelCertification, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse independent release evidence verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
