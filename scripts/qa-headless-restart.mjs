import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { atomicWriteJsonEvidence } from './qa-evidence.mjs';
import { resolveSubjectPath, verifyPackageSubject } from './package-subject-verifier.mjs';
import { inspectOwnerPrivatePath as inspectPrivatePath, protectOwnerPrivateRoot as protectRunRoot } from './qa-private-root.mjs';

export { assertPrivateWindowsAcl } from './qa-private-root.mjs';

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[0-9a-f]{64}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const EPHEMERAL_MCP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_CREDENTIAL_KEYS = new Set(['apikey', 'authorization', 'password', 'secret', 'sessionid', 'token', 'tokenhint']);

const HELP = `AIMuse isolated headless bootstrap/restart acceptance

Usage:
  node scripts/qa-headless-restart.mjs --exe <AIMuse executable> --expected-sha256 <64 hex> --run-root <new directory below test-results> [--package-subject-manifest <json> --package-subject-manifest-sha256 <sha256>]

The run root must not already exist. On Windows this command must run as one
whole command outside the filesystem sandbox so the packaged process and its
instance-bound quit helper share the real launching user and protected ACL.
No window is requested or accepted by this harness.
`;

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    const key = separator >= 0 ? argument.slice(2, separator) : argument.slice(2);
    const value = separator >= 0 ? argument.slice(separator + 1) : arguments_[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    values.set(key, value);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

export function resolvePackageSubjectRequest(values, environment = process.env) {
  const manifestValue = values.get('package-subject-manifest') ?? environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST;
  const digestValue = values.get('package-subject-manifest-sha256') ?? environment.AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256;
  if (!manifestValue && !digestValue) return undefined;
  if (!manifestValue || !digestValue) throw new Error('Package subject binding requires both --package-subject-manifest/AIMUSE_PACKAGE_SUBJECT_MANIFEST and --package-subject-manifest-sha256/AIMUSE_PACKAGE_SUBJECT_MANIFEST_SHA256.');
  if (!SHA256.test(digestValue)) throw new Error('Package subject manifest SHA-256 must be 64 hexadecimal characters.');
  return { manifestPath: resolve(manifestValue), expectedManifestSha256: digestValue.toUpperCase() };
}

export async function verifyHeadlessPackageSubject({ exe, request, workspace = resolve('.'), platform = process.platform, verifySubject = verifyPackageSubject }) {
  if (!request) return undefined;
  const result = await verifySubject({ workspace, manifestPath: request.manifestPath, expectedManifestSha256: request.expectedManifestSha256, platform });
  const identity = result?.manifest?.subject?.identitySha256;
  const declaredExecutable = result?.manifest?.subject?.files?.applicationExecutable?.path;
  if (typeof identity !== 'string' || !SHA256.test(identity) || typeof declaredExecutable !== 'string') throw new Error('Verified package subject did not return a complete subject identity.');
  const subjectExecutable = resolveSubjectPath(workspace, declaredExecutable);
  if (resolve(exe) !== subjectExecutable) throw new Error(`Headless --exe does not match the verified package subject executable: ${exe}`);
  const binding = { manifestPath: resolve(result.manifestPath), manifestSha256: String(result.manifestSha256).toUpperCase(), subjectIdentitySha256: identity.toUpperCase() };
  if (binding.manifestPath !== resolve(request.manifestPath) || binding.manifestSha256 !== request.expectedManifestSha256) throw new Error('Verified package subject result does not match the requested manifest binding.');
  return binding;
}

export function assertPackageSubjectEvidence(value, expected) {
  if (!expected) {
    if (value !== undefined) throw new Error('Unexpected package subject evidence in a non-formal headless cycle.');
    return true;
  }
  const evidence = asRecord(value, 'Headless package subject evidence');
  if (resolve(evidence.manifestPath) !== expected.manifestPath || String(evidence.manifestSha256).toUpperCase() !== expected.manifestSha256 || String(evidence.subjectIdentitySha256).toUpperCase() !== expected.subjectIdentitySha256) throw new Error('Headless package subject evidence does not match the verified subject binding.');
  return true;
}

function assertPackageSubjectStable(before, after) {
  assertPackageSubjectEvidence(after, before);
}

export async function reverifyHeadlessPackageSubjectAtRestart(options) {
  const current = await verifyHeadlessPackageSubject(options);
  assertPackageSubjectStable(options.before, current);
  return current;
}

function within(root, path) {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
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
      if (result.code !== 0 && !options.allowFailure) reject(commandError(command, result));
      else resolveResult(result);
    });
  });
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function pathExists(path) {
  return access(path).then(() => true, () => false);
}

