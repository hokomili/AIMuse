import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
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
function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || value.split('/').includes('..')) throw new Error(`${label} contains an unsafe path: ${String(value)}`);
  return value;
}
function assertExactKeys(value, expected, label) {
  if (stableStringify(Object.keys(value ?? {}).sort()) !== stableStringify([...expected].sort())) throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`);
}
function runPath(command, arguments_, environment, label) {
  const result = spawnSync(command, arguments_, { env: environment, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${label} failed while resolving release content: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  const output = result.stdout.trim();
  if (!output || !isAbsolute(output)) throw new Error(`${label} did not return an absolute path.`);
  return resolve(output);
}

async function packageRootForTool(toolPath, packageName) {
  let current = dirname(resolve(toolPath));
  for (;;) {
    try {
      const packageJson = JSON.parse(await readFile(resolve(current, 'package.json'), 'utf8'));
      if (packageJson?.name === packageName) return realpath(current);
    } catch (error) {
      if (!error || typeof error !== 'object' || !['ENOENT', 'ENOTDIR', 'EISDIR', 'ERR_INVALID_ARG_TYPE'].includes(error.code)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not resolve package ${packageName} containing declared tool ${toolPath}.`);
}

function ancestor(path, levels, label) {
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > 8) throw new Error(`${label} has an invalid ancestor depth.`);
  let current = resolve(path);
  for (let index = 0; index < levels; index += 1) current = dirname(current);
  return current;
}

function containingDarwinBundle(path, label) {
  let current = resolve(path);
  for (;;) {
    if (basename(current).endsWith('.app')) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`${label} is not contained by a Darwin application bundle.`);
}

