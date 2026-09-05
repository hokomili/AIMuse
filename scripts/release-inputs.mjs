import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, constants, link, lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { captureSourceInputs } from './package-subject.mjs';
import { resolvePackagedE2eOutputSelection } from './playwright-output.mjs';
import { inventoryContentTree, resolveReleaseContentTrees } from './release-content-inventory.mjs';
import { inspectProtectedDirectory, inspectProtectedRunRoot } from './release-protected-root-verifier.mjs';

export const DECLARED_RELEASE_INPUTS_SCHEMA_VERSION = 2;
export const FORMAL_RELEASE_CONTRACT_PATH = 'scripts/formal-release-contract.json';
const PASSTHROUGH_ENVIRONMENT_KEYS = [
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'USER', 'LOGNAME', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'PATHEXT',
  'NUMBER_OF_PROCESSORS',
];
const FORBIDDEN_AMBIENT_KEYS = [
  'NODE_OPTIONS', 'NODE_PATH', 'AIMUSE_MACOS_SIGN_IDENTITY', 'AIMUSE_APPLE_ID',
  'AIMUSE_APPLE_APP_PASSWORD', 'AIMUSE_APPLE_TEAM_ID', 'AIMUSE_REQUIRE_MACOS_SIGNED',
  'AIMUSE_REQUIRE_MACOS_NOTARIZED',
];

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function posixRelative(root, candidate) { return relative(root, candidate).split(sep).join('/'); }
function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || value.split('/').includes('..')) throw new Error(`${label} contains an unsafe path: ${String(value)}`);
  return value;
}
function assertContractFields(value, fields, label) {
  if (!Array.isArray(fields) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) throw new Error(`${label} fields disagree with the formal release contract.`);
}
function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`${options.label ?? executable} failed while declaring release inputs: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result.stdout.trim();
}
async function publishExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite declared release input evidence: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}
async function assertMissing(path, label) {
  try { await lstat(path); throw new Error(`${label} already exists.`); }
  catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return; throw error; }
}
function executableCandidates(name, environment) {
  if (isAbsolute(name)) return [name];
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return (environment.PATH || '').split(delimiter).filter(Boolean).flatMap((directory) => extensions.map((extension) => join(directory, `${name}${extension}`)));
}
async function findExecutable(name, environment, required = true) {
  for (const candidate of executableCandidates(name, environment)) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); } catch { /* continue */ }
  }
  if (!required) return undefined;
  throw new Error(`Required release tool is not executable: ${name}`);
}
async function describeFile(role, requestedPath, version) {
  const selected = resolve(requestedPath);
  const canonicalPath = await realpath(selected);
  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new Error(`Declared release tool ${role} is not a regular file: ${selected}`);
  return {
    role,
    requestedPath: selected,
    canonicalPath,
    bytes: info.size,
    sha256: await sha256File(canonicalPath),
    ...(version === undefined ? {} : { version }),
  };
}
function npmCliFrom(environment) {
  const value = environment.AIMUSE_NPM_CLI || environment.npm_execpath;
  if (!value || !isAbsolute(value)) throw new Error('Release input declaration requires an absolute AIMUSE_NPM_CLI or npm_execpath.');
  return resolve(value);
}
function releaseEnvironment(environment, tools, paths, npmConfiguration) {
  const result = Object.fromEntries(PASSTHROUGH_ENVIRONMENT_KEYS.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
  const npmShimDirectory = resolve(paths.workspace, 'scripts', 'npm-shims');
  const toolPath = [npmShimDirectory, ...new Set(Object.values(tools).flatMap((tool) => [dirname(tool.requestedPath), dirname(tool.canonicalPath)]))].join(delimiter);
  return {
    ...result,
    HOME: paths.executionHome,
    ...(process.platform === 'win32' ? {
      USERPROFILE: paths.executionHome,
      LOCALAPPDATA: join(paths.executionHome, 'AppData', 'Local'),
      APPDATA: join(paths.executionHome, 'AppData', 'Roaming'),
      ComSpec: tools.scriptShell.requestedPath,
    } : {}),
    TMPDIR: paths.executionTemp,
    TEMP: paths.executionTemp,
    TMP: paths.executionTemp,
    XDG_CACHE_HOME: join(paths.executionHome, '.cache'),
    XDG_CONFIG_HOME: join(paths.executionHome, '.config'),
    PATH: toolPath,
    SHELL: tools.scriptShell.requestedPath,
    npm_config_script_shell: tools.scriptShell.requestedPath,
    npm_config_userconfig: npmConfiguration.user.path,
    npm_config_globalconfig: npmConfiguration.global.path,
    npm_config_cache: paths.npmCache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: npmConfiguration.user.path,
    GIT_CONFIG_SYSTEM: npmConfiguration.global.path,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    AIMUSE_NODE24_EXE: tools.node.canonicalPath,
    AIMUSE_NPM_CLI: tools.npm.canonicalPath,
    AIMUSE_CMAKE: tools.cmake.requestedPath,
    ...(tools.ninja ? { AIMUSE_NINJA: tools.ninja.requestedPath } : {}),
    ...(tools.make ? { AIMUSE_MAKE: tools.make.requestedPath } : {}),
    CC: tools.cCompiler.requestedPath,
    CXX: tools.cppCompiler.requestedPath,
    AIMUSE_RENDERER_BROWSER_EXECUTABLE: tools.rendererBrowser.requestedPath,
    AIMUSE_NATIVE_BUILD_DIR: paths.nativeBuildDirectory,
    AIMUSE_NATIVE_DIST_DIR: paths.nativeDistributionDirectory,
    AIMUSE_MINIAUDIO_SOURCE_DIR: paths.miniaudioSourceDirectory,
    AIMUSE_TARGET_ARCH: paths.architecture,
    AIMUSE_VERIFY_PACKAGE_ARCH: paths.architecture,
    AIMUSE_ENABLE_COREAUDIO: environment.AIMUSE_ENABLE_COREAUDIO ?? '1',
    AIMUSE_ENABLE_WASAPI: environment.AIMUSE_ENABLE_WASAPI ?? '1',
  };
}

async function materializeMiniaudio({ sourceDirectory, destination, revision, gitPath, environment, runRoot, publish }) {
  if (!sourceDirectory || !isAbsolute(sourceDirectory)) throw new Error('Release input declaration requires an absolute --miniaudio-source checkout.');
  const selected = resolve(sourceDirectory);
  const sourceInfo = await lstat(selected);
  const canonical = await realpath(selected);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || canonical !== selected) throw new Error('Declared miniaudio source must be a real canonical directory.');
  const head = run(gitPath, ['-C', canonical, 'rev-parse', 'HEAD'], { env: environment, label: 'miniaudio revision' });
  if (head.toLowerCase() !== revision.toLowerCase()) throw new Error(`Declared miniaudio checkout is ${head}, expected ${revision}.`);
  if (run(gitPath, ['-C', canonical, 'status', '--porcelain=v1', '--untracked-files=no'], { env: environment, label: 'miniaudio tracked status' }) !== '') throw new Error('Declared miniaudio checkout has modified tracked files.');
  const tree = run(gitPath, ['-C', canonical, 'ls-tree', '-r', '-z', 'HEAD'], { env: environment, label: 'miniaudio tracked tree' });
  const records = tree.split('\0').filter(Boolean);
  if (!records.length) throw new Error('Declared miniaudio checkout has no tracked files.');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const record of records) {
    const separator = record.indexOf('\t');
    const [mode, type] = record.slice(0, separator).split(' ');
    const path = safeRelativePath(record.slice(separator + 1), 'Miniaudio tree');
    if (separator < 0 || type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new Error(`Unsupported miniaudio tree entry: ${record}`);
    const sourcePath = resolve(canonical, ...path.split('/'));
    const destinationPath = resolve(destination, ...path.split('/'));
    if (!strictChild(canonical, sourcePath) || !strictChild(destination, destinationPath)) throw new Error(`Miniaudio tree entry escaped its boundary: ${path}`);
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Miniaudio tree entry is not a real file: ${path}`);
    const bytes = await readFile(sourcePath);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, bytes, { flag: 'wx', mode: mode === '100755' ? 0o500 : 0o400 });
    entries.push({ path, mode, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const inventory = {
    schemaVersion: 1,
    kind: 'aimuse-declared-native-dependency',
    dependency: 'miniaudio',
    revision: revision.toLowerCase(),
    files: entries.length,
    entriesSha256: sha256Bytes(Buffer.from(JSON.stringify(entries))),
    entries,
  };
  const artifact = await publish(join(runRoot, 'native-dependency-miniaudio.json'), Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`));
  return {
    revision: inventory.revision,
    sourceDirectory: posixRelative(runRoot, destination),
    files: inventory.files,
    entriesSha256: inventory.entriesSha256,
    inventory: { path: posixRelative(runRoot, artifact.path), bytes: artifact.bytes, sha256: artifact.sha256 },
  };
}

async function externalToolchain(environment) {
  const nodePath = await realpath(process.execPath);
  const npmCli = npmCliFrom(environment);
  const xcrunPath = process.platform === 'darwin' ? await findExecutable('xcrun', environment) : undefined;
  const gitPath = process.platform === 'darwin'
    ? run(xcrunPath, ['--find', 'git'], { label: 'xcrun git discovery' })
    : await findExecutable('git', environment);
  const cmakePath = environment.AIMUSE_CMAKE ? resolve(environment.AIMUSE_CMAKE) : await findExecutable(process.platform === 'win32' ? 'cmake.exe' : 'cmake', environment);
  const ninjaPath = environment.AIMUSE_NINJA ? resolve(environment.AIMUSE_NINJA) : await findExecutable(process.platform === 'win32' ? 'ninja.exe' : 'ninja', environment, false);
  const ctestPath = join(dirname(cmakePath), process.platform === 'win32' ? 'ctest.exe' : 'ctest');
  const scriptShellPath = process.platform === 'win32'
    ? resolve(environment.ComSpec || join(environment.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'))
    : '/bin/sh';
  const ccPath = environment.CC
    ? resolve(environment.CC)
    : process.platform === 'darwin' ? run(xcrunPath, ['--find', 'clang'], { label: 'xcrun clang discovery' }) : await findExecutable(process.platform === 'win32' ? 'cl.exe' : 'cc', environment);
  const cxxPath = environment.CXX
    ? resolve(environment.CXX)
    : process.platform === 'darwin' ? run(xcrunPath, ['--find', 'clang++'], { label: 'xcrun clang++ discovery' }) : await findExecutable(process.platform === 'win32' ? 'cl.exe' : 'c++', environment);
  const browserPath = environment.AIMUSE_RENDERER_BROWSER_EXECUTABLE || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? join(environment.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
      : await findExecutable('google-chrome', environment));
  const values = {
    node: await describeFile('node', nodePath, process.version),
    npm: await describeFile('npm', npmCli, run(nodePath, [npmCli, '--version'], { label: 'npm version' })),
    git: await describeFile('git', gitPath, run(gitPath, ['--version'], { label: 'git version' })),
    cmake: await describeFile('cmake', cmakePath, run(cmakePath, ['--version'], { label: 'CMake version' }).split(/\r?\n/u)[0]),
    ctest: await describeFile('ctest', ctestPath, run(ctestPath, ['--version'], { label: 'CTest version' }).split(/\r?\n/u)[0]),
    ...(ninjaPath ? { ninja: await describeFile('ninja', ninjaPath, run(ninjaPath, ['--version'], { label: 'Ninja version' })) } : {}),
    cCompiler: await describeFile('cCompiler', ccPath, run(ccPath, ['--version'], { label: 'C compiler version' }).split(/\r?\n/u)[0]),
    cppCompiler: await describeFile('cppCompiler', cxxPath, run(cxxPath, ['--version'], { label: 'C++ compiler version' }).split(/\r?\n/u)[0]),
    scriptShell: await describeFile('scriptShell', scriptShellPath),
    rendererBrowser: await describeFile('rendererBrowser', browserPath, run(browserPath, ['--version'], { label: 'renderer browser version' })),
  };
  for (const name of process.platform === 'darwin' ? ['codesign', 'lipo', 'plutil', 'xcrun', 'make'] : []) {
    const path = ['lipo', 'make'].includes(name)
      ? run(xcrunPath, ['--find', name], { label: `xcrun ${name} discovery` })
      : await findExecutable(name, environment);
    values[name] = await describeFile(name, path);
  }
  for (const [role, name] of process.platform === 'darwin' ? [['linker', 'ld'], ['archiver', 'ar'], ['ranlib', 'ranlib']] : []) {
    const path = run(xcrunPath, ['--find', name], { label: `xcrun ${name} discovery` });
    values[role] = await describeFile(role, path);
  }
  return values;
}

function dependencyInventory({ root, environment, tools }) {
  return Buffer.from(`${run(tools.node.canonicalPath, [tools.npm.canonicalPath, 'ls', '--all', '--json'], {
    cwd: root,
    env: { ...environment, PATH: environment.PATH },
    label: 'npm dependency inventory',
  })}\n`);
}

export function assertCleanDependencyInventory(bytes) {
  const inventory = JSON.parse(bytes.toString('utf8'));
  const problems = Array.isArray(inventory?.problems) ? inventory.problems.filter((value) => typeof value === 'string' && value.trim()) : [];
  const flagged = [];
  const visit = (value, path = '$') => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && (value.extraneous === true || value.invalid === true || value.missing === true)) flagged.push(path);
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, `${path}[${index}]`));
    else for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  visit(inventory);
  if (problems.length || flagged.length) throw new Error(`Installed dependency tree is not clean: ${[...problems, ...flagged].join('; ')}`);
  return inventory;
}

async function captureContentInventories({ workspace, runRoot, tools, contract, environment, publish }) {
  const roots = await resolveReleaseContentTrees({ workspace, tools, contract, environment });
  const declarations = {};
  for (const [role, value] of Object.entries(roots)) {
    const inventory = await inventoryContentTree({ role, root: value.root, allowedExternalRoots: value.allowedExternalRoots });
    const artifact = await publish(join(runRoot, `content-tree-${role}.json`), Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`));
    declarations[role] = {
      root: inventory.root,
      rootMode: inventory.rootMode,
      files: inventory.files,
      directories: inventory.directories,
      symlinks: inventory.symlinks,
      entriesSha256: inventory.entriesSha256,
      inventory: { path: posixRelative(runRoot, artifact.path), bytes: artifact.bytes, sha256: artifact.sha256 },
    };
  }
  return declarations;
}