function parseJsonOutput(result, label) {
  try { return asRecord(JSON.parse(result.stdout), label); }
  catch { throw new Error(`${label} did not return one JSON object.`); }
}

function windowsPowerShell() {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function inspectWindow(pid) {
  if (process.platform !== 'win32') return { mainWindowHandle: 0, mainWindowTitle: '', checkedBy: 'not-applicable' };
  const script = [
    "$process = Get-Process -Id ([int]$env:AIMUSE_QA_PID) -ErrorAction Stop",
    "[pscustomobject]@{ mainWindowHandle = [int64]$process.MainWindowHandle; mainWindowTitle = [string]$process.MainWindowTitle } | ConvertTo-Json -Compress",
  ].join('; ');
  const result = await runCommand(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { AIMUSE_QA_PID: String(pid) } });
  const observation = asRecord(JSON.parse(result.stdout), 'AIMuse window observation');
  if (Number(observation.mainWindowHandle) !== 0 || String(observation.mainWindowTitle ?? '') !== '') throw new Error(`Headless AIMuse PID ${pid} owns a top-level window.`);
  return { mainWindowHandle: 0, mainWindowTitle: '', checkedBy: 'exact-pid-process-window-state' };
}

export function parseDarwinRelevantProcesses(output) {
  const names = new Set(['AIMuse', 'aimuse-audio', 'aimuse-plugin-scanner', 'aimuse-plugin-bridge']);
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match) return [];
    const name = basename(match[2].trim());
    if (!names.has(name) && !/^AIMuse Helper(?: \(.+\))?$/u.test(name)) return [];
    return [{ name, pid: Number(match[1]) }];
  });
}

async function relevantProcesses() {
  if (process.platform === 'darwin') {
    const result = await runCommand('/bin/ps', ['-ww', '-axo', 'pid=,comm=']);
    return parseDarwinRelevantProcesses(result.stdout);
  }
  if (process.platform !== 'win32') return [];
  const script = [
    "$names = @('AIMuse', 'aimuse-audio', 'aimuse-plugin-scanner', 'aimuse-plugin-bridge')",
    "$items = @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id } })",
    "$items | ConvertTo-Json -Compress",
  ].join('; ');
  const result = await runCommand(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  const trimmed = result.stdout.trim();
  if (!trimmed) return [];
  const value = JSON.parse(trimmed);
  return Array.isArray(value) ? value : [value];
}

function credentialKeys(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const entry of value) credentialKeys(entry, found);
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_CREDENTIAL_KEYS.has(key.toLowerCase())) found.add(key);
    credentialKeys(entry, found);
  }
  return found;
}

export function assertCredentialFreeEvidence(value, label) {
  const keys = [...credentialKeys(value)];
  if (keys.length) throw new Error(`${label} retains credential-bearing keys: ${keys.join(', ')}.`);
  if (JSON.stringify(value).match(/Bearer\s+[A-Za-z0-9._~+/=-]+/i)) throw new Error(`${label} retains a bearer value.`);
  return true;
}

