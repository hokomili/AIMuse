import { lstatSync, mkdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import type { App } from 'electron';
import type { AgentClientBridgeLaunch } from '../common/agent-clients';
import { profileIdForPath } from './profile-identity';

export const MCP_BRIDGE_ARGUMENT = '--mcp-bridge';
export const MCP_TARGET_PROFILE_ARGUMENT = '--mcp-target-profile';
const ELECTRON_USER_DATA_ARGUMENT = '--user-data-dir';

export interface McpBridgeDirectoryIdentity {
  canonicalPath: string;
  filesystemId?: string;
  linkLike: boolean;
  mode?: number;
  ownerUid?: number;
}

export interface McpBridgeFilesystem {
  createDirectory: (path: string) => void;
  inspectDirectory: (path: string, platform: NodeJS.Platform) => McpBridgeDirectoryIdentity;
  assertLinkFreeDirectory: (path: string, platform: NodeJS.Platform) => void;
}

export interface McpBridgeEntryDependencies {
  platform?: NodeJS.Platform;
  filesystem?: McpBridgeFilesystem;
  currentUid?: number;
}

export interface McpBridgeEntry {
  targetProfilePath: string;
  electronUserDataPath: string;
  targetIdentity: McpBridgeDirectoryIdentity;
  electronUserDataIdentity: McpBridgeDirectoryIdentity;
}

export type McpBridgeBootstrapResult =
  | { requested: false; entry?: undefined; failed?: false }
  | { requested: true; entry: McpBridgeEntry; failed?: false }
  | { requested: true; entry?: undefined; failed: true };

export interface McpBridgeLaunchOptions {
  executablePath: string;
  appPath: string;
  packaged: boolean;
  targetProfilePath: string;
}

type McpBridgeElectronApp = Pick<App, 'disableHardwareAcceleration' | 'getPath' | 'setActivationPolicy' | 'setName' | 'setPath'>;
type McpBridgeBootstrapApp = McpBridgeElectronApp & Pick<App, 'exit'>;

function argumentValues(arguments_: readonly string[], name: string): string[] {
  return arguments_.filter((argument) => argument.startsWith(`${name}=`)).map((argument) => argument.slice(name.length + 1));
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right;
}

function filesystemId(info: BigIntStats): string | undefined {
  return info.ino === 0n ? undefined : `${info.dev}:${info.ino}`;
}

function sameFilesystemObject(left: BigIntStats, right: BigIntStats): boolean {
  const leftId = filesystemId(left);
  const rightId = filesystemId(right);
  return !leftId || !rightId || leftId === rightId;
}

function inspectDirectory(path: string, platform: NodeJS.Platform): McpBridgeDirectoryIdentity {
  const normalized = resolve(path);
  const entryBefore = lstatSync(normalized, { bigint: true });
  const objectBefore = statSync(normalized, { bigint: true });
  if (!objectBefore.isDirectory()) throw new Error(`AIMuse MCP profile path must be a directory: ${normalized}.`);
  const canonicalPath = realpathSync.native(normalized);
  const entryAfter = lstatSync(normalized, { bigint: true });
  const objectAfter = statSync(normalized, { bigint: true });
  const canonicalObject = statSync(canonicalPath, { bigint: true });
  if (!sameFilesystemObject(objectBefore, objectAfter)
    || !sameFilesystemObject(objectAfter, canonicalObject)
    || (!entryBefore.isSymbolicLink() && !sameFilesystemObject(entryBefore, entryAfter))) {
    throw new Error(`AIMuse MCP profile identity changed during inspection: ${normalized}.`);
  }
  return {
    canonicalPath,
    filesystemId: filesystemId(objectAfter),
    linkLike: entryAfter.isSymbolicLink() || !samePath(canonicalPath, normalized, platform),
    mode: Number(objectAfter.mode),
    ownerUid: Number(objectAfter.uid),
  };
}

function assertLinkFreeDirectory(path: string, platform: NodeJS.Platform): void {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const remainder = relative(root, normalized);
  let cursor = root;
  for (const component of remainder.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor, { bigint: true }).isSymbolicLink()) {
      throw new Error(`AIMuse MCP bridge profile must not contain a symbolic link, junction, or reparse alias: ${cursor}.`);
    }
  }
  if (inspectDirectory(normalized, platform).linkLike) {
    throw new Error(`AIMuse MCP bridge profile must resolve without a symbolic link, junction, or reparse alias: ${normalized}.`);
  }
}

