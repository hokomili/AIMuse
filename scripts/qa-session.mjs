import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { atomicWriteJsonEvidence, buildRedactedConnection, validateRedactedConnection } from './qa-evidence.mjs';
import { buildStopManifest, coordinateShow, coordinateStop, normalizeInstanceId, normalizeProfileId, profileIdForPath, validateHealthIdentity, waitForConnectionReadiness, waitForStopCompletion } from './qa-lifecycle.mjs';
import { assertOwnerPrivateRoot, assertPrivateRootDeclaration, normalizePrivateRootIdentity } from './qa-private-root.mjs';

const LEGACY_CERTIFIED_EXECUTABLES = new Set([
  'E558EA355F7AB40391BC38FD918ECFB418451F39C0DE520B58BCE8ABE99EC412',
  'CFCC482C04C21124D82E857428B561DB5FAB60A3A61390E8535471E99E830621',
]);

const HELP = `AIMuse isolated QA session

Usage:
  node scripts/qa-session.mjs start --exe <AIMuse.exe> --private-root <dir> --profile <dir> --connection <json> --launch-context unsandboxed-gui [--manifest <json>] [--mode interactive|headless] [--authority-policy <json>] [--trust-folder <dir> ...]
  node scripts/qa-session.mjs show --private-root <dir> --manifest <json>
  node scripts/qa-session.mjs status --private-root <dir> --manifest <json>
  node scripts/qa-session.mjs stop --private-root <dir> --manifest <json>
  node scripts/qa-session.mjs redact --private-root <dir> --manifest <json>

Interactive mode is the formal UI-test default. Headless mode is used for
explicit lifecycle scenarios and show attaches its editor. On Windows,
start/show/stop must run outside a Codex filesystem sandbox. Credential-bearing
session files are required to stay below an existing owner-private --private-root
under ignored test-results/. The root ACL is verified before executable access
or process launch. Follow-up commands revalidate its persisted filesystem
identity before sensitive reads and actions; the coordinator never repairs it.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return { command, values };
}
function required(values, key) { const value = values.get(key)?.at(-1); if (!value) throw new Error(`--${key} is required.`); return value; }
function optional(values, key) { return values.get(key)?.at(-1); }
function within(root, path) { const value = relative(root, path); return value === '' || (!value.startsWith('..') && !isAbsolute(value)); }
function assertEvidencePath(path) {
  const root = resolve('test-results');
  if (!within(root, path)) throw new Error(`QA session artifacts must stay below ${root}: ${path}`);
}
function assertSeparateConnectionAndManifest(connection, manifestPath) {
  if (connection === manifestPath) throw new Error(`QA session connection and manifest paths must differ: ${manifestPath}`);
}
function assertPrivateManifestPaths(manifestPath, privateRoot, paths) {
  const evidenceRoot = resolve('test-results');
  if (privateRoot === evidenceRoot || !within(evidenceRoot, privateRoot)) throw new Error(`QA session private root must be a child below ${evidenceRoot}: ${privateRoot}`);
  for (const path of [manifestPath, ...paths]) if (!within(privateRoot, path)) throw new Error(`QA session path must stay below persisted private root ${privateRoot}: ${path}`);
}
function normalizeManifest(manifestPath, value) {
  if (!value || typeof value !== 'object' || value.version !== 1) throw new Error(`Invalid QA session manifest: ${manifestPath}`);
  for (const key of ['exe', 'privateRoot', 'profile', 'connection']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) throw new Error(`QA session manifest ${key} must be an absolute path: ${manifestPath}`);
  }
  if (!Number.isSafeInteger(Number(value.pid)) || Number(value.pid) <= 0) throw new Error(`Invalid QA session manifest PID: ${manifestPath}`);
  if (typeof value.exeSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(value.exeSha256)) throw new Error(`Invalid QA session executable hash: ${manifestPath}`);
  let mcpUrl;
  try { mcpUrl = new globalThis.URL(value.mcpUrl); } catch { throw new Error(`Invalid QA session MCP URL: ${manifestPath}`); }
  if (mcpUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(mcpUrl.hostname) || !mcpUrl.port || mcpUrl.pathname !== '/mcp' || mcpUrl.username || mcpUrl.password || mcpUrl.search || mcpUrl.hash) throw new Error(`Invalid QA session MCP URL: ${manifestPath}`);
  const exeSha256 = value.exeSha256.toUpperCase();
  const profile = resolve(value.profile);
  const profileId = normalizeProfileId(value.profileId, 'QA session profile ID');
  if (profileId !== undefined && profileIdForPath(profile) !== profileId) throw new Error(`QA session manifest profile identity does not match its profile path: ${manifestPath}`);
  if (profileId === undefined && !LEGACY_CERTIFIED_EXECUTABLES.has(exeSha256)) throw new Error(`QA session manifest profile identity is required for this executable: ${manifestPath}`);
  const privateRoot = resolve(value.privateRoot);
  const manifest = { ...value, exe: resolve(value.exe), privateRoot, privateRootIdentity: normalizePrivateRootIdentity(value.privateRootIdentity, 'QA session private root identity'), profile, connection: resolve(value.connection), pid: Number(value.pid), exeSha256, mcpUrl: mcpUrl.toString(), instanceId: normalizeInstanceId(value.instanceId, 'QA session engine instance ID'), profileId };
  assertEvidencePath(manifest.profile); assertEvidencePath(manifest.connection);
  assertPrivateManifestPaths(manifestPath, privateRoot, [manifest.profile, manifest.connection]);
  assertSeparateConnectionAndManifest(manifest.connection, manifestPath);
  return manifest;
}
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase(); }
async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit) => {
    const timeout = globalThis.setTimeout(() => resolveExit(undefined), timeoutMs);
    child.once('exit', (code) => { globalThis.clearTimeout(timeout); resolveExit(code ?? 0); });
  });
}
async function fetchHealth(url) {
  const healthUrl = new globalThis.URL(url); healthUrl.pathname = '/health'; healthUrl.search = '';
  const response = await globalThis.fetch(healthUrl, { signal: globalThis.AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`Health endpoint returned ${response.status}.`);
  let body;
  try { body = await response.json(); } catch { throw new Error('Health endpoint did not return JSON.'); }
  return { url: healthUrl.toString(), body };
}
async function health(url, expectedPid, expectedInstanceId, expectedProfileId) {
  const probe = await fetchHealth(url);
  return { ...probe, ...validateHealthIdentity(probe.body, expectedPid, expectedInstanceId, expectedProfileId) };
}
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function waitForConnection(connectionPath, expectedPid, expectedProfileId, startedAt) {
  return waitForConnectionReadiness({ connectionPath, expectedPid, expectedProfileId, startedAt }, {
    now: () => Date.now(),
    statConnection: (path) => stat(path),
    readConnection: (path) => readFile(path, 'utf8'),
    probeHealth: (url, pid, instanceId, profileId) => health(url, pid, instanceId, profileId),
    sleep: (milliseconds) => new Promise((resolveWait) => globalThis.setTimeout(resolveWait, milliseconds)),
  });
}

function privateRootPlatform(dependencies) { return dependencies.platform ?? process.platform; }
async function observePrivateRoot(privateRoot, paths, dependencies, persisted) {
  const assertPrivateRoot = dependencies.assertPrivateRoot ?? assertOwnerPrivateRoot;
  const observed = await assertPrivateRoot({ privateRoot, paths });
  if (persisted) assertPrivateRootDeclaration(privateRoot, persisted.privateRoot, persisted.privateRootIdentity, observed, privateRootPlatform(dependencies));
  else assertPrivateRootDeclaration(privateRoot, observed.root, observed.identity, observed, privateRootPlatform(dependencies));
  return observed;
}
async function revalidatePrivateContext(context, paths = context.paths) {
  if (context.privateRootFailure) throw context.privateRootFailure;
  try { return await observePrivateRoot(context.privateRoot, paths, context.dependencies, context.manifest); }
  catch (error) { context.privateRootFailure = error; throw error; }
}
async function loadManifest(values, dependencies = {}) {
  const privateRoot = resolve(required(values, 'private-root'));
  const manifestPath = resolve(required(values, 'manifest')); assertEvidencePath(manifestPath);
  const initial = await observePrivateRoot(privateRoot, [manifestPath], dependencies);
  const readText = dependencies.readFile ?? readFile;
  const manifest = normalizeManifest(manifestPath, JSON.parse(await readText(manifestPath, 'utf8')));
  assertPrivateRootDeclaration(privateRoot, manifest.privateRoot, manifest.privateRootIdentity, initial, privateRootPlatform(dependencies));
  const context = { privateRoot, manifestPath, manifest, paths: [manifestPath, manifest.profile, manifest.connection], dependencies };
  await revalidatePrivateContext(context);
  return context;
}
async function writeManifest(manifestPath, manifest) {
  await atomicWriteJsonEvidence(manifestPath, manifest, { validate: (value) => normalizeManifest(manifestPath, value) });
}
async function assertExecutableIdentity(manifest, action, hashExecutable = sha256) {
  const currentHash = await hashExecutable(manifest.exe);
  if (currentHash !== manifest.exeSha256) throw new Error(`Refusing to ${action} because executable hash changed: expected ${manifest.exeSha256}, received ${currentHash}.`);
}
function assertConnectionIdentity(manifest, connection, action) {
  let connectionInstanceId; let connectionProfileId;
  try { connectionInstanceId = normalizeInstanceId(connection.instanceId, 'QA connection engine instance ID'); } catch { throw new Error(`Refusing to ${action} because session instance identity is invalid.`); }
  try { connectionProfileId = normalizeProfileId(connection.profileId, 'QA connection profile ID'); } catch { throw new Error(`Refusing to ${action} because session profile identity is invalid.`); }
  if (Number(connection.pid) !== Number(manifest.pid) || connection.url !== manifest.mcpUrl) throw new Error(`Refusing to ${action} because session PID/URL identity changed.`);
  if (connectionInstanceId !== manifest.instanceId) throw new Error(`Refusing to ${action} because session instance identity changed.`);
  if (connectionProfileId !== manifest.profileId) throw new Error(`Refusing to ${action} because session profile identity changed.`);
}
async function redactConnection(context) {
  const { manifest, dependencies } = context;
  await revalidatePrivateContext(context);
  const inspectProcess = dependencies.inspectProcess ?? ((pid) => ({ alive: isProcessAlive(pid) }));
  if ((await inspectProcess(Number(manifest.pid))).alive) throw new Error(`Refusing to redact connection credentials while QA PID ${manifest.pid} is still alive.`);
  let connection = {};
  let connectionText;
  await revalidatePrivateContext(context);
  try { connectionText = await (dependencies.readFile ?? readFile)(manifest.connection, 'utf8'); } catch { /* overwrite unreadable credential state from trusted manifest identity */ }
  await revalidatePrivateContext(context);
  try { if (connectionText !== undefined) connection = JSON.parse(connectionText); } catch { /* overwrite malformed credential state from trusted manifest identity */ }
  const redacted = buildRedactedConnection(manifest, connection);
  await revalidatePrivateContext(context);
  await (dependencies.writeConnection ?? ((path, value) => atomicWriteJsonEvidence(path, value, { validate: (candidate) => validateRedactedConnection(candidate, manifest) })))(manifest.connection, redacted);
  return redacted;
}

export async function start(values, dependencies = {}) {
  const exe = resolve(required(values, 'exe'));
  const privateRoot = resolve(required(values, 'private-root'));
  const profile = resolve(required(values, 'profile'));
  const connection = resolve(required(values, 'connection'));
  const manifestPath = resolve(optional(values, 'manifest') ?? join(profile, 'qa-session.json'));
  const mode = optional(values, 'mode') ?? 'interactive';
  const launchContext = optional(values, 'launch-context');
  const authorityPolicy = optional(values, 'authority-policy');
  const trustedFolders = (values.get('trust-folder') ?? []).map((folder) => resolve(folder));
  assertEvidencePath(profile); assertEvidencePath(connection); assertEvidencePath(manifestPath);
  assertSeparateConnectionAndManifest(connection, manifestPath);
  if (process.platform === 'win32' && launchContext !== 'unsandboxed-gui') throw new Error('Refusing to launch native AIMuse from an unknown Windows context. Use shell escalation and --launch-context unsandboxed-gui.');
  if (!['interactive', 'headless'].includes(mode)) throw new Error('--mode must be interactive or headless.');
  if (authorityPolicy && !isAbsolute(authorityPolicy)) throw new Error('--authority-policy must be absolute.');
  const observedPrivateRoot = await observePrivateRoot(privateRoot, [profile, connection, manifestPath], dependencies);
  const accessPath = dependencies.accessPath ?? access;
  const hashExecutable = dependencies.hashExecutable ?? sha256;
  const mkdirPath = dependencies.mkdirPath ?? mkdir;
  await accessPath(exe); if (authorityPolicy) await accessPath(authorityPolicy);
  const exeSha256 = await hashExecutable(exe);
  const expectedProfileId = LEGACY_CERTIFIED_EXECUTABLES.has(exeSha256) ? undefined : profileIdForPath(profile);
  await mkdirPath(profile, { recursive: true }); await mkdirPath(dirname(connection), { recursive: true }); await mkdirPath(dirname(manifestPath), { recursive: true });
  for (const folder of trustedFolders) await mkdirPath(folder, { recursive: true });

  const startedAtMs = (dependencies.now ?? Date.now)();
  const args = [`--user-data-dir=${profile}`, ...(mode === 'headless' ? ['--headless'] : []), `--write-mcp-connection=${connection}`, ...(authorityPolicy ? [`--authority-policy=${resolve(authorityPolicy)}`] : []), ...trustedFolders.map((folder) => `--trust-folder=${folder}`)];
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const child = spawnProcess(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  if (!child.pid) throw new Error('AIMuse did not return a process ID.');
  const waitForReady = dependencies.waitForReady ?? waitForConnection;
  const ready = await waitForReady(connection, child.pid, expectedProfileId, startedAtMs);
  const manifest = { version: 1, startedAt: new Date(startedAtMs).toISOString(), exe, exeSha256, privateRoot, privateRootIdentity: normalizePrivateRootIdentity(observedPrivateRoot.identity), profile, profileId: ready.connection.profileId, connection, mode, launchContext, authorityPolicy: authorityPolicy ? resolve(authorityPolicy) : undefined, pid: child.pid, instanceId: ready.connection.instanceId, mcpUrl: ready.connection.url, healthUrl: ready.health.url, trustedFolders, windowRequested: mode === 'interactive' };
  await (dependencies.writeManifest ?? writeManifest)(manifestPath, manifest);
  (dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
}

async function readGuardedConnection(context) {
  await revalidatePrivateContext(context);
  const connection = JSON.parse(await (context.dependencies.readFile ?? readFile)(context.manifest.connection, 'utf8'));
  await revalidatePrivateContext(context);
  return connection;
}
async function guardedHashExecutable(context) {
  await revalidatePrivateContext(context);
  return (context.dependencies.hashExecutable ?? sha256)(context.manifest.exe);
}
async function guardedInspectProcess(context, pid) {
  await revalidatePrivateContext(context);
  return (context.dependencies.inspectProcess ?? ((value) => ({ alive: isProcessAlive(value) })))(pid);
}
async function guardedProbeHealth(context, url, pid, instanceId, profileId) {
  await revalidatePrivateContext(context);
  return (context.dependencies.probeHealth ?? health)(url, pid, instanceId, profileId);
}
async function guardedWriteManifest(context, manifest) {
  await revalidatePrivateContext(context);
  return (context.dependencies.writeManifest ?? writeManifest)(context.manifestPath, manifest);
}
async function guardedOutput(context, value) {
  await revalidatePrivateContext(context);
  return (context.dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(value);
}

export async function show(values, dependencies = {}) {
  const context = await loadManifest(values, dependencies);
  const { manifestPath, manifest } = context;
  const coordinated = await coordinateShow({ manifest, requestId: dependencies.requestId ?? randomUUID() }, {
    hashExecutable: () => guardedHashExecutable(context),
    readConnection: () => readGuardedConnection(context),
    inspectProcess: (pid) => guardedInspectProcess(context, pid),
    probeHealth: (url, pid, instanceId, profileId) => guardedProbeHealth(context, url, pid, instanceId, profileId),
    launchWindowRequest: async (target) => {
      await revalidatePrivateContext(context);
      return (dependencies.launchWindowRequest ?? (({ exe, arguments: launchArguments }) => spawn(exe, launchArguments, { detached: false, stdio: 'ignore', windowsHide: false })))(target);
    },
    waitForChildExit: async (child, timeoutMs) => {
      await revalidatePrivateContext(context);
      return (dependencies.waitForChildExit ?? waitForExit)(child, timeoutMs);
    },
    now: dependencies.now ?? (() => Date.now()),
    nowIso: dependencies.nowIso ?? (() => new Date().toISOString()),
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolveWait) => globalThis.setTimeout(resolveWait, milliseconds))),
    writeManifest: (updated) => guardedWriteManifest(context, updated),
  });
  await guardedOutput(context, `${JSON.stringify({ manifestPath, pid: manifest.pid, mcpUrl: manifest.mcpUrl, windowRequested: true, windowRequestId: coordinated.acknowledgement.requestId, windowAcknowledgedAt: coordinated.acknowledgement.acknowledgedAt }, null, 2)}\n`);
}

export async function status(values, dependencies = {}) {
  const context = await loadManifest(values, dependencies);
  const { manifestPath, manifest } = context;
  const currentHash = await guardedHashExecutable(context);
  const connection = await readGuardedConnection(context);
  const hashMatches = currentHash === manifest.exeSha256;
  const pidMatches = Number(connection.pid) === Number(manifest.pid);
  const urlMatches = connection.url === manifest.mcpUrl;
  let connectionInstanceId; let instanceMatches = false; let connectionProfileId; let profileMatches = false;
  try { connectionInstanceId = normalizeInstanceId(connection.instanceId, 'QA connection engine instance ID'); instanceMatches = connectionInstanceId === manifest.instanceId; } catch { /* invalid instance remains a static mismatch */ }
  try { connectionProfileId = normalizeProfileId(connection.profileId, 'QA connection profile ID'); profileMatches = connectionProfileId === manifest.profileId; } catch { /* invalid profile remains a static mismatch */ }
  const staticIdentityMatches = hashMatches && pidMatches && urlMatches && instanceMatches && profileMatches;
  let processAlive = null; let processInspection = 'skipped'; let healthResult; let healthError; let healthSkipped = 'static identity mismatch';
  if (staticIdentityMatches) {
    processInspection = 'performed'; processAlive = Boolean((await guardedInspectProcess(context, Number(manifest.pid))).alive);
    if (processAlive) {
      healthSkipped = undefined;
      try { healthResult = await guardedProbeHealth(context, manifest.mcpUrl, manifest.pid, manifest.instanceId, manifest.profileId); } catch (error) { healthError = error instanceof Error ? error.message : String(error); }
    } else healthSkipped = 'process not alive';
  }
  const result = { manifestPath, exe: manifest.exe, expectedSha256: manifest.exeSha256, currentSha256: currentHash, hashMatches, pid: manifest.pid, processAlive, processInspection, connectionPid: connection.pid, pidMatches, instanceId: manifest.instanceId, connectionInstanceId, instanceMatches, profileId: manifest.profileId, connectionProfileId, profileMatches, mcpUrl: manifest.mcpUrl, connectionUrl: connection.url, urlMatches, health: healthResult ?? (healthError ? { error: healthError } : { skipped: healthSkipped }), profile: manifest.profile, mode: manifest.mode, windowRequested: Boolean(manifest.windowRequested) };
  const okay = staticIdentityMatches && processAlive === true && Boolean(healthResult);
  await guardedOutput(context, `${JSON.stringify({ okay, ...result }, null, 2)}\n`); if (!okay) (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
}

export async function stop(values, dependencies = {}) {
  const context = await loadManifest(values, dependencies);
  const { manifestPath, manifest } = context;
  await assertExecutableIdentity(manifest, 'stop AIMuse', () => guardedHashExecutable(context));
  const connection = await readGuardedConnection(context);
  assertConnectionIdentity(manifest, connection, 'stop AIMuse');
  const coordinated = await coordinateStop({ pid: manifest.pid, mcpUrl: manifest.mcpUrl, instanceId: manifest.instanceId, profileId: manifest.profileId }, {
    inspectProcess: (pid) => guardedInspectProcess(context, pid),
    probeHealth: (url, pid, instanceId, profileId) => guardedProbeHealth(context, url, pid, instanceId, profileId),
    signal: async ({ instanceId }) => {
      await revalidatePrivateContext(context);
      const args = [`--user-data-dir=${manifest.profile}`, '--quit-engine', ...(instanceId ? [`--quit-engine-instance=${instanceId}`] : [])];
      const child = (dependencies.signalProcess ?? ((exe, signalArguments) => spawn(exe, signalArguments, { detached: false, stdio: 'ignore', windowsHide: true })))(manifest.exe, args);
      return (dependencies.waitForChildExit ?? waitForExit)(child);
    },
  });
  const signalExitCode = coordinated.signalResult;
  const completion = await waitForStopCompletion({ pid: manifest.pid, mcpUrl: manifest.mcpUrl, instanceId: coordinated.instanceId, profileId: coordinated.profileId, processIdentity: coordinated.processIdentity, healthIdentity: coordinated.healthIdentity }, {
    now: dependencies.now ?? (() => Date.now()),
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolveWait) => globalThis.setTimeout(resolveWait, milliseconds))),
    inspectProcess: (pid) => guardedInspectProcess(context, pid),
    probeHealth: async (url) => { await revalidatePrivateContext(context); try { return await (dependencies.fetchHealth ?? fetchHealth)(url); } catch { return { unavailable: true }; } },
    redact: () => redactConnection(context),
  });
  const updated = buildStopManifest(manifest, completion);
  await guardedWriteManifest(context, updated);
  await guardedOutput(context, `${JSON.stringify({ manifestPath, signalExitCode, pid: manifest.pid, stopped: completion.stopped, stopOutcome: completion.outcome, stopReason: completion.reason, connectionCredentialsRedacted: completion.connectionCredentialsRedacted }, null, 2)}\n`); if (completion.outcome !== 'stopped-redacted') (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
}
export async function redact(values, dependencies = {}) {
  const context = await loadManifest(values, dependencies);
  const { manifestPath, manifest } = context; await redactConnection(context);
  await guardedWriteManifest(context, { ...manifest, connectionCredentialsRedacted: true });
  await guardedOutput(context, `${JSON.stringify({ manifestPath, pid: manifest.pid, connectionCredentialsRedacted: true }, null, 2)}\n`);
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (!command || ['help', '--help', '-h'].includes(command)) process.stdout.write(HELP);
  else if (command === 'start') await start(values);
  else if (command === 'show') await show(values);
  else if (command === 'status') await status(values);
  else if (command === 'stop') await stop(values);
  else if (command === 'redact') await redact(values);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