export function validateRestartIdentity(firstValue, secondValue) {
  const first = asRecord(firstValue, 'First headless cycle');
  const second = asRecord(secondValue, 'Second headless cycle');
  for (const [label, cycle] of [['first', first], ['second', second]]) {
    if (!Number.isSafeInteger(Number(cycle.pid)) || Number(cycle.pid) <= 0) throw new Error(`Invalid ${label} headless PID.`);
    if (typeof cycle.instanceId !== 'string' || !INSTANCE_ID.test(cycle.instanceId)) throw new Error(`Invalid ${label} headless instance ID.`);
    if (typeof cycle.profileId !== 'string' || !PROFILE_ID.test(cycle.profileId)) throw new Error(`Invalid ${label} headless profile ID.`);
  }
  if (Number(first.pid) === Number(second.pid)) throw new Error('Headless restart reused the original PID.');
  if (first.instanceId.toLowerCase() === second.instanceId.toLowerCase()) throw new Error('Headless restart reused the original engine instance ID.');
  if (first.profileId.toUpperCase() !== second.profileId.toUpperCase()) throw new Error('Headless restart changed the isolated profile identity.');
  return { pidChanged: true, instanceChanged: true, profileRetained: true };
}

export function validateEphemeralAuthority(firstCredential, secondCredential) {
  if (!EPHEMERAL_MCP_TOKEN.test(firstCredential) || !EPHEMERAL_MCP_TOKEN.test(secondCredential)) throw new Error('Each headless cycle must receive a 32-byte base64url MCP authority token.');
  if (firstCredential === secondCredential) throw new Error('Headless restart reused engine-scoped MCP authority.');
  return { authorityRotated: true };
}