function browserRuntimeRoot(path, platform, label) {
  if (platform === 'darwin') return containingDarwinBundle(path, label);
  if (platform === 'win32') {
    let current = dirname(resolve(path));
    for (;;) {
      if (basename(current).toLowerCase() === 'application') return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    throw new Error(`${label} is not contained by a Windows browser Application directory.`);
  }
  const selected = dirname(resolve(path));
  if (selected === resolve(sep)) throw new Error(`${label} resolved to an unsafe browser runtime root.`);
  return selected;
}

function contentTreeSpecifications(contract, platform) {
  const required = contract?.declaredTooling?.contentTrees;
  const platformSpecific = platform === 'darwin' ? contract?.declaredTooling?.darwinContentTrees : {};
  if (!required || typeof required !== 'object' || Array.isArray(required) || !platformSpecific || typeof platformSpecific !== 'object' || Array.isArray(platformSpecific)) throw new Error('Formal release contract does not declare its content-tree boundary.');
  const specifications = { ...required, ...platformSpecific };
  if (!Object.keys(specifications).length) throw new Error('Formal release contract declares no build-affecting content trees.');
  return specifications;
}

export async function resolveReleaseContentTrees({ workspace, tools, contract, environment, platform = process.platform } = {}) {
  const root = resolve(workspace ?? '');
  const specifications = contentTreeSpecifications(contract, platform);
  const resolvedRoots = {};
  for (const [role, specification] of Object.entries(specifications)) {
    if (!/^[A-Za-z][A-Za-z\d]*$/u.test(role) || !specification || typeof specification !== 'object' || Array.isArray(specification)) throw new Error(`Invalid release content-tree declaration: ${role}`);
    const commonKeys = ['resolver', 'allowedExternalTreeRoles'];
    let selected;
    if (specification.resolver === 'workspace-relative') {
      assertExactKeys(specification, [...commonKeys, 'path'], `Content tree ${role}`);
      const path = safeRelativePath(specification.path, `Content tree ${role}`);
      selected = resolve(root, ...path.split('/'));
      if (!within(root, selected) || selected === root) throw new Error(`Content tree ${role} escaped the workspace.`);
    } else if (specification.resolver === 'package-containing-tool') {
      assertExactKeys(specification, [...commonKeys, 'toolRole', 'packageName'], `Content tree ${role}`);
      const tool = tools?.[specification.toolRole];
      if (!tool?.canonicalPath) throw new Error(`Content tree ${role} names an undeclared tool role.`);
      selected = await packageRootForTool(tool.canonicalPath, specification.packageName);
    } else if (specification.resolver === 'ancestor-of-tool') {
      assertExactKeys(specification, [...commonKeys, 'toolRole', 'levels'], `Content tree ${role}`);
      const tool = tools?.[specification.toolRole];
      if (!tool?.canonicalPath) throw new Error(`Content tree ${role} names an undeclared tool role.`);
      selected = ancestor(tool.canonicalPath, specification.levels, `Content tree ${role}`);
    } else if (specification.resolver === 'darwin-app-containing-tool') {
      assertExactKeys(specification, [...commonKeys, 'toolRole'], `Content tree ${role}`);
      if (platform !== 'darwin') throw new Error(`Darwin content tree ${role} was selected on ${platform}.`);
      const tool = tools?.[specification.toolRole];
      if (!tool?.canonicalPath) throw new Error(`Content tree ${role} names an undeclared tool role.`);
      selected = containingDarwinBundle(tool.canonicalPath, `Content tree ${role}`);
    } else if (specification.resolver === 'browser-runtime') {
      assertExactKeys(specification, [...commonKeys, 'toolRole'], `Content tree ${role}`);
      const tool = tools?.[specification.toolRole];
      if (!tool?.canonicalPath) throw new Error(`Content tree ${role} names an undeclared tool role.`);
      selected = browserRuntimeRoot(tool.canonicalPath, platform, `Content tree ${role}`);
    } else if (specification.resolver === 'tool-output') {
      assertExactKeys(specification, [...commonKeys, 'toolRole', 'arguments'], `Content tree ${role}`);
      const tool = tools?.[specification.toolRole];
      if (!tool?.canonicalPath || !Array.isArray(specification.arguments) || specification.arguments.some((value) => typeof value !== 'string')) throw new Error(`Content tree ${role} has an invalid tool-output resolver.`);
      selected = runPath(tool.canonicalPath, specification.arguments, environment, `Content tree ${role}`);
    } else {
      throw new Error(`Unsupported release content-tree resolver for ${role}: ${String(specification.resolver)}`);
    }
    const canonicalRoot = await realpath(selected);
    if (dirname(canonicalRoot) === canonicalRoot) throw new Error(`Release content tree ${role} resolved to an unsafe filesystem root.`);
    const info = await lstat(canonicalRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Release content tree ${role} must resolve to a real directory.`);
    if (specification.resolver === 'workspace-relative' && canonicalRoot !== selected) throw new Error(`Workspace content tree ${role} must use a real canonical directory.`);
    resolvedRoots[role] = { role, root: canonicalRoot, specification };
  }
  for (const [role, value] of Object.entries(resolvedRoots)) {
    const allowedRoles = value.specification.allowedExternalTreeRoles;
    if (!Array.isArray(allowedRoles) || new Set(allowedRoles).size !== allowedRoles.length || allowedRoles.some((allowedRole) => allowedRole === role || !resolvedRoots[allowedRole])) throw new Error(`Content tree ${role} has invalid external-tree authority.`);
    value.allowedExternalRoots = allowedRoles.map((allowedRole) => resolvedRoots[allowedRole].root);
  }
  return resolvedRoots;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

export async function inventoryContentTree({ role, root, allowedExternalRoots = [] } = {}) {
  if (typeof role !== 'string' || !role) throw new Error('A content-tree inventory requires a role.');
  const selected = resolve(root ?? '');
  const rootInfo = await lstat(selected);
  const canonicalRoot = await realpath(selected);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== selected) throw new Error(`Content tree ${role} must use its real canonical directory.`);
  const allowedRoots = await Promise.all(allowedExternalRoots.map(async (path) => realpath(resolve(path))));
  const entries = [];
  const visit = async (directory, prefix = '') => {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const path = resolve(directory, name);
      const logicalPath = prefix ? `${prefix}/${name}` : name;
      const before = await lstat(path);
      const mode = before.mode & 0o7777;
      if (before.isDirectory()) {
        entries.push({ path: logicalPath, type: 'directory', mode });
        await visit(path, logicalPath);
      } else if (before.isFile()) {
        const bytes = await readFile(path);
        const after = await lstat(path);
        if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size || !sameFileIdentity(before, after)) throw new Error(`Content tree ${role} changed while reading ${logicalPath}.`);
        entries.push({ path: logicalPath, type: 'file', mode, bytes: bytes.length, sha256: sha256Bytes(bytes) });
      } else if (before.isSymbolicLink()) {
        const target = await readlink(path);
        const canonicalTarget = await realpath(path);
        const targetInfo = await lstat(canonicalTarget);
        const targetScope = within(canonicalRoot, canonicalTarget)
          ? 'content-tree'
          : allowedRoots.some((allowedRoot) => within(allowedRoot, canonicalTarget)) ? 'declared-external-tree' : undefined;
        if (!targetScope || (!targetInfo.isFile() && !targetInfo.isDirectory())) throw new Error(`Content tree ${role} contains an unbound symbolic link: ${logicalPath}`);
        const afterTarget = await readlink(path);
        const afterCanonicalTarget = await realpath(path);
        if (afterTarget !== target || afterCanonicalTarget !== canonicalTarget) throw new Error(`Content tree ${role} symbolic link changed while reading ${logicalPath}.`);
        entries.push({ path: logicalPath, type: 'symlink', mode, target, canonicalTarget, targetScope, targetType: targetInfo.isDirectory() ? 'directory' : 'file' });
      } else {
        throw new Error(`Content tree ${role} contains an unsupported filesystem entry: ${logicalPath}`);
      }
    }
    const afterNames = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    if (stableStringify(afterNames) !== stableStringify(names)) throw new Error(`Content tree ${role} changed while enumerating ${prefix || '.'}.`);
  };
  await visit(canonicalRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const finalRootInfo = await lstat(canonicalRoot);
  if (!sameFileIdentity(rootInfo, finalRootInfo)) throw new Error(`Content tree ${role} root identity changed during inventory.`);
  const files = entries.filter((entry) => entry.type === 'file').length;
  const directories = entries.filter((entry) => entry.type === 'directory').length;
  const symlinks = entries.filter((entry) => entry.type === 'symlink').length;
  return {
    schemaVersion: 1,
    kind: 'aimuse-declared-content-tree',
    role,
    root: canonicalRoot,
    rootMode: rootInfo.mode & 0o7777,
    files,
    directories,
    symlinks,
    entriesSha256: sha256Bytes(Buffer.from(stableStringify(entries))),
    entries,
  };
}
