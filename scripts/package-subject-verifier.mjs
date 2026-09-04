import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, lstat, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { extractFile, listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { inspectProtectedRunRoot } from './release-protected-root-verifier.mjs';

const SUBJECT_SCHEMA_VERSION = 2;
const SOURCE_BOUNDARY_MANIFEST = 'scripts/initial-snapshot-manifest.json';
const FILE_ROLES = ['applicationExecutable', 'applicationAsar', 'audioHelper', 'pluginScanner', 'pluginBridge'];
const EXPECTED_MCP_TOOLS = [
  'aimuse_help', 'export_manage', 'history_manage', 'job_manage', 'media_manage', 'plugin_manage',
  'project_apply', 'project_manage', 'project_observe', 'session_manage', 'trace_replay', 'transport_manage',
];
const EXPECTED_FUSES = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${arguments_.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result.stdout;
}
function sourceManifestEntry(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || value.split('/').includes('..') || posix.normalize(value) !== value) {
    throw new Error(`${label} contains an unsafe source path: ${String(value)}`);
  }
  return value;
}

async function enumerateSourceBoundary(workspace) {
  const manifestPath = resolve(workspace, SOURCE_BOUNDARY_MANIFEST);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.version !== 1) throw new Error('The source boundary manifest schema is unsupported.');
  const groups = ['rootFiles', 'files', 'trees', 'neverTrackRootNames'];
  for (const group of groups) if (!Array.isArray(manifest[group])) throw new Error(`The source boundary manifest is missing ${group}.`);
  const rootFiles = manifest.rootFiles.map((path) => sourceManifestEntry(path, 'rootFiles'));
  const files = manifest.files.map((path) => sourceManifestEntry(path, 'files'));
  const trees = manifest.trees.map((path) => sourceManifestEntry(path, 'trees'));
  const neverTrackRootNames = new Set(manifest.neverTrackRootNames.map((path) => sourceManifestEntry(path, 'neverTrackRootNames')));
  const pathspecs = [...rootFiles, ...files, ...trees];
  if (new Set(pathspecs).size !== pathspecs.length) throw new Error('The source boundary manifest contains duplicate declarations.');
  for (const path of pathspecs) if (neverTrackRootNames.has(path.split('/')[0])) throw new Error(`The source boundary manifest enters protected root ${path}.`);

  for (const path of [...rootFiles, ...files]) {
    const info = await lstat(resolve(workspace, ...path.split('/')));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Manifest source input must be a real file: ${path}`);
  }
  for (const tree of trees) {
    const info = await lstat(resolve(workspace, ...tree.split('/')));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Manifest source tree must be a real directory: ${tree}`);
  }
  const literalPaths = [...rootFiles, ...files];
  const includesPath = (path) => literalPaths.includes(path) || trees.some((tree) => path.startsWith(`${tree}/`));
  if (!includesPath(SOURCE_BOUNDARY_MANIFEST)) throw new Error('The source boundary manifest must include its own bytes through an authorized declaration.');
  return { manifest, manifestSha256: sha256Bytes(manifestBytes), literalPaths, trees, includesPath, pathspecs };
}

