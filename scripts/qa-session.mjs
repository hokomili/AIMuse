import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { atomicWriteJsonEvidence, buildRedactedConnection, validateRedactedConnection } from './qa-evidence.mjs';
import { buildStopManifest, coordinateShow, coordinateStop, normalizeInstanceId, normalizeProfileId, profileIdForPath, validateHealthIdentity, waitForConnectionReadiness, waitForStopCompletion } from './qa-lifecycle.mjs';
import { resolveSubjectPath, verifyPackageSubject } from './package-subject.mjs';
import { assertOwnerPrivateRoot, assertPrivateRootDeclaration, normalizePrivateRootIdentity } from './qa-private-root.mjs';

const LEGACY_CERTIFIED_EXECUTABLES = new Set([
  'E558EA355F7AB40391BC38FD918ECFB418451F39C0DE520B58BCE8ABE99EC412',
  'CFCC482C04C21124D82E857428B561DB5FAB60A3A61390E8535471E99E830621',
]);

const HELP = `AIMuse isolated QA session

Usage:
  node scripts/qa-session.mjs start --exe <AIMuse.exe> --private-root <dir> --profile <dir> --connection <json> --launch-context unsandboxed-gui [--manifest <json>] [--mode interactive|headless] [--authority-policy <json>] [--trust-folder <dir> ...] [--package-subject-manifest <json> --package-subject-manifest-sha256 <sha256>]
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
function packageSubjectRequest(values, environment = process.env) {
  const manifestValue = optional(values, 'package-subject-manifest') ?? environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const digestValue = optional(values, 'package-subject-manifest-sha256') ?? environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  if (!manifestValue && !digestValue) return undefined;
  if (!manifestValue || !digestValue) throw new Error('Package subject binding requires both --package-subject-manifest/AIMUSE_PACKAGE_SUBJECT_MANIFEST and --package-subject-manifest-sha256/AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256.');
  if (!/^[a-f\d]{64}$/iu.test(digestValue)) throw new Error('Package subject manifest SHA-256 must be 64 hexadecimal characters.');
  return { manifestPath: resolve(manifestValue), expectedManifestSha256: digestValue.toUpperCase() };
}
function persistedPackageSubject(manifestPath, value) {
  const fields = ['packageSubjectManifest', 'packageSubjectManifestSha256', 'packageSubjectIdentitySha256'];
  const present = fields.filter((field) => value[field] !== undefined);
  if (!present.length) return undefined;
  if (present.length !== fields.length || typeof value.packageSubjectManifest !== 'string' || !isAbsolute(value.packageSubjectManifest) ||
      typeof value.packageSubjectManifestSha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(value.packageSubjectManifestSha256) ||
      typeof value.packageSubjectIdentitySha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(value.packageSubjectIdentitySha256)) {
    throw new Error(`Invalid QA session package subject binding: ${manifestPath}`);
  }
  return {
    manifestPath: resolve(value.packageSubjectManifest),
    expectedManifestSha256: value.packageSubjectManifestSha256.toUpperCase(),
    expectedSubjectIdentitySha256: value.packageSubjectIdentitySha256.toUpperCase(),
  };
}
async function verifySubjectBinding(request, exe, dependencies = {}) {
  if (!request) return undefined;
  const workspace = resolve(dependencies.workspace ?? '.');
  const verifySubject = dependencies.verifyPackageSubject ?? verifyPackageSubject;
  const result = await verifySubject({ workspace, manifestPath: request.manifestPath, expectedManifestSha256: request.expectedManifestSha256, platform: dependencies.platform ?? process.platform });
  const identity = result?.manifest?.subject?.identitySha256;
  const declaredExecutable = result?.manifest?.subject?.files?.applicationExecutable?.path;
  if (typeof identity !== 'string' || !/^[a-f\d]{64}$/iu.test(identity) || typeof declaredExecutable !== 'string') throw new Error('Verified package subject did not return a complete subject identity.');
  const subjectExecutable = resolveSubjectPath(workspace, declaredExecutable);
  if (resolve(exe) !== subjectExecutable) throw new Error(`QA session --exe does not match the verified package subject executable: ${exe}`);
  const binding = {
    manifestPath: resolve(result.manifestPath),
    manifestSha256: String(result.manifestSha256).toUpperCase(),
    subjectIdentitySha256: identity.toUpperCase(),
  };
  if (binding.manifestPath !== resolve(request.manifestPath) || binding.manifestSha256 !== request.expectedManifestSha256) throw new Error('Verified package subject result does not match the requested manifest binding.');
  if (request.expectedSubjectIdentitySha256 && binding.subjectIdentitySha256 !== request.expectedSubjectIdentitySha256) throw new Error('Verified package subject identity does not match the persisted QA session binding.');
  return binding;
}
function assertSubjectBindingStable(before, after) {
  if (!before && !after) return;
  if (!before || !after || before.manifestPath !== after.manifestPath || before.manifestSha256 !== after.manifestSha256 || before.subjectIdentitySha256 !== after.subjectIdentitySha256) throw new Error('Package subject identity drifted during QA session handoff.');
}
function subjectManifestFields(binding) {
  return binding ? {
    packageSubjectManifest: binding.manifestPath,
    packageSubjectManifestSha256: binding.manifestSha256,
    packageSubjectIdentitySha256: binding.subjectIdentitySha256,
  } : {};
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
  const packageSubject = persistedPackageSubject(manifestPath, value);
  const manifest = { ...value, exe: resolve(value.exe), privateRoot, privateRootIdentity: normalizePrivateRootIdentity(value.privateRootIdentity, 'QA session private root identity'), profile, connection: resolve(value.connection), pid: Number(value.pid), exeSha256, mcpUrl: mcpUrl.toString(), instanceId: normalizeInstanceId(value.instanceId, 'QA session engine instance ID'), profileId, ...(packageSubject ? subjectManifestFields({ manifestPath: packageSubject.manifestPath, manifestSha256: packageSubject.expectedManifestSha256, subjectIdentitySha256: packageSubject.expectedSubjectIdentitySha256 }) : {}) };
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
async function fetchHealth(url, token) {
  if (typeof token !== 'string' || !token) throw new Error('Authenticated health probing requires the private engine authority.');
  const healthUrl = new globalThis.URL(url); healthUrl.pathname = '/health'; healthUrl.search = '';
  const response = await globalThis.fetch(healthUrl, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: globalThis.AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`Health endpoint returned ${response.status}.`);
  let body;
  try { body = await response.json(); } catch { throw new Error('Health endpoint did not return JSON.'); }
  return { url: healthUrl.toString(), body };
}
async function health(url, expectedPid, expectedInstanceId, expectedProfileId, token) {
  const probe = await fetchHealth(url, token);
  return { ...probe, ...validateHealthIdentity(probe.body, expectedPid, expectedInstanceId, expectedProfileId) };
}
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function statusProcessInspection(pid) {
  process.kill(pid, 0);
  return { alive: true, pid };
}

function inspectionErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code.toUpperCase() : undefined;
}

function normalizeStatusProcessInspection(value, expectedPid) {
  if (typeof value === 'boolean') return { alive: value, supported: true, denied: false, status: value ? 'alive' : 'absent', identityMatches: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Status process inspection must return a boolean or object.');
  if (value.pid !== undefined && (!Number.isSafeInteger(Number(value.pid)) || Number(value.pid) !== Number(expectedPid))) {
    return { alive: value.alive === true ? true : null, supported: true, denied: false, status: 'identity-mismatch', identityMatches: false };
  }
  if (value.identityMatches === false || value.status === 'identity-mismatch') {
    return { alive: value.alive === true ? true : null, supported: value.supported !== false, denied: false, status: 'identity-mismatch', identityMatches: false };
  }
  if (value.status === 'permission-denied' || value.denied === true) return { alive: null, supported: false, denied: true, status: 'permission-denied', identityMatches: null };
  if (value.status === 'unsupported' || value.supported === false) return { alive: null, supported: false, denied: false, status: 'unsupported', identityMatches: null };
  if (value.status === 'absent' || value.alive === false) return { alive: false, supported: true, denied: false, status: 'absent', identityMatches: value.identityMatches ?? null };
  if (value.status === 'alive' || value.alive === true) return { alive: true, supported: true, denied: false, status: 'alive', identityMatches: value.identityMatches ?? null };
  throw new Error('Status process inspection did not report a supported tri-state result.');
}

function statusInspectionFromError(error) {
  const code = inspectionErrorCode(error);
  if (code === 'ESRCH') return { alive: false, supported: true, denied: false, status: 'absent', identityMatches: null };
  if (code === 'EPERM') return { alive: null, supported: false, denied: true, status: 'permission-denied', identityMatches: null };
  if (['ENOSYS', 'ENOTSUP'].includes(code)) return { alive: null, supported: false, denied: false, status: 'unsupported', identityMatches: null };
  throw error;
}

function expectedHealthUrl(mcpUrl) {
  const url = new globalThis.URL(mcpUrl);
  url.pathname = '/health';
  url.search = '';
  return url.toString();
}

function exactStatusHealth(value, manifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)) throw new Error('Status health probe did not return an exact response body.');
  const expectedUrl = expectedHealthUrl(manifest.mcpUrl);
  if (value.url !== expectedUrl) throw new Error(`Status health URL mismatch: expected ${expectedUrl}, received ${String(value.url)}.`);
  const body = value.body;
  validateHealthIdentity(body, manifest.pid, manifest.instanceId, manifest.profileId);
  if (typeof body.pid !== 'number' || !Number.isSafeInteger(body.pid) || body.pid !== Number(manifest.pid)) throw new Error('Status health PID is missing or not exact.');
  if (normalizeInstanceId(body.instanceId, 'status health engine instance ID') !== manifest.instanceId) throw new Error('Status health instance identity is missing or not exact.');
  if (normalizeProfileId(body.profileId, 'status health profile ID') !== manifest.profileId) throw new Error('Status health profile identity is missing or not exact.');
  return value;
}

function normalizeStatusHealth(value, manifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Status health probe must return an object.');
  const body = value.body && typeof value.body === 'object' && !Array.isArray(value.body) ? value.body : value;
  const identity = validateHealthIdentity(body, manifest.pid, manifest.instanceId, manifest.profileId);
  return value.body ? { ...value, ...identity } : identity;
}

function statusConnectionIdentity(manifest, connection) {
  const pidMatches = typeof connection.pid === 'number' && Number.isSafeInteger(connection.pid) && connection.pid === Number(manifest.pid);
  const urlMatches = typeof connection.url === 'string' && connection.url === manifest.mcpUrl;
  let instanceId; let instanceMatches = false; let profileId; let profileMatches = false;
  try { instanceId = normalizeInstanceId(connection.instanceId, 'QA connection engine instance ID'); instanceMatches = instanceId === manifest.instanceId; } catch { /* invalid instance remains a static mismatch */ }
  try { profileId = normalizeProfileId(connection.profileId, 'QA connection profile ID'); profileMatches = profileId === manifest.profileId; } catch { /* invalid profile remains a static mismatch */ }
  return { pidMatches, urlMatches, instanceId, instanceMatches, profileId, profileMatches, matches: pidMatches && urlMatches && instanceMatches && profileMatches };
}

async function probeAuthenticatedMcp(url, token) {
  if (typeof token !== 'string' || !token) return { verified: false, httpStatus: null, result: 'missing-credential' };
  let response;
  try {
    response = await globalThis.fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(1_500),
    });
  } catch {
    return { verified: false, httpStatus: null, result: 'probe-failed' };
  }
  let body;
  try { body = await response.json(); } catch { return { verified: false, httpStatus: response.status, result: 'invalid-response' }; }
  const exactBody = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && body.error === 'initialization_required';
  if (response.status !== 400 || !exactBody) return { verified: false, httpStatus: response.status, result: response.status === 401 ? 'invalid-token' : 'unexpected-response' };
  return { verified: true, httpStatus: 400, result: 'initialization_required' };
}

function normalizeAuthenticationProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { verified: false, httpStatus: null, result: 'invalid-proof' };
  const httpStatus = Number.isInteger(value.httpStatus) ? value.httpStatus : null;
  if (value.verified === true && httpStatus === 400 && value.result === 'initialization_required') return { verified: true, httpStatus, result: value.result };
  const allowedResults = new Set(['invalid-proof', 'missing-credential', 'probe-failed', 'invalid-response', 'invalid-token', 'unexpected-response']);
  return { verified: false, httpStatus, result: allowedResults.has(value.result) ? value.result : 'invalid-proof' };
}

async function waitForConnection(connectionPath, expectedPid, expectedProfileId, startedAt) {
  return waitForConnectionReadiness({ connectionPath, expectedPid, expectedProfileId, startedAt }, {
    now: () => Date.now(),
    statConnection: (path) => stat(path),
    readConnection: (path) => readFile(path, 'utf8'),
    probeHealth: (url, pid, instanceId, profileId, token) => health(url, pid, instanceId, profileId, token),
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
  const request = persistedPackageSubject(manifestPath, manifest);
  if (request) context.packageSubjectBinding = await verifySubjectBinding(request, manifest.exe, dependencies);
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
  const subjectRequest = packageSubjectRequest(values, dependencies.environment ?? process.env);
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
  const initialSubjectBinding = await verifySubjectBinding(subjectRequest, exe, dependencies);
  const exeSha256 = await hashExecutable(exe);
  const expectedProfileId = LEGACY_CERTIFIED_EXECUTABLES.has(exeSha256) ? undefined : profileIdForPath(profile);
  const privateDirectoryOptions = { recursive: true, mode: 0o700 };
  await mkdirPath(profile, privateDirectoryOptions); await mkdirPath(dirname(connection), privateDirectoryOptions); await mkdirPath(dirname(manifestPath), privateDirectoryOptions);
  for (const folder of trustedFolders) await mkdirPath(folder, privateDirectoryOptions);

  const startedAtMs = (dependencies.now ?? Date.now)();
  const args = [`--user-data-dir=${profile}`, ...(mode === 'headless' ? ['--headless'] : []), `--write-mcp-connection=${connection}`, ...(authorityPolicy ? [`--authority-policy=${resolve(authorityPolicy)}`] : []), ...trustedFolders.map((folder) => `--trust-folder=${folder}`)];
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const child = spawnProcess(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  if (!child.pid) throw new Error('AIMuse did not return a process ID.');
  const waitForReady = dependencies.waitForReady ?? waitForConnection;
  const ready = await waitForReady(connection, child.pid, expectedProfileId, startedAtMs);
  const handoffSubjectBinding = await verifySubjectBinding(subjectRequest, exe, dependencies);
  assertSubjectBindingStable(initialSubjectBinding, handoffSubjectBinding);
  const manifest = { version: 1, startedAt: new Date(startedAtMs).toISOString(), exe, exeSha256, privateRoot, privateRootIdentity: normalizePrivateRootIdentity(observedPrivateRoot.identity), profile, profileId: ready.connection.profileId, connection, mode, launchContext, authorityPolicy: authorityPolicy ? resolve(authorityPolicy) : undefined, pid: child.pid, instanceId: ready.connection.instanceId, mcpUrl: ready.connection.url, healthUrl: ready.health.url, trustedFolders, windowRequested: mode === 'interactive', ...subjectManifestFields(handoffSubjectBinding) };
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
async function guardedInspectStatusProcess(context, pid) {
  await revalidatePrivateContext(context);
  return (context.dependencies.inspectProcess ?? statusProcessInspection)(pid);
}
async function guardedProbeHealth(context, url, pid, instanceId, profileId) {
  await revalidatePrivateContext(context);
  const connection = await readGuardedConnection(context);
  return (context.dependencies.probeHealth ?? health)(url, pid, instanceId, profileId, connection.token);
}
async function guardedProbeMcpAuthentication(context, url, token) {
  await revalidatePrivateContext(context);
  return (context.dependencies.probeMcpAuthentication ?? probeAuthenticatedMcp)(url, token);
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
  const connectionIdentity = statusConnectionIdentity(manifest, connection);
  const staticIdentityMatches = hashMatches && connectionIdentity.matches;
  let inspection = { alive: null, supported: null, denied: false, status: 'skipped-static-identity-mismatch', identityMatches: null };
  let healthResult; let healthError; let healthSkipped = 'static identity mismatch';
  let authentication = { verified: false, httpStatus: null, result: 'not-required' };
  let inspectionFallbackVerified = false;
  if (staticIdentityMatches) {
    try { inspection = normalizeStatusProcessInspection(await guardedInspectStatusProcess(context, Number(manifest.pid)), manifest.pid); }
    catch (error) { inspection = statusInspectionFromError(error); }
    if (inspection.status === 'alive') {
      healthSkipped = undefined;
      try { healthResult = normalizeStatusHealth(await guardedProbeHealth(context, manifest.mcpUrl, manifest.pid, manifest.instanceId, manifest.profileId), manifest); } catch (error) { healthError = error instanceof Error ? error.message : String(error); }
    } else if (inspection.status === 'absent') healthSkipped = 'process absent';
    else if (inspection.status === 'identity-mismatch') healthSkipped = 'process identity mismatch';
    else {
      const darwinFallback = privateRootPlatform(dependencies) === 'darwin' && inspection.status === 'permission-denied';
      if (!darwinFallback) healthSkipped = 'process inspection unavailable';
      else if (!context.packageSubjectBinding) healthSkipped = 'verified package subject required';
      else {
        healthSkipped = undefined;
        try { healthResult = exactStatusHealth(normalizeStatusHealth(await guardedProbeHealth(context, manifest.mcpUrl, manifest.pid, manifest.instanceId, manifest.profileId), manifest), manifest); }
        catch (error) { healthError = error instanceof Error ? error.message : String(error); }
        if (healthResult) {
          authentication = normalizeAuthenticationProof(await guardedProbeMcpAuthentication(context, manifest.mcpUrl, connection.token));
          if (authentication.verified) {
            const finalConnection = await readGuardedConnection(context);
            const finalIdentity = statusConnectionIdentity(manifest, finalConnection);
            if (!finalIdentity.matches || finalConnection.token !== connection.token) authentication = { verified: false, httpStatus: authentication.httpStatus, result: 'connection-drift' };
            else {
              const request = persistedPackageSubject(manifestPath, manifest);
              const rebound = await verifySubjectBinding(request, manifest.exe, dependencies);
              assertSubjectBindingStable(context.packageSubjectBinding, rebound);
              const finalHash = await guardedHashExecutable(context);
              if (finalHash !== manifest.exeSha256) authentication = { verified: false, httpStatus: authentication.httpStatus, result: 'executable-drift' };
              else {
                try { healthResult = exactStatusHealth(normalizeStatusHealth(await guardedProbeHealth(context, manifest.mcpUrl, manifest.pid, manifest.instanceId, manifest.profileId), manifest), manifest); inspectionFallbackVerified = true; }
                catch (error) { healthResult = undefined; healthError = error instanceof Error ? error.message : String(error); }
              }
            }
          }
        }
      }
    }
  }
  const processInspection = inspection.status.startsWith('skipped-') ? 'skipped' : inspection.denied ? 'denied' : inspection.supported ? 'performed' : 'unsupported';
  const result = {
    manifestPath,
    exe: manifest.exe,
    expectedSha256: manifest.exeSha256,
    currentSha256: currentHash,
    hashMatches,
    packageSubjectVerified: Boolean(context.packageSubjectBinding),
    ...(context.packageSubjectBinding ? { packageSubjectManifest: context.packageSubjectBinding.manifestPath, packageSubjectManifestSha256: context.packageSubjectBinding.manifestSha256, packageSubjectIdentitySha256: context.packageSubjectBinding.subjectIdentitySha256 } : {}),
    pid: manifest.pid,
    processAlive: inspection.alive,
    processInspection,
    processInspectionSupported: inspection.supported,
    processInspectionDenied: inspection.denied,
    processInspectionStatus: inspection.status,
    processIdentityMatches: inspection.identityMatches,
    inspectionFallbackVerified,
    connectionPid: connection.pid,
    pidMatches: connectionIdentity.pidMatches,
    instanceId: manifest.instanceId,
    connectionInstanceId: connectionIdentity.instanceId,
    instanceMatches: connectionIdentity.instanceMatches,
    profileId: manifest.profileId,
    connectionProfileId: connectionIdentity.profileId,
    profileMatches: connectionIdentity.profileMatches,
    mcpUrl: manifest.mcpUrl,
    connectionUrl: connection.url,
    urlMatches: connectionIdentity.urlMatches,
    health: healthResult ?? (healthError ? { error: healthError } : { skipped: healthSkipped }),
    mcpAuthentication: authentication,
    profile: manifest.profile,
    mode: manifest.mode,
    windowRequested: Boolean(manifest.windowRequested),
  };
  const processVerified = inspection.status === 'alive' || inspectionFallbackVerified;
  const okay = staticIdentityMatches && processVerified && Boolean(healthResult);
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
    probeHealth: async (url) => { await revalidatePrivateContext(context); try { return await (dependencies.fetchHealth ?? fetchHealth)(url, connection.token); } catch { return { unavailable: true }; } },
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
