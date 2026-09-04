import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';

function within(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function strictChild(root, candidate) { return candidate !== root && within(root, candidate); }
function run(command, arguments_, environment = {}) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', env: { ...process.env, ...environment }, shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} failed while verifying the protected evidence ACL: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result.stdout;
}
function windowsPowerShell() { return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`; }
function currentWindowsSid() {
  const sid = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-\d-(?:\d+-)+\d+/iu)?.[0]?.toUpperCase();
  if (!sid) throw new Error('Unable to identify the verifier Windows user SID.');
  return sid;
}
function inspectWindowsAcl(path) {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:AIMUSE_RELEASE_EVIDENCE_ACL_PATH',
    '$owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() } })',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; ownerSid = $owner; rules = $rules } | ConvertTo-Json -Compress -Depth 5',
  ].join('; ');
  return JSON.parse(run(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { AIMUSE_RELEASE_EVIDENCE_ACL_PATH: path }));
}
function assertWindowsAcl(path, currentSid, requireProtected) {
  const acl = inspectWindowsAcl(path);
  const allowed = new Set([currentSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
  if (String(acl.ownerSid).toUpperCase() !== currentSid) throw new Error(`Protected evidence path is not owned by the verifier user: ${path}`);
  if (requireProtected && acl.protected !== true) throw new Error(`Formal run root still inherits Windows access rules: ${path}`);
  const rules = Array.isArray(acl.rules) ? acl.rules : acl.rules ? [acl.rules] : [];
  if (!rules.length) throw new Error(`Protected evidence path has no Windows access rules: ${path}`);
  let currentUserFullControl = false;
  for (const rule of rules) {
    const sid = String(rule.sid).toUpperCase();
    if (!allowed.has(sid) || rule.type !== 'Allow') throw new Error(`Protected evidence path grants an unexpected Windows principal or rule: ${path}`);
    if (sid === currentSid && String(rule.rights).includes('FullControl')) currentUserFullControl = true;
  }
  if (!currentUserFullControl) throw new Error(`Protected evidence path does not grant the verifier user FullControl: ${path}`);
}

async function inspectPath(path, canonicalRoot, options) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (options.directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Protected evidence path has the wrong filesystem type: ${path}`);
  const canonicalPath = await realpath(path);
  if (path !== options.root && !strictChild(canonicalRoot, canonicalPath)) throw new Error(`Protected evidence path escapes its formal root: ${path}`);
  if (process.platform === 'win32') assertWindowsAcl(path, options.currentSid, options.requireProtected);
  else {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`Protected evidence path is not owned by the verifier user: ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Protected evidence path is group/world accessible: ${path}`);
  }
  return { info, canonicalPath };
}

export async function inspectProtectedRunRoot({ workspace = process.cwd(), formalRunRoot, paths = [] } = {}) {
  if (!formalRunRoot) throw new Error('A formal run root is required.');
  const root = resolve(formalRunRoot);
  const evidenceRoot = resolve(workspace, 'test-results');
  if (!strictChild(evidenceRoot, root)) throw new Error('The formal run root is outside the existing test-results protection boundary.');
  const preliminary = await lstat(root);
  if (!preliminary.isDirectory() || preliminary.isSymbolicLink()) throw new Error('The formal run root must be a real directory.');
  const canonicalRoot = await realpath(root);
  const currentSid = process.platform === 'win32' ? currentWindowsSid() : undefined;
  const inspectedRoot = await inspectPath(root, canonicalRoot, { root, directory: true, currentSid, requireProtected: true });
  for (const value of paths) {
    const path = resolve(value);
    if (!strictChild(root, path)) throw new Error(`Protected evidence file is outside the formal run root: ${path}`);
    await inspectPath(path, canonicalRoot, { root, directory: false, currentSid, requireProtected: false });
  }
  return {
    root,
    identity: { version: 1, canonicalPath: canonicalRoot, device: String(inspectedRoot.info.dev), inode: String(inspectedRoot.info.ino) },
    owner: 'launching-user',
    allowedPrincipals: process.platform === 'win32' ? ['launching-user', 'SYSTEM', 'Administrators'] : ['launching-user'],
  };
}
