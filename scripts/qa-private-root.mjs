import { spawn } from 'node:child_process';
import { chmod, lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';

function within(root, path) {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function samePath(left, right, platform) {
  return platform === 'win32'
    ? left.toUpperCase() === right.toUpperCase()
    : left === right;
}

function filesystemIdentity(info, canonicalPath) {
  const device = info.dev;
  const inode = info.ino;
  if (!['bigint', 'number'].includes(typeof device) || !['bigint', 'number'].includes(typeof inode) || !Number.isFinite(Number(device)) || !Number.isFinite(Number(inode)) || Number(device) < 0 || Number(inode) < 0) throw new Error('Private root does not expose a stable filesystem identity.');
  return { version: 1, canonicalPath: resolve(canonicalPath), device: String(device), inode: String(inode) };
}

export function normalizePrivateRootIdentity(value, label = 'Private root identity') {
  const identity = asRecord(value, label);
  if (identity.version !== 1 || typeof identity.canonicalPath !== 'string' || !isAbsolute(identity.canonicalPath) || typeof identity.device !== 'string' || !/^\d+$/.test(identity.device) || typeof identity.inode !== 'string' || !/^\d+$/.test(identity.inode)) throw new Error(`${label} is invalid.`);
  return { version: 1, canonicalPath: resolve(identity.canonicalPath), device: identity.device, inode: identity.inode };
}

export function assertPrivateRootDeclaration(declaredRoot, storedRoot, storedIdentity, observedValue, platform = process.platform) {
  const declared = resolve(declaredRoot);
  if (typeof storedRoot !== 'string' || !isAbsolute(storedRoot) || !samePath(declared, resolve(storedRoot), platform)) throw new Error('Declared private root does not match persisted coordinator identity.');
  const observed = asRecord(observedValue, 'Observed private root');
  if (typeof observed.root !== 'string' || !samePath(declared, resolve(observed.root), platform)) throw new Error('Observed private root does not match the declared coordinator root.');
  const expected = normalizePrivateRootIdentity(storedIdentity, 'Persisted private root identity');
  const actual = normalizePrivateRootIdentity(observed.identity, 'Observed private root identity');
  if (!samePath(expected.canonicalPath, actual.canonicalPath, platform) || expected.device !== actual.device || expected.inode !== actual.inode) throw new Error('Private root filesystem identity changed.');
  return expected;
}

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function commandError(command, result) {
  const detail = [result.stderr, result.stdout].map((value) => value.trim()).filter(Boolean).join('\n');
  return new Error(`${command} exited with ${result.code}${detail ? `: ${detail}` : '.'}`);
}

async function runCommand(command, arguments_, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, arguments_, {
      cwd: resolve('.'),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0) reject(commandError(command, result));
      else resolveResult(result);
    });
  });
}

function windowsPowerShell() {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function currentWindowsSid() {
  const result = await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = result.stdout.match(/S-\d-(?:\d+-)+\d+/i)?.[0]?.toUpperCase();
  if (!sid) throw new Error('Unable to identify the current Windows user SID.');
  return sid;
}

async function inspectWindowsAcl(path) {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:AIMUSE_QA_ACL_PATH',
    '$owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() } })',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; ownerSid = $owner; rules = $rules } | ConvertTo-Json -Compress -Depth 5',
  ].join('; ');
  const result = await runCommand(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { AIMUSE_QA_ACL_PATH: path } });
  return asRecord(JSON.parse(result.stdout), `ACL for ${path}`);
}