async function assertNoCredentialBytes(root, credentials) {
  const needles = [...new Set(credentials.filter((value) => typeof value === 'string' && value.length))].map((value) => Buffer.from(value));
  const visit = async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Headless evidence contains an unexpected symbolic link: ${path}.`);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    if (!info.isFile()) return;
    const bytes = await readFile(path);
    for (const needle of needles) if (bytes.includes(needle)) throw new Error(`A live localhost credential remained after cleanup: ${path}.`);
  };
  await visit(root);
}

function assertConnection(connectionValue, manifest, trustedFolder) {
  const connection = asRecord(connectionValue, 'Private MCP connection');
  if (connection.version !== 1 || connection.pid !== manifest.pid || connection.url !== manifest.mcpUrl || connection.instanceId !== manifest.instanceId || connection.profileId !== manifest.profileId) throw new Error('Private MCP connection identity does not match its session manifest.');
  if (typeof connection.token !== 'string' || connection.token.length < 32) throw new Error('Private MCP connection did not contain a strong bearer token.');
  if (JSON.stringify(connection.trustedFolders) !== JSON.stringify([trustedFolder])) throw new Error('Private MCP connection did not retain the exact trusted folder.');
  return connection;
}

async function runNodeScript(script, arguments_) {
  return runCommand(process.execPath, [resolve(script), ...arguments_]);
}

async function runCycle({ cycleName, exe, profile, authorityPolicy, trustedFolder, runRoot, privateRoot, packageSubject }) {
  const cycleRoot = join(runRoot, cycleName);
  const connectionPath = join(cycleRoot, 'connection.json');
  const manifestPath = join(cycleRoot, 'session.json');
  const mcpStatePath = join(cycleRoot, 'mcp-state.json');
  let started = false;
  let mcpOpen = false;
  let liveCredential;
  let cycleError;
  let cycleResult;
  const cleanupErrors = [];

  await mkdir(cycleRoot, { recursive: false, mode: 0o700 });
  await inspectPrivatePath(cycleRoot, privateRoot);

  try {
    const startResult = await runNodeScript('scripts/qa-session.mjs', [
      'start', '--exe', exe, '--private-root', runRoot, '--profile', profile, '--connection', connectionPath, '--manifest', manifestPath,
      '--mode', 'headless', '--launch-context', 'unsandboxed-gui', '--authority-policy', authorityPolicy,
      '--trust-folder', trustedFolder,
      ...(packageSubject ? ['--package-subject-manifest', packageSubject.manifestPath, '--package-subject-manifest-sha256', packageSubject.manifestSha256] : []),
    ]);
    const manifest = parseJsonOutput(startResult, `${cycleName} start`);
    started = true;
    const manifestPackageSubject = [manifest.packageSubjectManifest, manifest.packageSubjectManifestSha256, manifest.packageSubjectIdentitySha256].some((value) => value !== undefined) ? {
      manifestPath: manifest.packageSubjectManifest,
      manifestSha256: manifest.packageSubjectManifestSha256,
      subjectIdentitySha256: manifest.packageSubjectIdentitySha256,
    } : undefined;
    assertPackageSubjectEvidence(manifestPackageSubject, packageSubject);
    if (manifest.mode !== 'headless' || manifest.windowRequested !== false) throw new Error(`${cycleName} did not start in the declared no-window mode.`);
    const connection = assertConnection(JSON.parse(await readFile(connectionPath, 'utf8')), manifest, trustedFolder);
    liveCredential = connection.token;
    const connectionAcl = await inspectPrivatePath(connectionPath, privateRoot);
    const window = await inspectWindow(manifest.pid);

    const statusResult = await runNodeScript('scripts/qa-session.mjs', ['status', '--private-root', runRoot, '--manifest', manifestPath]);
    const status = parseJsonOutput(statusResult, `${cycleName} status`);
    if (status.okay !== true || status.mode !== 'headless' || status.windowRequested !== false) throw new Error(`${cycleName} status did not confirm the exact headless subject.`);
    if (status.health?.body?.uiRequired !== false) throw new Error(`${cycleName} health did not declare a UI-free engine.`);

    await runNodeScript('scripts/qa-mcp.mjs', [
      'init', '--private-root', runRoot, '--connection', connectionPath, '--state', mcpStatePath, '--actor-name', `AGT-04 ${cycleName}`,
      '--actor-color', cycleName === 'cycle-1' ? '#2563EB' : '#7C3AED', '--model', 'test-owned-headless',
      '--effort', 'contract', '--task-id', `agt04-${cycleName}`,
    ]);
    mcpOpen = true;
    await inspectPrivatePath(mcpStatePath, privateRoot);
    await runNodeScript('scripts/qa-mcp.mjs', ['close', '--private-root', runRoot, '--state', mcpStatePath]);
    mcpOpen = false;
    const closedMcp = JSON.parse(await readFile(mcpStatePath, 'utf8'));
    if (closedMcp.credentialsRedacted !== true) throw new Error(`${cycleName} MCP state was not credential-redacted.`);
    assertCredentialFreeEvidence(closedMcp, `${cycleName} MCP state`);

    const stopResult = await runNodeScript('scripts/qa-session.mjs', ['stop', '--private-root', runRoot, '--manifest', manifestPath]);
    const stop = parseJsonOutput(stopResult, `${cycleName} stop`);
    if (stop.stopped !== true || stop.stopOutcome !== 'stopped-redacted' || stop.connectionCredentialsRedacted !== true) throw new Error(`${cycleName} did not stop and redact gracefully.`);
    started = false;

    const stoppedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const redactedConnection = JSON.parse(await readFile(connectionPath, 'utf8'));
    if (stoppedManifest.stopOutcome !== 'stopped-redacted' || stoppedManifest.connectionCredentialsRedacted !== true || redactedConnection.credentialsRedacted !== true) throw new Error(`${cycleName} cleanup evidence is internally inconsistent.`);
    assertCredentialFreeEvidence(stoppedManifest, `${cycleName} stopped manifest`);
    assertCredentialFreeEvidence(redactedConnection, `${cycleName} redacted connection`);
    await inspectPrivatePath(connectionPath, privateRoot);
    await inspectPrivatePath(manifestPath, privateRoot);
    if ((await relevantProcesses()).length) throw new Error(`${cycleName} left an AIMuse process after graceful stop.`);

    cycleResult = {
      privateSummary: {
        cycle: cycleName,
        pid: manifest.pid,
        instanceId: manifest.instanceId,
        profileId: manifest.profileId,
        mcpUrl: manifest.mcpUrl,
        mode: manifest.mode,
        windowRequested: manifest.windowRequested,
        window,
        connectionAcl,
        authenticatedMcpJoinedAndClosed: true,
        stopOutcome: stop.stopOutcome,
        connectionCredentialsRedacted: true,
        ...(packageSubject ? { packageSubject } : {}),
      },
      credential: liveCredential,
    };
  } catch (error) {
    cycleError = error;
  } finally {
    if (mcpOpen && await pathExists(mcpStatePath)) {
      try { await runNodeScript('scripts/qa-mcp.mjs', ['close', '--private-root', runRoot, '--state', mcpStatePath]); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (started && await pathExists(manifestPath)) {
      try { await runNodeScript('scripts/qa-session.mjs', ['stop', '--private-root', runRoot, '--manifest', manifestPath]); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  if (cycleError && cleanupErrors.length) throw new AggregateError([cycleError, ...cleanupErrors], `${cycleName} failed and graceful cleanup also failed.`);
  if (cycleError) throw cycleError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `${cycleName} graceful cleanup failed.`);
  return cycleResult;
}

async function writeReport(path, summary) {
  const cycleLines = summary.cycles.map((cycle) => {
    const windowEvidence = cycle.window.checkedBy === 'not-applicable'
      ? 'no editor window requested (direct OS window enumeration was not applicable)'
      : 'exact-PID window inspection found no window handle or title';
    return `- ${cycle.cycle}: PID \`${cycle.pid}\`, instance \`${cycle.instanceId}\`, profile \`${cycle.profileId}\`, ${windowEvidence}, authenticated MCP join/DELETE, stop \`${cycle.stopOutcome}\`, connection redacted.`;
  }).join('\n');
  const rootProtection = summary.privateRoot.platform === 'win32'
    ? 'Windows inheritance was removed and ACL access was limited to the launching user, SYSTEM, and Administrators'
    : 'POSIX mode and ownership checks limited access to the launching user';
  const windowBoundary = summary.cycles.every((cycle) => cycle.window.checkedBy !== 'not-applicable')
    ? 'Exact-PID process-window inspection returned handle `0` and an empty title in both cycles.'
    : 'The harness requested no window and health declared `uiRequired: false`; direct macOS window enumeration belongs to the separate Computer Use gate.';
  const report = `# AIMuse AGT-04 isolated headless bootstrap/restart acceptance

## Outcome

- **PASS** for exact executable SHA-256 \`${summary.executable.sha256}\` at \`${summary.executable.path}\`.
${summary.packageSubject ? `- Package subject manifest \`${summary.packageSubject.manifestPath}\`, digest \`${summary.packageSubject.manifestSha256}\`, subject identity \`${summary.packageSubject.subjectIdentitySha256}\`.` : ''}
- This is a test-owned headless lifecycle acceptance, not a Luna/high certificate and not evidence for real UI, Electron renderer serialization, or Computer Use.