async function sourceEntry(workspace, path) {
  const absolute = resolve(workspace, ...path.split('/'));
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Manifest source input must remain a real file: ${path}`);
  const content = await readFile(absolute);
  return { path, mode: info.mode & 0o7777, bytes: content.length, sha256: sha256Bytes(content) };
}

async function observeSourceInputs(workspace) {
  const boundary = await enumerateSourceBoundary(workspace);
  const scopedArguments = ['--', ...boundary.pathspecs];
  const status = run('git', ['status', '--short', '--untracked-files=all', '-z', ...scopedArguments], workspace);
  if (status.length !== 0) throw new Error('Independent verification requires every manifest-authorized source input to be clean and committed.');
  const headPaths = run('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', ...scopedArguments], workspace).split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(headPaths).size !== headPaths.length || headPaths.some((path) => !boundary.includesPath(path))) throw new Error('The clean commit source set escapes the declared source manifest.');
  for (const path of boundary.literalPaths) if (!headPaths.includes(path)) throw new Error(`Declared source file is not committed at HEAD: ${path}`);
  for (const tree of boundary.trees) if (!headPaths.some((path) => path.startsWith(`${tree}/`))) throw new Error(`Declared source tree has no committed files at HEAD: ${tree}`);
  if (!headPaths.includes(SOURCE_BOUNDARY_MANIFEST)) throw new Error('The committed source set does not contain its boundary manifest.');
  const entries = [];
  for (const path of headPaths) entries.push(await sourceEntry(workspace, path));
  return {
    scope: 'manifest-authorized-clean-commit',
    sourceManifestPath: SOURCE_BOUNDARY_MANIFEST,
    sourceManifestSha256: boundary.manifestSha256,
    sourceManifestVersion: boundary.manifest.version,
    rootWasEnumerated: false,
    protectedRootsAccessed: false,
    gitHead: run('git', ['rev-parse', 'HEAD'], workspace).trim(),
    gitTree: run('git', ['rev-parse', 'HEAD^{tree}'], workspace).trim(),
    gitBranch: run('git', ['branch', '--show-current'], workspace).trim(),
    indexSha256: sha256Bytes(Buffer.from(run('git', ['ls-files', '--stage', '-z', ...scopedArguments], workspace))),
    dirtyStatusSha256: sha256Bytes(Buffer.from(status)),
    workspaceInputsSha256: sha256Bytes(Buffer.from(stableStringify(entries))),
    workspaceInputFiles: entries.length,
    entries,
  };
}

function sourceIdentity(value) {
  const identity = { ...value };
  delete identity.gitBranch;
  return identity;
}

function relativeSubjectPath(workspace, path) {
  const value = relative(workspace, path);
  if (!value || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) throw new Error(`Package subject path must stay below the workspace: ${path}`);
  return value.split(sep).join('/');
}
export function resolveSubjectPath(workspace, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error(`Invalid package subject relative path: ${String(path)}`);
  const candidate = resolve(workspace, path);
  if (!strictChild(resolve(workspace), candidate)) throw new Error(`Package subject path escaped the workspace: ${path}`);
  return candidate;
}
function packageLocations(workspace, platform, architecture, outDirectory) {
  const packageDirectory = join(outDirectory, `AIMuse-${platform}-${architecture}`);
  const app = platform === 'darwin' ? join(packageDirectory, 'AIMuse.app') : packageDirectory;
  const resources = platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(packageDirectory, 'resources');
  const extension = platform === 'win32' ? '.exe' : '';
  return {
    packageDirectory,
    app,
    resources,
    files: {
      applicationExecutable: platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'AIMuse') : join(packageDirectory, `AIMuse${extension}`),
      applicationAsar: join(resources, 'app.asar'),
      audioHelper: join(resources, 'native', `aimuse-audio${extension}`),
      pluginScanner: join(resources, 'native', `aimuse-plugin-scanner${extension}`),
      pluginBridge: join(resources, 'native', `aimuse-plugin-bridge${extension}`),
    },
  };
}
function macArchitectures(path) { return run('lipo', ['-archs', path]).trim().split(/\s+/u).filter(Boolean).sort(); }
function plistValue(path, key) { return run('plutil', ['-extract', key, 'raw', '-o', '-', path]).trim(); }
function plistHasKey(path, key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', path], { encoding: 'utf8', shell: false, windowsHide: true });
  return !result.error && result.status === 0;
}
function signatureField(text, key) { return text.split(/\r?\n/u).find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1); }

async function inspectPackage({ workspace, platform, architecture, locations }) {
  const wire = await getCurrentFuseWire(locations.files.applicationExecutable);
  const fuses = Object.fromEntries([...EXPECTED_FUSES].map(([option, expected]) => {
    if (wire[option] !== expected) throw new Error(`Electron fuse ${FuseV1Options[option]} does not match the hardened package contract.`);
    return [FuseV1Options[option], expected === FuseState.ENABLE ? 'enabled' : 'disabled'];
  }));
  const archiveFiles = listPackage(locations.files.applicationAsar, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'));
  for (const required of ['/.vite/build/main.js', '/.vite/build/playback-render-worker.js', '/.vite/build/preload.js']) {
    if (!archiveFiles.includes(required)) throw new Error(`Packaged runtime is missing ${required}.`);
  }
  const mainChunks = archiveFiles.filter((path) => /^\/\.vite\/build\/main-[^/]+\.js$/u.test(path));
  if (mainChunks.length !== 1) throw new Error('Packaged runtime does not contain exactly one first-party main-process chunk.');
  const mainSource = extractFile(locations.files.applicationAsar, mainChunks[0].slice(1)).toString('utf8');
  const toolNames = [...new Set([...mainSource.matchAll(/registerTool\(["']([^"']+)["']/gu)].map((match) => match[1]))].sort();
  if (stableStringify(toolNames) !== stableStringify(EXPECTED_MCP_TOOLS)) throw new Error('Packaged runtime does not expose the exact twelve-tool provider-free MCP contract.');
  const prohibitedSymbols = [
    'generation_manage', 'GenerationManager', 'setProviderCredential', 'CredentialStore', 'safeStorage',
    'providerCapabilities', 'candidateMediaUrl', 'provision-protected-storage', 'macos-protected-storage',
  ];
  for (const symbol of prohibitedSymbols) if (mainSource.includes(symbol)) throw new Error(`Packaged runtime contains prohibited product surface ${symbol}.`);
  const prohibitedArchiveNames = ['generation-manager', 'agent-client-config', 'credentials', 'protected-storage'];
  for (const name of prohibitedArchiveNames) if (archiveFiles.some((path) => path.toLocaleLowerCase('en-US').includes(name))) throw new Error(`Packaged archive contains prohibited runtime path ${name}.`);
  const preloadSource = extractFile(locations.files.applicationAsar, '.vite/build/preload.js').toString('utf8');
  if (preloadSource.includes('mcp:connection')) throw new Error('Packaged preload exposes prohibited MCP authority IPC.');
  const sizes = await Promise.all(FILE_ROLES.map(async (role) => [role, (await stat(locations.files[role])).size]));
  const sizeMap = Object.fromEntries(sizes);
  const minimumExecutableBytes = platform === 'darwin' ? 20_000 : 1_000_000;
  if (sizeMap.applicationExecutable < minimumExecutableBytes || sizeMap.applicationAsar < 1_000 || ['audioHelper', 'pluginScanner', 'pluginBridge'].some((role) => sizeMap[role] < 10_000)) {
    throw new Error('One or more packaged files are unexpectedly small.');
  }
  if (platform !== 'darwin') return {
    inspection: {
      architectures: Object.fromEntries(FILE_ROLES.filter((role) => role !== 'applicationAsar').map((role) => [role, [architecture]])),
      signature: { kind: 'not-inspected', valid: null },
      bundle: { identifier: 'aimuse', name: 'AIMuse' },
      hardenedFuses: fuses,
    },
    assertions: { requiredRuntimeEntries: true, minimumComponentSizes: true, exactMcpToolSurface: true, providerFreeProductBoundary: true, rendererAuthorityIsolation: true },
  };
  const architectures = Object.fromEntries(FILE_ROLES.filter((role) => role !== 'applicationAsar').map((role) => [role, macArchitectures(locations.files[role])]));
  const description = spawnSync('codesign', ['-dvvv', locations.app], { encoding: 'utf8', shell: false, windowsHide: true });
  const signatureText = `${description.stdout || ''}${description.stderr || ''}`;
  const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', locations.app], { encoding: 'utf8', shell: false, windowsHide: true });
  if (description.error || description.status !== 0 || verification.error || verification.status !== 0) throw new Error('The post-package macOS subject does not have a valid code signature.');
  const requirement = spawnSync('codesign', ['-dr', '-', locations.app], { encoding: 'utf8', shell: false, windowsHide: true });
  const infoPlist = join(locations.app, 'Contents', 'Info.plist');
  const bundle = { identifier: plistValue(infoPlist, 'CFBundleIdentifier'), name: plistValue(infoPlist, 'CFBundleName') };
  const iconFile = plistValue(infoPlist, 'CFBundleIconFile');
  const category = plistValue(infoPlist, 'LSApplicationCategoryType');
  const uiElement = plistValue(infoPlist, 'LSUIElement');
  const microphoneUsage = plistValue(infoPlist, 'NSMicrophoneUsageDescription');
  if (bundle.identifier !== 'com.aimuse.app' || bundle.name !== 'AIMuse' || !iconFile.endsWith('.icns') || category !== 'public.app-category.music' || uiElement !== 'true' || !microphoneUsage.includes('explicitly authorize')) {
    throw new Error('macOS bundle identity, background presentation, category or microphone disclosure does not match the package contract.');
  }
  for (const key of ['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription']) {
    if (plistHasKey(infoPlist, key)) throw new Error(`macOS bundle retains unused Electron usage description ${key}.`);
  }
  const packagedIcon = await readFile(join(locations.resources, iconFile));
  const expectedIcon = await readFile(resolve(workspace, 'build', 'icon.icns'));
  if (!packagedIcon.equals(expectedIcon)) throw new Error('macOS bundle did not embed the manifest-authorized AIMuse icon.');
  return {
    inspection: {
      architectures,
      signature: {
        kind: signatureText.includes('Signature=adhoc') ? 'ad-hoc' : 'identity',
        valid: true,
        identifier: signatureField(signatureText, 'Identifier') ?? null,
        teamIdentifier: signatureField(signatureText, 'TeamIdentifier') ?? null,
        designatedRequirementSha256: requirement.status === 0 ? sha256Bytes(Buffer.from(`${requirement.stdout || ''}${requirement.stderr || ''}`)) : null,
      },
      bundle,
      hardenedFuses: fuses,
    },
    assertions: {
      requiredRuntimeEntries: true,
      minimumComponentSizes: true,
      macosBundleContract: true,
      repoOwnedIcon: true,
      deepStrictSignature: true,
      exactMcpToolSurface: true,
      providerFreeProductBoundary: true,
      rendererAuthorityIsolation: true,
    },
  };
}

function assertInspectionContract(platform, architecture, inspected) {
  if (platform !== 'darwin') return;
  const expected = architecture === 'universal' ? ['arm64', 'x86_64'] : architecture === 'x64' ? ['x86_64'] : architecture === 'arm64' ? ['arm64'] : undefined;
  if (!expected) throw new Error(`Unsupported Darwin package subject architecture: ${architecture}`);
  for (const role of FILE_ROLES.filter((role) => role !== 'applicationAsar')) {
    if (stableStringify([...(inspected.architectures?.[role] ?? [])].sort()) !== stableStringify(expected)) throw new Error(`Package subject ${role} architectures do not exactly match ${architecture}.`);
  }
  if (inspected.signature?.valid !== true || !['ad-hoc', 'identity'].includes(inspected.signature.kind)) throw new Error('The Darwin package subject must have a valid ad-hoc or identity signature.');
}
async function describeFile(workspace, path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Package subject component must be a real file: ${path}`);
  return { path: relativeSubjectPath(workspace, path), bytes: info.size, sha256: await sha256File(path) };
}
function subjectIdentity(subject) {
  return sha256Bytes(Buffer.from(stableStringify({
    platform: subject.platform,
    architecture: subject.architecture,
    packageDirectory: subject.packageDirectory,
    app: subject.app,
    files: subject.files,
    architectures: subject.architectures,
    signature: subject.signature,
    bundle: subject.bundle,
    hardenedFuses: subject.hardenedFuses,
  })));
}
function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== SUBJECT_SCHEMA_VERSION || !manifest.inputs || !manifest.subject) throw new Error('Invalid AIMuse package subject manifest schema.');
  if (manifest.subject.identitySha256 !== subjectIdentity(manifest.subject)) throw new Error('Package subject identity digest does not match its declared metadata.');
  for (const role of FILE_ROLES) if (!manifest.subject.files?.[role]) throw new Error(`Package subject manifest is missing ${role}.`);
  if (manifest.acceptanceVerdict !== null) throw new Error('Package subject manifests may not store an acceptance verdict.');
}