export function assertPrivateWindowsAcl(value, currentSid, options = {}) {
  const acl = asRecord(value, 'Windows ACL');
  const normalizedCurrent = String(currentSid).toUpperCase();
  const allowed = new Set([normalizedCurrent, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
  if (String(acl.ownerSid).toUpperCase() !== normalizedCurrent) throw new Error('Private path is not owned by the launching Windows user.');
  if (options.requireProtected && acl.protected !== true) throw new Error('Private run root still inherits access rules.');
  const rules = Array.isArray(acl.rules) ? acl.rules : acl.rules ? [acl.rules] : [];
  if (!rules.length) throw new Error('Private path has no access rule for the launching Windows user.');
  let currentUserHasFullControl = false;
  for (const rawRule of rules) {
    const rule = asRecord(rawRule, 'Windows ACL rule');
    const sid = String(rule.sid).toUpperCase();
    if (!allowed.has(sid)) throw new Error(`Private path grants an unexpected principal: ${sid}.`);
    if (rule.type !== 'Allow') throw new Error(`Private path contains a non-Allow rule for ${sid}.`);
    if (sid === normalizedCurrent && String(rule.rights).includes('FullControl')) currentUserHasFullControl = true;
  }
  if (!currentUserHasFullControl) throw new Error('Private path does not grant the launching Windows user FullControl.');
  return { owner: 'launching-user', allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'], inheritedFromBroadParent: false };
}

async function existingPathChain(root, path, lstatPath) {
  const chain = [root];
  const relativePath = relative(root, path);
  if (!relativePath) return chain;
  let current = root;
  for (const component of relativePath.split(sep)) {
    current = resolve(current, component);
    try {
      await lstatPath(current);
      chain.push(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return chain;
}

function assertPosixOwnerPrivate(info, path, currentUid) {
  if (typeof currentUid === 'number' && info.uid !== currentUid) throw new Error(`Private path is not owned by the launching user: ${path}.`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Private path is group/world accessible: ${path}.`);
}

export async function assertOwnerPrivateRoot({ privateRoot, paths, evidenceRoot = resolve('test-results') }, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const root = resolve(privateRoot);
  const allowedRoot = resolve(evidenceRoot);
  const protectedPaths = paths.map((path) => resolve(path));
  if (samePath(root, allowedRoot, platform) || !within(allowedRoot, root)) throw new Error(`Private root must be a child below ${allowedRoot}: ${root}`);
  for (const path of protectedPaths) {
    if (!within(root, path)) throw new Error(`Credential-bearing path must stay below private root ${root}: ${path}`);
  }

  const lstatPath = dependencies.lstatPath ?? lstat;
  const realpathPath = dependencies.realpathPath ?? realpath;
  const rootInfo = await lstatPath(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Private root must be a real directory, not a link: ${root}`);
  const canonicalRoot = await realpathPath(root);
  const identity = filesystemIdentity(rootInfo, canonicalRoot);
  const existing = new Set();
  for (const path of protectedPaths) {
    for (const component of await existingPathChain(root, path, lstatPath)) existing.add(component);
  }
  if (!existing.size) existing.add(root);

  if (platform === 'win32') {
    const getCurrentWindowsSid = dependencies.currentWindowsSid ?? currentWindowsSid;
    const getWindowsAcl = dependencies.inspectWindowsAcl ?? inspectWindowsAcl;
    const currentSid = await getCurrentWindowsSid();
    for (const path of existing) {
      const info = path === root ? rootInfo : await lstatPath(path);
      if (info.isSymbolicLink()) throw new Error(`Private evidence path must not traverse a link: ${path}`);
      const canonicalPath = await realpathPath(path);
      if (!within(canonicalRoot, canonicalPath) && !samePath(canonicalRoot, canonicalPath, platform)) throw new Error(`Private evidence path escapes its root: ${path}`);
      assertPrivateWindowsAcl(await getWindowsAcl(path), currentSid, { requireProtected: samePath(path, root, platform) });
    }
    return { root, identity, platform, owner: 'launching-user', allowedPrincipals: ['launching-user', 'SYSTEM', 'Administrators'], inspectedPaths: existing.size };
  }

  const currentUid = dependencies.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  for (const path of existing) {
    const info = path === root ? rootInfo : await lstatPath(path);
    if (info.isSymbolicLink()) throw new Error(`Private evidence path must not traverse a link: ${path}`);
    const canonicalPath = await realpathPath(path);
    if (!within(canonicalRoot, canonicalPath) && canonicalPath !== canonicalRoot) throw new Error(`Private evidence path escapes its root: ${path}`);
    assertPosixOwnerPrivate(info, path, currentUid);
  }
  return { root, identity, platform, owner: 'launching-user', allowedPrincipals: ['launching-user'], inspectedPaths: existing.size };
}

export async function protectOwnerPrivateRoot(root) {
  if (process.platform !== 'win32') {
    await chmod(root, 0o700);
    return { platform: process.platform, mode: '0700' };
  }
  const currentSid = await currentWindowsSid();
  await runCommand('icacls.exe', [
    root,
    '/inheritance:r',
    '/grant:r',
    `*${currentSid}:(OI)(CI)(F)`,
    `*${WINDOWS_SYSTEM_SID}:(OI)(CI)(F)`,
    `*${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)(F)`,
  ]);
  const summary = assertPrivateWindowsAcl(await inspectWindowsAcl(root), currentSid, { requireProtected: true });
  return { platform: 'win32', currentSid, ...summary };
}

export async function inspectOwnerPrivatePath(path, privateRoot) {
  if (process.platform !== 'win32') {
    const info = await stat(path);
    assertPosixOwnerPrivate(info, path, typeof process.getuid === 'function' ? process.getuid() : undefined);
    return { mode: (info.mode & 0o777).toString(8).padStart(4, '0'), allowedPrincipals: ['launching-user'] };
  }
  return assertPrivateWindowsAcl(await inspectWindowsAcl(path), privateRoot.currentSid);
}