## Evidence

- Fresh protected run root: \`${summary.runRoot}\`.
- The root was absent before creation; ${rootProtection} before any localhost bearer token existed.
- The exact run-owned trusted folder was returned by both private connection handoffs.
${cycleLines}
- Restart used the same isolated profile identity but a distinct PID, fresh engine instance UUID, and fresh engine-scoped MCP authority. Each cycle authenticated from its newly read private handoff; neither authority value nor a derived hash is retained in this report.
- After both graceful stops, connection and MCP client state were credential-redacted, neither live token occurred anywhere below the run root, and the exact executable hash was unchanged.
- ${windowBoundary} The harness never requested show/attach and never acquired or injected desktop input.

## Boundaries

- This test-owned run does not replace or amend any formal independent Computer Use report.
- No real user/global configuration or credential was read.
- No force termination or unrelated-process control was used.
`;
  await writeFile(path, report, { encoding: 'utf8', mode: 0o600 });
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  if (values.has('help')) { process.stdout.write(HELP); return; }
  const exe = resolve(required(values, 'exe'));
  const expectedSha256 = required(values, 'expected-sha256').toUpperCase();
  const runRoot = resolve(required(values, 'run-root'));
  const packageSubjectRequest = resolvePackageSubjectRequest(values);
  const testResultsRoot = resolve('test-results');
  if (!SHA256.test(expectedSha256)) throw new Error('--expected-sha256 must be 64 hexadecimal characters.');
  if (!within(testResultsRoot, runRoot) || runRoot === testResultsRoot) throw new Error(`--run-root must be a new child below ${testResultsRoot}.`);
  if (await pathExists(runRoot)) throw new Error(`Headless acceptance root already exists: ${runRoot}.`);
  await access(exe);
  const initialHash = await sha256(exe);
  if (initialHash !== expectedSha256) throw new Error(`Executable hash mismatch: expected ${expectedSha256}, received ${initialHash}.`);
  const packageSubject = await verifyHeadlessPackageSubject({ exe, request: packageSubjectRequest });
  const initialProcesses = await relevantProcesses();
  if (initialProcesses.length) throw new Error('Refusing to start while an AIMuse process already exists.');

  await mkdir(dirname(runRoot), { recursive: true });
  await mkdir(runRoot, { recursive: false, mode: 0o700 });
  const privateRoot = await protectRunRoot(runRoot);
  const profile = join(runRoot, 'profile');
  const trustedFolder = join(runRoot, 'trusted');
  const authorityPolicy = join(runRoot, 'authority-policy.json');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(trustedFolder, { recursive: true, mode: 0o700 });
  const issuedAt = new Date();
  const policy = {
    version: 1,
    id: `agt04-headless-restart-${issuedAt.toISOString()}`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 2 * 60 * 60_000).toISOString(),
    maxRuntimeMinutes: 120,
    readRoots: [], writeRoots: [], overwritePaths: [], pluginAllowlist: [],
    allowMicrophone: false, allowMidiInput: false, allowMidiOutput: false,
  };
  await atomicWriteJsonEvidence(authorityPolicy, policy, { validate: (value) => {
    if (value.id !== policy.id || !Array.isArray(value.readRoots) || !Array.isArray(value.writeRoots)) throw new Error('Invalid test-owned authority policy.');
  } });
  await inspectPrivatePath(authorityPolicy, privateRoot);

  const first = await runCycle({ cycleName: 'cycle-1', exe, profile, authorityPolicy, trustedFolder, runRoot, privateRoot, packageSubject });
  const restartPackageSubject = await reverifyHeadlessPackageSubjectAtRestart({ exe, request: packageSubjectRequest, before: packageSubject });
  const second = await runCycle({ cycleName: 'cycle-2', exe, profile, authorityPolicy, trustedFolder, runRoot, privateRoot, packageSubject: restartPackageSubject });
  const restart = { ...validateRestartIdentity(first.privateSummary, second.privateSummary), ...validateEphemeralAuthority(first.credential, second.credential) };
  await assertNoCredentialBytes(runRoot, [first.credential, second.credential]);
  const finalHash = await sha256(exe);
  if (finalHash !== expectedSha256) throw new Error('Executable hash changed during headless acceptance.');
  const finalProcesses = await relevantProcesses();
  if (finalProcesses.length) throw new Error('Headless acceptance left an AIMuse process running.');

  const summary = {
    version: 1,
    outcome: 'PASS',
    runRoot,
    executable: { path: exe, sha256: finalHash, byteLength: (await stat(exe)).size },
    ...(packageSubject ? { packageSubject } : {}),
    privateRoot: { platform: privateRoot.platform, owner: privateRoot.owner, allowedPrincipals: privateRoot.allowedPrincipals, inheritedFromBroadParent: privateRoot.inheritedFromBroadParent },
    authority: { policy: authorityPolicy, trustedFolder },
    cycles: [first.privateSummary, second.privateSummary],
    restart,
    cleanup: { relevantProcesses: 0, liveCredentialBytesBelowRunRoot: 0, forceTerminationUsed: false },
  };
  await atomicWriteJsonEvidence(join(runRoot, 'summary.json'), summary, { validate: (value) => {
    assertCredentialFreeEvidence(value, 'Headless acceptance summary');
    if (value.outcome !== 'PASS' || value.executable?.sha256 !== expectedSha256) throw new Error('Invalid headless acceptance summary.');
  } });
  await writeReport(join(runRoot, 'report.md'), summary);
  await inspectPrivatePath(join(runRoot, 'summary.json'), privateRoot);
  await inspectPrivatePath(join(runRoot, 'report.md'), privateRoot);
  process.stdout.write(`${JSON.stringify({ outcome: summary.outcome, runRoot, executable: summary.executable, restart: summary.restart, cleanup: summary.cleanup }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
