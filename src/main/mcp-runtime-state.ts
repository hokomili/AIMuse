import { spawn } from 'node:child_process';
import { constants as filesystemConstants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { atomicWriteFile, syncDirectory } from './persistence';
import { isEphemeralMcpToken } from './mcp-ephemeral-authority';

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROFILE_ID = /^[0-9a-f]{64}$/iu;
const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';
const MAX_STATE_BYTES = 16 * 1024;

export interface McpRuntimeState {
  version: 1;
  transport: 'streamable-http';
  authorityLifetime: 'engine';
  pid: number;
  instanceId: string;
  profileId: string;
  url: string;
  token: string;
  startedAt: string;
}

export interface McpRuntimeStateLocation {
  root: string;
  path: string;
}

export interface PreparedMcpRuntimeStateLocation extends McpRuntimeStateLocation {
  canonicalRoot: string;
  device: string;
  inode: string;
  platform: NodeJS.Platform;
}

export interface McpRuntimePrivacyDependencies {
  platform?: NodeJS.Platform;
  currentUid?: number;
  protectWindowsRoot?: (root: string) => Promise<void>;
  inspectWindowsPath?: (path: string) => Promise<unknown>;
  currentWindowsSid?: () => Promise<string>;
  fetchImplementation?: typeof globalThis.fetch;
  processAlive?: (pid: number) => boolean;
}

interface WindowsAclRule {
  sid: string;
  type: string;
  inherited: boolean;
  rights: string;
}

interface WindowsAcl {
  protected: boolean;
  ownerSid: string;
  rules: WindowsAclRule | WindowsAclRule[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function commandError(command: string, code: number, stdout: string, stderr: string): Error {
  const detail = [stderr, stdout].map((value) => value.trim()).filter(Boolean).join('\n');
  return new Error(`${command} exited with ${code}${detail ? `: ${detail}` : '.'}`);
}

async function runCommand(command: string, arguments_: string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, arguments_, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveOutput(stdout) : reject(commandError(command, code ?? 1, stdout, stderr)));
  });
}

function windowsPowerShell(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function currentWindowsSid(): Promise<string> {
  const output = await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = output.match(/S-\d-(?:\d+-)+\d+/iu)?.[0]?.toUpperCase();
  if (!sid) throw new Error('Unable to identify the current Windows user SID.');
  return sid;
}

async function inspectWindowsPath(path: string): Promise<WindowsAcl> {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:AIMUSE_MCP_RUNTIME_PATH',
    '$owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() } })',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; ownerSid = $owner; rules = $rules } | ConvertTo-Json -Compress -Depth 5',
  ].join('; ');
  const output = await runCommand(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { ...process.env, AIMUSE_MCP_RUNTIME_PATH: path });
  return asRecord(JSON.parse(output), `ACL for ${path}`) as unknown as WindowsAcl;
}