const DEFAULT_FILESYSTEM: McpBridgeFilesystem = {
  createDirectory(path) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  },
  inspectDirectory,
  assertLinkFreeDirectory,
};

function identitiesAlias(left: McpBridgeDirectoryIdentity, right: McpBridgeDirectoryIdentity, platform: NodeJS.Platform): boolean {
  return samePath(left.canonicalPath, right.canonicalPath, platform)
    || Boolean(left.filesystemId && right.filesystemId && left.filesystemId === right.filesystemId);
}

function assertIdentityUnchanged(expected: McpBridgeDirectoryIdentity, actual: McpBridgeDirectoryIdentity, platform: NodeJS.Platform, label: string): void {
  if (!samePath(expected.canonicalPath, actual.canonicalPath, platform)
    || (expected.filesystemId && actual.filesystemId !== expected.filesystemId)) {
    throw new Error(`AIMuse MCP ${label} filesystem identity changed before bridge startup.`);
  }
}

function assertPrivateBridgeDirectory(identity: McpBridgeDirectoryIdentity, platform: NodeJS.Platform, currentUid?: number): void {
  if (platform === 'win32') return;
  const expectedUid = currentUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (typeof expectedUid === 'number' && identity.ownerUid !== expectedUid) throw new Error('AIMuse MCP bridge profile is not owned by the launching user.');
  if (typeof identity.mode !== 'number' || (identity.mode & 0o077) !== 0) throw new Error('AIMuse MCP bridge profile must be owner-private.');
}

/** A deterministic Electron browser profile derived from, but never equal to, the target engine profile. */
export function mcpBridgeElectronUserDataPath(targetProfilePath: string): string {
  const target = resolve(targetProfilePath);
  const profileSuffix = profileIdForPath(target).slice(0, 16).toLowerCase();
  return join(dirname(target), `.aimuse-mcp-bridge-${profileSuffix}`);
}

/** Builds the static installed/development entry. It contains no engine authority or Chromium profile switch. */
export function buildMcpBridgeLaunch(options: McpBridgeLaunchOptions): AgentClientBridgeLaunch {
  const targetProfilePath = resolve(options.targetProfilePath);
  return {
    command: options.executablePath,
    args: [
      ...(options.packaged ? [] : [options.appPath]),
      MCP_BRIDGE_ARGUMENT,
      `${MCP_TARGET_PROFILE_ARGUMENT}=${targetProfilePath}`,
    ],
  };
}

/** Revalidates both directory objects and the bridge's link-free boundary. */
export function assertMcpBridgeEntryIdentity(entry: McpBridgeEntry, dependencies: McpBridgeEntryDependencies = {}): void {
  const platform = dependencies.platform ?? process.platform;
  const filesystem = dependencies.filesystem ?? DEFAULT_FILESYSTEM;
  filesystem.assertLinkFreeDirectory(entry.electronUserDataPath, platform);
  const targetIdentity = filesystem.inspectDirectory(entry.targetProfilePath, platform);
  const electronIdentity = filesystem.inspectDirectory(entry.electronUserDataPath, platform);
  assertIdentityUnchanged(entry.targetIdentity, targetIdentity, platform, 'target profile');
  assertIdentityUnchanged(entry.electronUserDataIdentity, electronIdentity, platform, 'bridge profile');
  assertPrivateBridgeDirectory(electronIdentity, platform, dependencies.currentUid);
  if (electronIdentity.linkLike || identitiesAlias(targetIdentity, electronIdentity, platform)) {
    throw new Error('AIMuse MCP bridge Electron data must be a real link-free directory and cannot alias the target engine profile.');
  }
}

/**
 * Resolves and prepares the real Electron bridge entry. The target must already
 * exist; only the final deterministic bridge directory may be created.
 */
