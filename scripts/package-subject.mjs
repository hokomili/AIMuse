import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

export const SUBJECT_SCHEMA_VERSION = 2;
export const SOURCE_BOUNDARY_MANIFEST = 'scripts/initial-snapshot-manifest.json';
const FILE_ROLES = ['applicationExecutable', 'applicationAsar', 'audioHelper', 'pluginScanner', 'pluginBridge'];
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
export async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function run(command, arguments_, cwd, environment) {
  const result = spawnSync(command, arguments_, { cwd, env: environment, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${arguments_.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result.stdout;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
}
export function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
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

export function resolveSubjectManifestPath({ workspace = process.cwd(), manifestPath, formalRunRoot, now = new Date(), pid = process.pid } = {}) {
  const root = resolve(workspace);
  const evidenceRoot = resolve(root, 'test-results');
  const artifactRoot = resolve(root, 'out', 'formal-subjects');
  const declaredRunRoot = formalRunRoot ? resolve(formalRunRoot) : undefined;
  if (declaredRunRoot && !strictChild(evidenceRoot, declaredRunRoot)) throw new Error(`AIMUSE_FORMAL_RUN_ROOT must be a run-scoped child below ${evidenceRoot}.`);
  const selected = manifestPath
    ? resolve(manifestPath)
    : declaredRunRoot
      ? join(declaredRunRoot, 'package-subject.json')
      : join(artifactRoot, `${now.toISOString().replaceAll(/[^\dA-Z]/giu, '')}-${pid}`, 'package-subject.json');
  const allowed = (declaredRunRoot && strictChild(declaredRunRoot, selected)) || strictChild(artifactRoot, selected);
  if (!allowed) throw new Error('Package subject manifest must be below the declared formal run root or out/formal-subjects.');
  return selected;
}

function sourceManifestEntry(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || value.split('/').includes('..') || posix.normalize(value) !== value) {
    throw new Error(`${label} contains an unsafe source path: ${String(value)}`);
  }
  return value;
}

async function sourceBoundary(workspace) {
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
  const declaredRoots = [...rootFiles, ...files, ...trees];
  if (new Set(declaredRoots).size !== declaredRoots.length) throw new Error('The source boundary manifest contains duplicate declarations.');
  for (const path of declaredRoots) {
    if (neverTrackRootNames.has(path.split('/')[0])) throw new Error(`The source boundary manifest enters protected root ${path}.`);
  }

  for (const path of [...rootFiles, ...files]) {
    const info = await lstat(resolve(workspace, ...path.split('/')));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Manifest source input must be a real file: ${path}`);
  }
  for (const tree of trees) {
    const info = await lstat(resolve(workspace, ...tree.split('/')));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Manifest source tree must be a real directory: ${tree}`);
  }
  const literalPaths = [...rootFiles, ...files];
  const authorizes = (path) => literalPaths.includes(path) || trees.some((tree) => path.startsWith(`${tree}/`));
  if (!authorizes(SOURCE_BOUNDARY_MANIFEST)) throw new Error('The source boundary manifest must include its own bytes through an authorized declaration.');
  return {
    manifest,
    manifestSha256: sha256Bytes(manifestBytes),
    pathspecs: declaredRoots,
    literalPaths,
    trees,
    authorizes,
  };
}

async function digestWorkspaceFile(workspace, path) {
  const absolute = resolve(workspace, path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Manifest source input must remain a real file: ${path}`);
  const content = await readFile(absolute);
  return { path, mode: info.mode & 0o7777, bytes: content.length, sha256: sha256Bytes(content) };
}

export async function captureSourceInputs(workspace = process.cwd(), { gitPath = 'git', gitEnvironment } = {}) {
  const root = resolve(workspace);
  const boundary = await sourceBoundary(root);
  const head = run(gitPath, ['rev-parse', 'HEAD'], root, gitEnvironment).trim();
  const tree = run(gitPath, ['rev-parse', 'HEAD^{tree}'], root, gitEnvironment).trim();
  const branch = run(gitPath, ['branch', '--show-current'], root, gitEnvironment).trim();
  const scopedArguments = ['--', ...boundary.pathspecs];
  const index = run(gitPath, ['ls-files', '--stage', '-z', ...scopedArguments], root, gitEnvironment);
  const status = run(gitPath, ['status', '--short', '--untracked-files=all', '-z', ...scopedArguments], root, gitEnvironment);
  if (status.length !== 0) throw new Error('A formal package requires every manifest-authorized source input to be clean and committed.');
  const headPaths = run(gitPath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', ...scopedArguments], root, gitEnvironment).split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(headPaths).size !== headPaths.length || headPaths.some((path) => !boundary.authorizes(path))) throw new Error('The clean commit source set escapes the declared source manifest.');
  for (const path of boundary.literalPaths) if (!headPaths.includes(path)) throw new Error(`Declared source file is not committed at HEAD: ${path}`);
  for (const tree of boundary.trees) if (!headPaths.some((path) => path.startsWith(`${tree}/`))) throw new Error(`Declared source tree has no committed files at HEAD: ${tree}`);
  if (!headPaths.includes(SOURCE_BOUNDARY_MANIFEST)) throw new Error('The committed source set does not contain its boundary manifest.');
  const entries = [];
  for (const path of headPaths) entries.push(await digestWorkspaceFile(root, path));
  const entriesSha256 = sha256Bytes(Buffer.from(stableStringify(entries)));
  return {
    scope: 'manifest-authorized-clean-commit',
    sourceManifestPath: SOURCE_BOUNDARY_MANIFEST,
    sourceManifestSha256: boundary.manifestSha256,
    sourceManifestVersion: boundary.manifest.version,
    rootWasEnumerated: false,
    protectedRootsAccessed: false,
    gitHead: head,
    gitTree: tree,
    gitBranch: branch,
    indexSha256: sha256Bytes(Buffer.from(index)),
    dirtyStatusSha256: sha256Bytes(Buffer.from(status)),
    workspaceInputsSha256: entriesSha256,
    workspaceInputFiles: entries.length,
    entries,
  };
}

export function assertSourceInputsStable(before, after) {
  if (stableStringify(before) !== stableStringify(after)) throw new Error('Source/branch/input identity drifted during formal automation before the package subject was frozen.');
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
function signatureField(text, key) { return text.split(/\r?\n/u).find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1); }

async function inspectPackage({ platform, architecture, locations }) {
  const wire = await getCurrentFuseWire(locations.files.applicationExecutable);
  const fuses = Object.fromEntries([...EXPECTED_FUSES].map(([option, expected]) => {
    if (wire[option] !== expected) throw new Error(`Electron fuse ${FuseV1Options[option]} does not match the hardened package contract.`);
    return [FuseV1Options[option], expected === FuseState.ENABLE ? 'enabled' : 'disabled'];
  }));
  if (platform !== 'darwin') return {
    architectures: Object.fromEntries(FILE_ROLES.filter((role) => role !== 'applicationAsar').map((role) => [role, [architecture]])),
    signature: { kind: 'not-inspected', valid: null },
    bundle: { identifier: 'aimuse', name: 'AIMuse' },
    hardenedFuses: fuses,
  };
  const architectures = Object.fromEntries(FILE_ROLES.filter((role) => role !== 'applicationAsar').map((role) => [role, macArchitectures(locations.files[role])]));
  const description = spawnSync('codesign', ['-dvvv', locations.app], { encoding: 'utf8', shell: false });
  const signatureText = `${description.stdout || ''}${description.stderr || ''}`;
  const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', locations.app], { encoding: 'utf8', shell: false });
  if (description.error || description.status !== 0 || verification.error || verification.status !== 0) throw new Error('The post-package macOS subject does not have a valid code signature.');
  const requirement = spawnSync('codesign', ['-dr', '-', locations.app], { encoding: 'utf8', shell: false });
  const infoPlist = join(locations.app, 'Contents', 'Info.plist');
  return {
    architectures,
    signature: {
      kind: signatureText.includes('Signature=adhoc') ? 'ad-hoc' : 'identity',
      valid: true,
      identifier: signatureField(signatureText, 'Identifier') ?? null,
      teamIdentifier: signatureField(signatureText, 'TeamIdentifier') ?? null,
      designatedRequirementSha256: requirement.status === 0 ? sha256Bytes(Buffer.from(`${requirement.stdout || ''}${requirement.stderr || ''}`)) : null,
    },
    bundle: { identifier: plistValue(infoPlist, 'CFBundleIdentifier'), name: plistValue(infoPlist, 'CFBundleName') },
    hardenedFuses: fuses,
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
  const info = await stat(path);
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

async function publishExclusive(path, bytes) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, path); }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing package subject evidence: ${path}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function assertPublicationPath(selectedManifest, workspace, formalRunRoot) {
  const allowedRoot = formalRunRoot ? resolve(formalRunRoot) : resolve(workspace, 'out', 'formal-subjects');
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(dirname(selectedManifest), { recursive: true });
  const [realAllowedRoot, realParent] = await Promise.all([realpath(allowedRoot), realpath(dirname(selectedManifest))]);
  if (!strictChild(realAllowedRoot, realParent) && realAllowedRoot !== realParent) throw new Error('Package subject manifest parent escapes its approved evidence root through a symbolic link.');
}

export async function createPackageSubject({
  workspace = process.cwd(), manifestPath, formalRunRoot, sourceInputs,
  platform = process.platform, architecture = process.env.AIMUSE_VERIFY_PACKAGE_ARCH || process.arch,
  outDirectory = process.env.AIMUSE_FORGE_OUT_DIR || 'out', inspect = inspectPackage,
} = {}) {
  const root = resolve(workspace);
  const selectedManifest = resolveSubjectManifestPath({ workspace: root, manifestPath, formalRunRoot });
  const locations = packageLocations(root, platform, architecture, resolve(root, outDirectory));
  const files = Object.fromEntries(await Promise.all(FILE_ROLES.map(async (role) => [role, await describeFile(root, locations.files[role])])));
  const inspected = await inspect({ platform, architecture, locations });
  assertInspectionContract(platform, architecture, inspected);
  const subject = {
    platform,
    architecture,
    packageDirectory: relativeSubjectPath(root, locations.packageDirectory),
    app: relativeSubjectPath(root, locations.app),
    files,
    ...inspected,
  };
  subject.identitySha256 = subjectIdentity(subject);
  const manifest = {
    schemaVersion: SUBJECT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    acceptanceVerdict: null,
    inputs: sourceInputs ?? await captureSourceInputs(root),
    subject,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await assertPublicationPath(selectedManifest, root, formalRunRoot);
  await publishExclusive(selectedManifest, bytes);
  return { manifest, manifestPath: selectedManifest, manifestSha256: sha256Bytes(bytes) };
}

function parseCli(arguments_) {
  const [command, ...rest] = arguments_;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const key = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const value = equals >= 0 ? argument.slice(equals + 1) : rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseCli(process.argv.slice(2));
  const manifestPath = values.get('manifest') || process.env.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const formalRunRoot = values.get('formal-run-root') || process.env.AIMUSE_FORMAL_RUN_ROOT;
  if (command === 'create') {
    const result = await createPackageSubject({ manifestPath, formalRunRoot });
    process.stdout.write(`${JSON.stringify({ created: true, manifestPath: result.manifestPath, manifestSha256: result.manifestSha256, subjectIdentitySha256: result.manifest.subject.identitySha256 }, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: node scripts/package-subject.mjs create --manifest <path> [--formal-run-root <path>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`AIMuse package subject failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