export async function verifyPackageSubject({
  workspace = process.cwd(), manifestPath, expectedManifestSha256, formalRunRoot,
  platform = process.platform, inspect,
} = {}, dependencies = {}) {
  if (!manifestPath) throw new Error('A package subject manifest path is required.');
  if (!expectedManifestSha256 || !/^[A-F\d]{64}$/iu.test(expectedManifestSha256)) throw new Error('An expected package subject manifest SHA-256 is required.');
  const root = resolve(workspace);
  const selectedManifest = resolve(manifestPath);
  const bytes = await readFile(selectedManifest);
  const digest = sha256Bytes(bytes);
  if (digest !== expectedManifestSha256.toUpperCase()) throw new Error(`Package subject manifest byte digest drifted: expected ${expectedManifestSha256}, observed ${digest}.`);
  const manifest = JSON.parse(bytes.toString('utf8'));
  validateManifestShape(manifest);
  const observeSource = dependencies.observeSourceInputs ?? observeSourceInputs;
  const observedInputs = await observeSource(root);
  if (stableStringify(sourceIdentity(observedInputs)) !== stableStringify(sourceIdentity(manifest.inputs))) throw new Error('Manifest-authorized clean source identity drifted from the package subject.');
  if (manifest.subject.platform !== platform) throw new Error(`Package subject platform ${manifest.subject.platform} does not match ${platform}.`);
  const locations = packageLocations(root, manifest.subject.platform, manifest.subject.architecture, dirname(resolveSubjectPath(root, manifest.subject.packageDirectory)));
  if (relativeSubjectPath(root, locations.app) !== manifest.subject.app) throw new Error('Package subject app path does not match its platform/architecture package location.');
  for (const role of FILE_ROLES) {
    const declared = manifest.subject.files[role];
    const path = resolveSubjectPath(root, declared.path);
    if (path !== locations.files[role]) throw new Error(`Package subject ${role} path does not match its canonical package location.`);
    await access(path, role === 'applicationAsar' ? constants.R_OK : constants.R_OK | constants.X_OK);
    const observed = await describeFile(root, path);
    if (stableStringify(observed) !== stableStringify(declared)) throw new Error(`Package subject ${role} bytes drifted after manifest creation.`);
  }
  const inspectSubject = inspect ?? dependencies.inspectPackage ?? inspectPackage;
  const inspectedResult = await inspectSubject({ workspace: root, platform: manifest.subject.platform, architecture: manifest.subject.architecture, locations });
  const inspected = inspectedResult.inspection ?? inspectedResult;
  assertInspectionContract(manifest.subject.platform, manifest.subject.architecture, inspected);
  for (const key of ['architectures', 'signature', 'bundle', 'hardenedFuses']) if (stableStringify(inspected[key]) !== stableStringify(manifest.subject[key])) throw new Error(`Package subject ${key} drifted after manifest creation.`);
  const protectedRoot = formalRunRoot ? await inspectProtectedRunRoot({ workspace: root, formalRunRoot, paths: [selectedManifest] }) : undefined;
  return { manifest, manifestPath: selectedManifest, manifestSha256: digest, observedInputs, assertions: inspectedResult.assertions ?? {}, protectedRoot };
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

async function main() {
  const values = parseCli(process.argv.slice(2));
  const manifestPath = values.get('manifest') || process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const expectedManifestSha256 = values.get('expected-manifest-sha256') || process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  const formalRunRoot = values.get('formal-run-root') || process.env.AIMUSE_FORMAL_RUN_ROOT;
  const result = await verifyPackageSubject({ manifestPath, expectedManifestSha256, formalRunRoot });
  process.stdout.write(`${JSON.stringify({
    verified: true,
    verifier: 'independent-package-subject-verifier-v1',
    manifestPath: result.manifestPath,
    manifestSha256: result.manifestSha256,
    subjectIdentitySha256: result.manifest.subject.identitySha256,
    source: {
      commit: result.manifest.inputs.gitHead,
      tree: result.manifest.inputs.gitTree,
      manifestSha256: result.manifest.inputs.sourceManifestSha256,
      entries: result.manifest.inputs.workspaceInputFiles,
      entriesSha256: result.manifest.inputs.workspaceInputsSha256,
      rootWasEnumerated: false,
      protectedRootsAccessed: false,
    },
    assertions: result.assertions,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => {
  process.stderr.write(`AIMuse independent package subject verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