export function resolveMcpBridgeEntry(arguments_: readonly string[], dependencies: McpBridgeEntryDependencies = {}): McpBridgeEntry | undefined {
  const bridgeArguments = arguments_.filter((argument) => argument === MCP_BRIDGE_ARGUMENT);
  const targetArguments = argumentValues(arguments_, MCP_TARGET_PROFILE_ARGUMENT);
  const electronArguments = arguments_.filter((argument) => argument === ELECTRON_USER_DATA_ARGUMENT || argument.startsWith(`${ELECTRON_USER_DATA_ARGUMENT}=`));
  if (!bridgeArguments.length) {
    if (targetArguments.length) throw new Error(`${MCP_TARGET_PROFILE_ARGUMENT} is valid only with ${MCP_BRIDGE_ARGUMENT}.`);
    return undefined;
  }
  if (bridgeArguments.length !== 1) throw new Error(`${MCP_BRIDGE_ARGUMENT} must be specified exactly once.`);
  if (electronArguments.length) throw new Error(`${MCP_BRIDGE_ARGUMENT} derives its isolated browser profile and forbids ${ELECTRON_USER_DATA_ARGUMENT}.`);
  if (targetArguments.length !== 1 || !targetArguments[0]) {
    throw new Error(`${MCP_BRIDGE_ARGUMENT} requires exactly one absolute ${MCP_TARGET_PROFILE_ARGUMENT}.`);
  }
  if (!isAbsolute(targetArguments[0])) throw new Error('AIMuse MCP bridge target profile path must be absolute.');
  const platform = dependencies.platform ?? process.platform;
  const filesystem = dependencies.filesystem ?? DEFAULT_FILESYSTEM;
  const targetProfilePath = resolve(targetArguments[0]);
  const electronUserDataPath = mcpBridgeElectronUserDataPath(targetProfilePath);
  if (samePath(targetProfilePath, electronUserDataPath, platform)) throw new Error('AIMuse MCP bridge profile cannot share the target engine profile.');
  const targetIdentity = filesystem.inspectDirectory(targetProfilePath, platform);
  filesystem.assertLinkFreeDirectory(dirname(electronUserDataPath), platform);
  filesystem.createDirectory(electronUserDataPath);
  filesystem.assertLinkFreeDirectory(electronUserDataPath, platform);
  const electronUserDataIdentity = filesystem.inspectDirectory(electronUserDataPath, platform);
  const entry = { targetProfilePath, electronUserDataPath, targetIdentity, electronUserDataIdentity };
  assertMcpBridgeEntryIdentity(entry, dependencies);
  return entry;
}

/** Installs the validated profile into Electron and immediately rechecks its directory identity. */
export function installMcpBridgeEntry(arguments_: readonly string[], app: McpBridgeElectronApp, dependencies: McpBridgeEntryDependencies = {}): McpBridgeEntry | undefined {
  const platform = dependencies.platform ?? process.platform;
  if (arguments_.includes(MCP_BRIDGE_ARGUMENT)) {
    app.disableHardwareAcceleration();
    if (platform === 'darwin') app.setActivationPolicy('prohibited');
  }
  const entry = resolveMcpBridgeEntry(arguments_, dependencies);
  if (!entry) return undefined;
  app.setName(`AIMuse-MCP-Bridge-${profileIdForPath(entry.targetProfilePath).slice(0, 12).toLowerCase()}`);
  assertMcpBridgeEntryIdentity(entry, dependencies);
  app.setPath('userData', entry.electronUserDataPath);
  if (!samePath(resolve(app.getPath('userData')), entry.electronUserDataPath, platform)) throw new Error('Electron did not retain the validated AIMuse MCP bridge profile.');
  assertMcpBridgeEntryIdentity(entry, dependencies);
  return entry;
}

/** Converts every malformed or unsafe bridge launch into an immediate, headless process failure. */
export function bootstrapMcpBridgeEntry(arguments_: readonly string[], app: McpBridgeBootstrapApp, dependencies: McpBridgeEntryDependencies = {}): McpBridgeBootstrapResult {
  try {
    const entry = installMcpBridgeEntry(arguments_, app, dependencies);
    return entry ? { requested: true, entry } : { requested: false };
  } catch {
    app.exit(1);
    return { requested: true, failed: true };
  }
}