export function assertPrivateWindowsAcl(value: unknown, currentSid: string, requireProtected: boolean): void {
  const acl = asRecord(value, 'Windows ACL');
  const normalizedCurrent = currentSid.toUpperCase();
  const allowed = new Set([normalizedCurrent, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
  if (String(acl.ownerSid).toUpperCase() !== normalizedCurrent) throw new Error('MCP runtime path is not owned by the launching Windows user.');
  if (requireProtected && acl.protected !== true) throw new Error('MCP runtime root still inherits access rules.');
  const rules = Array.isArray(acl.rules) ? acl.rules : acl.rules ? [acl.rules] : [];
  if (!rules.length) throw new Error('MCP runtime path has no access rule for the launching Windows user.');
  let currentUserHasFullControl = false;
  for (const valueRule of rules) {
    const rule = asRecord(valueRule, 'Windows ACL rule');
    const sid = String(rule.sid).toUpperCase();
    if (!allowed.has(sid)) throw new Error(`MCP runtime path grants an unexpected principal: ${sid}.`);
    if (rule.type !== 'Allow') throw new Error(`MCP runtime path contains a non-Allow rule for ${sid}.`);
    if (sid === normalizedCurrent && String(rule.rights).includes('FullControl')) currentUserHasFullControl = true;
  }
  if (!currentUserHasFullControl) throw new Error('MCP runtime path does not grant the launching Windows user FullControl.');
}

async function protectWindowsRoot(root: string, sid: string): Promise<void> {
  await runCommand('icacls.exe', [
    root,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)(F)`,
    `*${WINDOWS_SYSTEM_SID}:(OI)(CI)(F)`,
    `*${WINDOWS_ADMINISTRATORS_SID}:(OI)(CI)(F)`,
  ]);
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function assertPosixPrivate(info: Stats, path: string, currentUid?: number): void {
  if (typeof currentUid === 'number' && info.uid !== currentUid) throw new Error(`MCP runtime path is not owned by the launching user: ${path}.`);
  if ((info.mode & 0o077) !== 0) throw new Error(`MCP runtime path is group/world accessible: ${path}.`);
}

export function mcpRuntimeStateLocation(userDataPath: string): McpRuntimeStateLocation {
  const root = join(resolve(userDataPath), 'mcp-runtime');
  return { root, path: join(root, 'engine.json') };
}

function filesystemIdentity(info: Stats): { device: string; inode: string } {
  const device = Number(info.dev);
  const inode = Number(info.ino);
  if (!Number.isFinite(device) || device < 0 || !Number.isFinite(inode) || inode < 0) throw new Error('MCP runtime root does not expose a stable filesystem identity.');
  return { device: String(info.dev), inode: String(info.ino) };
}

async function assertPreparedMcpRuntimeRoot(location: PreparedMcpRuntimeStateLocation, dependencies: McpRuntimePrivacyDependencies): Promise<void> {
  const info = await lstat(location.root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MCP runtime root identity changed.');
  const identity = filesystemIdentity(info);
  const canonical = await realpath(location.root);
  if (!samePath(canonical, location.canonicalRoot, location.platform) || identity.device !== location.device || identity.inode !== location.inode) throw new Error('MCP runtime root filesystem identity changed.');
  if (location.platform !== 'win32') assertPosixPrivate(info, location.root, dependencies.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined));
}

export async function prepareMcpRuntimeStateRoot(userDataPath: string, dependencies: McpRuntimePrivacyDependencies = {}): Promise<PreparedMcpRuntimeStateLocation> {
  const location = mcpRuntimeStateLocation(userDataPath);
  await mkdir(location.root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(location.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`MCP runtime root must be a real directory: ${location.root}.`);
  const canonical = await realpath(location.root);
  const platform = dependencies.platform ?? process.platform;
  const canonicalUserData = await realpath(resolve(userDataPath));
  if (!samePath(canonical, join(canonicalUserData, 'mcp-runtime'), platform)) throw new Error(`MCP runtime root resolves somewhere unexpected: ${location.root}.`);
  if (platform === 'win32') {
    const getSid = dependencies.currentWindowsSid ?? currentWindowsSid;
    const sid = (await getSid()).toUpperCase();
    await (dependencies.protectWindowsRoot ?? ((root) => protectWindowsRoot(root, sid)))(location.root);
    const inspect = dependencies.inspectWindowsPath ?? inspectWindowsPath;
    assertPrivateWindowsAcl(await inspect(location.root), sid, true);
  } else {
    await chmod(location.root, 0o700);
    const protectedRoot = await lstat(location.root);
    assertPosixPrivate(protectedRoot, location.root, dependencies.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined));
  }
  const protectedInfo = await lstat(location.root);
  return { ...location, canonicalRoot: canonical, ...filesystemIdentity(protectedInfo), platform };
}

function normalizeLocalMcpUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('MCP runtime state URL is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('MCP runtime state URL must be an exact IPv4 loopback MCP endpoint.');
  return url.toString();
}

export function normalizeMcpRuntimeState(value: unknown, expectedProfileId?: string): McpRuntimeState {
  const state = asRecord(value, 'MCP runtime state');
  const expectedKeys = ['authorityLifetime', 'instanceId', 'pid', 'profileId', 'startedAt', 'token', 'transport', 'url', 'version'];
  if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(expectedKeys)) throw new Error('MCP runtime state contains an unexpected field set.');
  if (state.version !== 1 || state.transport !== 'streamable-http' || state.authorityLifetime !== 'engine') throw new Error('MCP runtime state version or lifetime is invalid.');
  const pid = Number(state.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('MCP runtime state PID is invalid.');
  const instanceId = String(state.instanceId).toLowerCase();
  if (!INSTANCE_ID.test(instanceId)) throw new Error('MCP runtime state instance ID is invalid.');
  const profileId = String(state.profileId).toUpperCase();
  if (!PROFILE_ID.test(profileId) || (expectedProfileId && profileId !== expectedProfileId.toUpperCase())) throw new Error('MCP runtime state profile identity is invalid.');
  const token = String(state.token);
  if (!isEphemeralMcpToken(token)) throw new Error('MCP runtime state authority is invalid.');
  const startedAt = String(state.startedAt);
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error('MCP runtime state start time is invalid.');
  return { version: 1, transport: 'streamable-http', authorityLifetime: 'engine', pid, instanceId, profileId, url: normalizeLocalMcpUrl(state.url), token, startedAt };
}

async function readStateFile(location: PreparedMcpRuntimeStateLocation, expectedProfileId: string | undefined, dependencies: McpRuntimePrivacyDependencies): Promise<McpRuntimeState | undefined> {
  await assertPreparedMcpRuntimeRoot(location, dependencies);
  let pathInfo: Stats;
  try { pathInfo = await lstat(location.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error('MCP runtime state must be a real regular file.');
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') assertPosixPrivate(pathInfo, location.path, dependencies.currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined));
  const flags = filesystemConstants.O_RDONLY | (platform === 'win32' ? 0 : filesystemConstants.O_NOFOLLOW);
  const handle = await open(location.path, flags);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) throw new Error('MCP runtime state changed while it was opened.');
    if (openedInfo.size > MAX_STATE_BYTES) throw new Error('MCP runtime state is unexpectedly large.');
    const bytes = await handle.readFile();
    await assertPreparedMcpRuntimeRoot(location, dependencies);
    return normalizeMcpRuntimeState(JSON.parse(bytes.toString('utf8')), expectedProfileId);
  } finally { await handle.close(); }
}

export async function readMcpRuntimeState(userDataPath: string, expectedProfileId?: string, dependencies: McpRuntimePrivacyDependencies = {}): Promise<McpRuntimeState | undefined> {
  const location = await prepareMcpRuntimeStateRoot(userDataPath, dependencies);
  return readStateFile(location, expectedProfileId, dependencies);
}

/** Reads from a root already prepared and privacy-verified by this process. */
export async function readPreparedMcpRuntimeState(location: PreparedMcpRuntimeStateLocation, expectedProfileId?: string, dependencies: McpRuntimePrivacyDependencies = {}): Promise<McpRuntimeState | undefined> {
  return readStateFile(location, expectedProfileId, dependencies);
}

export async function publishMcpRuntimeState(userDataPath: string, stateValue: McpRuntimeState, dependencies: McpRuntimePrivacyDependencies = {}): Promise<McpRuntimeState> {
  const state = normalizeMcpRuntimeState(stateValue, stateValue.profileId);
  if (state.pid !== process.pid) throw new Error('MCP runtime state must be bound to the publishing engine PID.');
  const location = await prepareMcpRuntimeStateRoot(userDataPath, dependencies);
  const existing = await readStateFile(location, state.profileId, dependencies);
  if (existing && !sameMcpRuntimeAuthority(existing, state)) {
    const processAlive = dependencies.processAlive ?? processIsAlive;
    if (processAlive(existing.pid)) {
      if (await mcpRuntimeStateHealthMatches(existing, dependencies)) throw new Error('Another live AIMuse engine already owns this profile MCP boundary.');
      throw new Error('The existing MCP runtime owner PID is still live but its engine identity is ambiguous; refusing to replace its authority.');
    }
  }
  const serialized = `${JSON.stringify(state)}\n`;
  await atomicWriteFile(location.path, serialized, (bytes) => { normalizeMcpRuntimeState(JSON.parse(bytes.toString('utf8')), state.profileId); });
  if ((dependencies.platform ?? process.platform) !== 'win32') await chmod(location.path, 0o600);
  const persisted = await readStateFile(location, state.profileId, dependencies);
  if (!persisted || !sameMcpRuntimeAuthority(persisted, state)) throw new Error('MCP runtime state did not persist atomically.');
  return persisted;
}

async function mcpRuntimeStateHealthMatches(state: McpRuntimeState, dependencies: McpRuntimePrivacyDependencies): Promise<boolean> {
  const url = new URL(state.url); url.pathname = '/health';
  try {
    const response = await (dependencies.fetchImplementation ?? globalThis.fetch)(url, {
      headers: { authorization: `Bearer ${state.token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.status === 'ok' && body.pid === state.pid && String(body.instanceId).toLowerCase() === state.instanceId && String(body.profileId).toUpperCase() === state.profileId;
  } catch { return false; }
}

export function sameMcpRuntimeAuthority(left: McpRuntimeState, right: McpRuntimeState): boolean {
  return left.pid === right.pid && left.instanceId === right.instanceId && left.profileId === right.profileId && left.url === right.url && left.token === right.token && left.startedAt === right.startedAt;
}

export async function clearMcpRuntimeState(userDataPath: string, expected: McpRuntimeState, dependencies: McpRuntimePrivacyDependencies = {}): Promise<boolean> {
  const location = await prepareMcpRuntimeStateRoot(userDataPath, dependencies);
  const current = await readStateFile(location, expected.profileId, dependencies);
  if (!current || !sameMcpRuntimeAuthority(current, expected)) return false;
  const canonicalRoot = await realpath(location.root);
  const canonicalFile = await realpath(location.path);
  if (!within(canonicalRoot, canonicalFile)) throw new Error('MCP runtime state escaped its private root.');
  const beforeUnlink = await readStateFile(location, expected.profileId, dependencies);
  if (!beforeUnlink || !sameMcpRuntimeAuthority(beforeUnlink, expected)) return false;
  await unlink(location.path);
  if ((dependencies.platform ?? process.platform) !== 'win32') await syncDirectory(location.root);
  return true;
}