function parseContract(bytes, level) {
  const contract = JSON.parse(bytes.toString('utf8'));
  if (contract?.schemaVersion !== 2 || contract.kind !== 'aimuse-formal-release-contract') throw new Error('Formal release contract schema is unsupported.');
  if (!contract.certification?.[String(level)] || !Array.isArray(contract.stages?.base)) throw new Error(`Formal release contract does not declare Level ${level}.`);
  if (!Array.isArray(contract.declaredTooling?.controlPaths) || !contract.declaredTooling?.javascriptTools || !contract.declaredTooling?.contentTrees || !contract.declaredTooling?.darwinContentTrees || !/^[a-f\d]{40}$/u.test(contract.declaredTooling?.nativeDependencies?.miniaudio?.revision ?? '') || !Array.isArray(contract.schemaFields?.declaredInputs)) throw new Error('Formal release contract does not declare its complete tooling, content-tree, native dependency, and schema boundary.');
  return contract;
}

export async function declareReleaseInputs({
  workspace = process.cwd(), environment = process.env, level, formalRunRoot,
  forgeOutDirectory, playwrightOutputDirectory, subjectManifestPath, manifestPath,
  implementationTaskId, miniaudioSourceDirectory, executionTempDirectory,
  publish = publishExclusive, captureSource = captureSourceInputs,
  captureToolchain = externalToolchain, captureDependencyInventory = dependencyInventory,
  captureNativeDependency = materializeMiniaudio, captureToolContent = captureContentInventories,
  inspectRunRoot = inspectProtectedRunRoot, inspectExecutionTemp = inspectProtectedDirectory,
  resolvePlaywrightPaths = resolvePackagedE2eOutputSelection,
} = {}) {
  if (level !== 1 && level !== 2) throw new Error('Declared release inputs support Level 1 or Level 2.');
  if (FORBIDDEN_AMBIENT_KEYS.some((key) => environment[key])) throw new Error('Signing, notarization, NODE_OPTIONS, and NODE_PATH must be absent from this declared ad-hoc Level 1/2 input profile.');
  for (const key of ['AIMUSE_ENABLE_COREAUDIO', 'AIMUSE_ENABLE_WASAPI']) if (environment[key] !== undefined && !['0', '1'].includes(environment[key])) throw new Error(`${key} must be 0 or 1 when declared.`);
  if (typeof implementationTaskId !== 'string' || !implementationTaskId.trim()) throw new Error('An implementation task ID is required for independent tester attribution.');
  const root = resolve(workspace);
  const runRoot = resolve(formalRunRoot ?? '');
  const forgeOut = resolve(forgeOutDirectory ?? '');
  const subjectPath = resolve(subjectManifestPath ?? join(runRoot, 'package-subject.json'));
  const selectedManifest = resolve(manifestPath ?? join(runRoot, 'declared-release-inputs.json'));
  if (!executionTempDirectory || !isAbsolute(executionTempDirectory)) throw new Error('Execution temporary directory must be a caller-declared absolute protected directory.');
  const executionTemp = resolve(executionTempDirectory);
  if (!formalRunRoot || !strictChild(resolve(root, 'test-results', 'luna-high'), runRoot)) throw new Error('Formal run root must be a strict run-scoped child below test-results/luna-high.');
  if (!forgeOutDirectory || !strictChild(runRoot, forgeOut)) throw new Error('Forge output must be a strict child of the formal run root.');
  if (!strictChild(runRoot, subjectPath) || !strictChild(runRoot, selectedManifest)) throw new Error('Declared input and package subject manifests must be strict children of the formal run root.');
  if (within(root, executionTemp) || within(executionTemp, root)) throw new Error('Execution temporary directory must be disjoint from the workspace so Electron Packager never copies into its source tree.');
  const protectedRunRoot = await inspectRunRoot({ workspace: root, formalRunRoot: runRoot });
  const protectedExecutionTemp = await inspectExecutionTemp({ directory: executionTemp });
  if (protectedExecutionTemp.identity?.canonicalPath !== executionTemp) throw new Error('Execution temporary directory must use its canonical path.');
  if ((await readdir(runRoot)).length !== 0) throw new Error('Formal run root must be empty before release input declaration.');
  if ((await readdir(executionTemp)).length !== 0) throw new Error('Execution temporary directory must be empty before release input declaration.');
  const executionHome = join(runRoot, 'execution-home');
  const npmCache = join(runRoot, 'npm-cache');
  const npmUserConfigPath = join(runRoot, 'npm-user-config');
  const npmGlobalConfigPath = join(runRoot, 'npm-global-config');
  const nativeBuildDirectory = join(runRoot, 'native-build');
  // Electron Packager preserves the basename of extraResource directories.
  // Keep the declared fresh output named `native` so the packaged location is
  // exactly Contents/Resources/native on every formal run.
  const nativeDistributionDirectory = join(runRoot, 'native');
  const miniaudioSourceDirectoryInRoot = join(runRoot, 'declared-inputs', 'miniaudio');
  const workspaceViteOutputDirectory = join(root, '.vite');
  await Promise.all([
    assertMissing(forgeOut, 'Forge output'),
    assertMissing(subjectPath, 'Package subject manifest'),
    assertMissing(selectedManifest, 'Declared release inputs'),
    assertMissing(executionHome, 'Isolated execution home'),
    assertMissing(npmCache, 'Isolated npm cache'),
    assertMissing(npmUserConfigPath, 'Isolated npm user configuration'),
    assertMissing(npmGlobalConfigPath, 'Isolated npm global configuration'),
    assertMissing(nativeBuildDirectory, 'Native build output'),
    assertMissing(nativeDistributionDirectory, 'Native distribution output'),
    assertMissing(miniaudioSourceDirectoryInRoot, 'Declared miniaudio input'),
    assertMissing(workspaceViteOutputDirectory, 'Workspace Vite output'),
  ]);
  const playwright = resolvePlaywrightPaths({
    workspace: root,
    environment: { ...environment, AIMUSE_FORMAL_RUN_ROOT: runRoot, AIMUSE_PLAYWRIGHT_E2E_OUTPUT_DIR: playwrightOutputDirectory },
  });
  await Promise.all([
    assertMissing(playwright.outputDir, 'Packaged Playwright output'),
    assertMissing(playwright.htmlReportDir, 'Packaged Playwright HTML report'),
  ]);
  const contractPath = resolve(root, FORMAL_RELEASE_CONTRACT_PATH);
  const contractBytes = await readFile(contractPath);
  const contract = parseContract(contractBytes, level);
  const tools = await captureToolchain(environment);
  const paths = {
    workspace: root,
    formalRunRoot: runRoot,
    forgeOutDirectory: forgeOut,
    packageSubjectManifest: subjectPath,
    packagedPlaywrightOutput: playwright.outputDir,
    packagedPlaywrightHtmlReport: playwright.htmlReportDir,
    rendererPlaywrightOutput: join(runRoot, 'renderer-playwright'),
    workspaceViteOutputDirectory,
    executionHome,
    executionTemp,
    npmCache,
    nativeBuildDirectory,
    nativeDistributionDirectory,
    miniaudioSourceDirectory: miniaudioSourceDirectoryInRoot,
    architecture: environment.AIMUSE_VERIFY_PACKAGE_ARCH || process.arch,
  };
  await Promise.all([
    mkdir(executionHome, { mode: 0o700 }),
    mkdir(npmCache, { mode: 0o700 }),
  ]);
  const [npmUserConfig, npmGlobalConfig] = await Promise.all([
    publish(npmUserConfigPath, Buffer.alloc(0)),
    publish(npmGlobalConfigPath, Buffer.alloc(0)),
  ]);
  const npmConfiguration = { user: npmUserConfig, global: npmGlobalConfig };
  const executionEnvironment = releaseEnvironment(environment, tools, paths, npmConfiguration);
  const sourceInputs = await captureSource(root, { gitPath: tools.git.canonicalPath, gitEnvironment: executionEnvironment });
  const miniaudio = await captureNativeDependency({
    sourceDirectory: miniaudioSourceDirectory,
    destination: miniaudioSourceDirectoryInRoot,
    revision: contract.declaredTooling.nativeDependencies.miniaudio.revision,
    gitPath: tools.git.canonicalPath,
    environment: executionEnvironment,
    runRoot,
    publish,
  });
  const controls = {};
  for (const path of contract.declaredTooling.controlPaths) controls[path] = await describeFile(path, resolve(root, path));
  const javascriptTools = {};
  for (const [role, path] of Object.entries(contract.declaredTooling.javascriptTools)) javascriptTools[role] = await describeFile(role, resolve(root, path));
  const dependencyInventoryBytes = await captureDependencyInventory({ root, environment: executionEnvironment, tools });
  assertCleanDependencyInventory(dependencyInventoryBytes);
  const dependencyInventory = await publish(join(runRoot, 'dependency-inventory.json'), dependencyInventoryBytes);
  const contentInventories = await captureToolContent({ workspace: root, runRoot, tools, contract, environment: executionEnvironment, publish });
  const manifest = {
    schemaVersion: DECLARED_RELEASE_INPUTS_SCHEMA_VERSION,
    kind: 'aimuse-declared-release-inputs',
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    level,
    implementationTaskId: implementationTaskId.trim(),
    expectedIndependentTester: { model: 'gpt-5.6-luna', reasoningEffort: 'high', distinctTaskRequired: true },
    protectedRunRoot: {
      identity: protectedRunRoot.identity,
      owner: protectedRunRoot.owner,
      allowedPrincipals: protectedRunRoot.allowedPrincipals,
    },
    protectedExecutionTemp: {
      identity: protectedExecutionTemp.identity,
      owner: protectedExecutionTemp.owner,
      allowedPrincipals: protectedExecutionTemp.allowedPrincipals,
    },
    sourceInputs,
    paths,
    contract: { path: FORMAL_RELEASE_CONTRACT_PATH, bytes: contractBytes.length, sha256: sha256Bytes(contractBytes) },
    controls,
    toolchain: {
      platform: process.platform,
      architecture: process.arch,
      externalTools: tools,
      javascriptTools,
      contentInventories,
      dependencyInventory: {
        path: posixRelative(runRoot, dependencyInventory.path),
        bytes: dependencyInventory.bytes,
        sha256: dependencyInventory.sha256,
      },
      npmConfiguration: {
        user: { path: posixRelative(runRoot, npmUserConfig.path), bytes: npmUserConfig.bytes, sha256: npmUserConfig.sha256 },
        global: { path: posixRelative(runRoot, npmGlobalConfig.path), bytes: npmGlobalConfig.bytes, sha256: npmGlobalConfig.sha256 },
      },
      nativeDependencies: { miniaudio },
    },
    executionEnvironment,
  };
  assertContractFields(manifest, contract.schemaFields.declaredInputs, 'Declared release input');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const artifact = await publish(selectedManifest, bytes);
  return { manifest, manifestPath: artifact.path, manifestSha256: artifact.sha256 };
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

async function main() {
  const values = parseCli(process.argv.slice(2));
  const npmCli = values.get('npm-cli');
  const result = await declareReleaseInputs({
    workspace: values.get('workspace') || process.cwd(),
    environment: { ...process.env, ...(npmCli ? { AIMUSE_NPM_CLI: resolve(npmCli) } : {}) },
    level: Number(required(values, 'level')),
    formalRunRoot: required(values, 'formal-run-root'),
    forgeOutDirectory: required(values, 'forge-out-dir'),
    playwrightOutputDirectory: required(values, 'playwright-output-dir'),
    subjectManifestPath: values.get('package-subject-manifest'),
    manifestPath: values.get('manifest'),
    implementationTaskId: required(values, 'implementation-task-id'),
    miniaudioSourceDirectory: required(values, 'miniaudio-source'),
    executionTempDirectory: required(values, 'execution-temp-dir'),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 2,
    kind: 'aimuse-declared-release-input-reference',
    acceptanceVerdict: null,
    manifestPath: result.manifestPath,
    manifestSha256: result.manifestSha256,
    source: {
      commit: result.manifest.sourceInputs.gitHead,
      tree: result.manifest.sourceInputs.gitTree,
      entries: result.manifest.sourceInputs.workspaceInputFiles,
      entriesSha256: result.manifest.sourceInputs.workspaceInputsSha256,
    },
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse release input declaration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
