import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[0-9a-f]{64}$/i;
const EXECUTABLE_HASH = /^[0-9a-f]{64}$/i;
const CREDENTIAL_KEYS = new Set(['apikey', 'authorization', 'password', 'secret', 'sessionid', 'token', 'tokenhint']);

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeInstanceId(value, label = 'AIMuse engine instance ID') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !INSTANCE_ID.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toLowerCase();
}

export function normalizeProfileId(value, label = 'AIMuse profile ID') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toUpperCase();
}

export function profileIdForPath(path, platform = process.platform) {
  if (typeof path !== 'string' || !path) throw new Error('Invalid AIMuse profile path.');
  const resolved = resolve(path);
  const identityInput = platform === 'win32' ? resolved.toLowerCase() : resolved.normalize('NFC');
  return createHash('sha256').update(identityInput).digest('hex').toUpperCase();
}

function normalizeExecutableHash(value, label) {
  if (typeof value !== 'string' || !EXECUTABLE_HASH.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toUpperCase();
}

function assertCredentialFreeEvidence(value, label) {
  const seen = new Set();
  const visit = (current) => {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) { for (const entry of current) visit(entry); return; }
    for (const [key, entry] of Object.entries(current)) {
      if (CREDENTIAL_KEYS.has(key.toLowerCase()) && entry !== undefined) throw new Error(`${label} must not contain credential field ${key}.`);
      visit(entry);
    }
  };
  visit(value);
}

export function normalizeLocalMcpUrl(value) {
  let url;
  try { url = new globalThis.URL(value); } catch { throw new Error('Invalid QA connection MCP URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Invalid QA connection MCP URL.');
  return url.toString();
}

export function normalizeReadyConnection(value, expectedPid, expectedProfileId) {
  const connection = asRecord(value, 'QA connection');
  if (typeof connection.token !== 'string' || !connection.token) throw new Error('Connection file is incomplete.');
  if (!Number.isSafeInteger(Number(connection.pid)) || Number(connection.pid) <= 0) throw new Error('Connection file is incomplete.');
  if (Number(connection.pid) !== Number(expectedPid)) throw new Error(`Connection PID ${connection.pid} does not match launched PID ${expectedPid}.`);
  const profileId = normalizeProfileId(connection.profileId, 'QA connection profile ID');
  const normalizedExpectedProfile = normalizeProfileId(expectedProfileId, 'expected QA profile ID');
  if (normalizedExpectedProfile !== undefined && profileId !== normalizedExpectedProfile) throw new Error(`Connection profile mismatch: expected ${normalizedExpectedProfile}, received ${profileId ?? 'missing'}.`);
  return {
    ...connection,
    url: normalizeLocalMcpUrl(connection.url),
    pid: Number(connection.pid),
    instanceId: normalizeInstanceId(connection.instanceId, 'QA connection engine instance ID'),
    profileId,
  };
}

export function validateHealthIdentity(value, expectedPid, expectedInstanceId, expectedProfileId) {
  const body = asRecord(value, 'Health response');
  if (body.name !== 'AIMuse Engine' || body.status !== 'ok') throw new Error('Health endpoint identity mismatch.');
  if (body.pid !== undefined && Number(body.pid) !== Number(expectedPid)) throw new Error(`Health endpoint PID mismatch: expected ${expectedPid}, received ${body.pid}.`);
  const instanceId = normalizeInstanceId(body.instanceId, 'health engine instance ID');
  const normalizedExpected = normalizeInstanceId(expectedInstanceId, 'expected engine instance ID');
  if (normalizedExpected !== undefined && instanceId !== normalizedExpected) throw new Error(`Health endpoint instance mismatch: expected ${normalizedExpected}, received ${instanceId ?? 'missing'}.`);
  const profileId = normalizeProfileId(body.profileId, 'health profile ID');
  const normalizedExpectedProfile = normalizeProfileId(expectedProfileId, 'expected health profile ID');
  if (normalizedExpectedProfile !== undefined && profileId !== normalizedExpectedProfile) throw new Error(`Health endpoint profile mismatch: expected ${normalizedExpectedProfile}, received ${profileId ?? 'missing'}.`);
  return {
    body,
    instanceId,
    profileId,
    subjectIdentity: `${instanceId ? `instance:${instanceId}` : `legacy-pid:${Number(expectedPid)}`}${profileId ? `/profile:${profileId}` : ''}`,
  };
}

function normalizeHealthProbe(value, expectedPid, expectedInstanceId, expectedProfileId) {
  const probe = asRecord(value, 'Health probe');
  const body = 'body' in probe ? probe.body : probe;
  const identity = validateHealthIdentity(body, expectedPid, expectedInstanceId, expectedProfileId);
  return 'body' in probe ? { ...probe, ...identity } : identity;
}

export async function waitForConnectionReadiness(options, dependencies) {
  const { connectionPath, expectedPid, expectedProfileId, startedAt, timeoutMs = 20_000, pollMs = 150 } = options;
  const { now, probeHealth, readConnection, sleep, statConnection } = dependencies;
  const deadline = now() + timeoutMs;
  let lastError = new Error('Connection file did not appear.');
  while (now() < deadline) {
    try {
      const fileInfo = await statConnection(connectionPath);
      if (Number(fileInfo.mtimeMs) + 1_000 < startedAt) throw new Error('Connection file is stale.');
      const connection = normalizeReadyConnection(JSON.parse(String(await readConnection(connectionPath))), expectedPid, expectedProfileId);
      const health = normalizeHealthProbe(await probeHealth(connection.url, expectedPid, connection.instanceId, connection.profileId), expectedPid, connection.instanceId, connection.profileId);
      return { connection, health };
    } catch (error) {
      lastError = error;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }
  }
  throw new Error(`AIMuse QA engine did not become ready: ${message(lastError)}`);
}

function normalizeProcessInspection(value, expectedPid) {
  if (typeof value === 'boolean') return { alive: value, identity: undefined };
  const inspection = asRecord(value, 'Process inspection');
  if (typeof inspection.alive !== 'boolean') throw new Error('Process inspection must report liveness.');
  if (inspection.pid !== undefined && Number(inspection.pid) !== Number(expectedPid)) throw new Error(`Process inspection PID mismatch: expected ${expectedPid}, received ${inspection.pid}.`);
  if (inspection.identity !== undefined && typeof inspection.identity !== 'string') throw new Error('Process inspection identity must be a string.');
  return { alive: inspection.alive, identity: inspection.identity };
}

function assertStableProcess(initial, current, pid, stage, action = 'stop') {
  if (!current.alive) throw new Error(`Refusing to ${action} AIMuse because QA PID ${pid} exited ${stage}.`);
  if (initial.identity !== current.identity) throw new Error(`Refusing to ${action} AIMuse because QA PID ${pid} was recycled ${stage}.`);
}

function normalizeShowConnection(value, expected) {
  const connection = asRecord(value, 'QA show connection');
  const pid = Number(connection.pid);
  const mcpUrl = normalizeLocalMcpUrl(connection.url);
  let instanceId; let profileId;
  try { instanceId = normalizeInstanceId(connection.instanceId, 'QA show connection engine instance ID'); } catch { throw new Error('Refusing to show AIMuse because session instance identity is invalid.'); }
  try { profileId = normalizeProfileId(connection.profileId, 'QA show connection profile ID'); } catch { throw new Error('Refusing to show AIMuse because session profile identity is invalid.'); }
  if (pid !== expected.pid || mcpUrl !== expected.mcpUrl) throw new Error('Refusing to show AIMuse because session PID/URL identity changed.');
  if (instanceId !== expected.instanceId) throw new Error('Refusing to show AIMuse because session instance identity changed.');
  if (profileId !== expected.profileId) throw new Error('Refusing to show AIMuse because session profile identity changed.');
  return { pid, mcpUrl, instanceId, profileId };
}

const SHOW_ACK_FIELDS = new Set(['acknowledgedAt', 'attempts', 'instanceId', 'pid', 'profileId', 'reason', 'receivedAt', 'requestId', 'status']);
const SHOW_ACK_REJECTIONS = new Set(['duplicate-request', 'instance-mismatch', 'malformed-request', 'profile-mismatch', 'window-error']);

function showAcknowledgement(value, requestId, expected, timing) {
  const body = asRecord(value, 'Health response');
  if (body.showAcknowledgements === undefined) return { state: 'absent' };
  if (!Array.isArray(body.showAcknowledgements)) throw new Error('Malformed show acknowledgement evidence.');
  const matches = body.showAcknowledgements.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.requestId === requestId);
  if (matches.length > 1) throw new Error('Duplicate show acknowledgement evidence.');
  if (!matches.length) return { state: 'absent' };
  const acknowledgement = asRecord(matches[0], 'Show acknowledgement');
  if (Object.keys(acknowledgement).some((key) => !SHOW_ACK_FIELDS.has(key))) throw new Error('Malformed show acknowledgement evidence.');
  let instanceId; let profileId;
  try { instanceId = normalizeInstanceId(acknowledgement.instanceId, 'show acknowledgement engine instance ID'); } catch { throw new Error('Show acknowledgement engine identity mismatch.'); }
  try { profileId = normalizeProfileId(acknowledgement.profileId, 'show acknowledgement profile ID'); } catch { throw new Error('Show acknowledgement profile identity mismatch.'); }
  if (typeof acknowledgement.pid !== 'number' || !Number.isSafeInteger(acknowledgement.pid) || acknowledgement.pid <= 0) throw new Error('Malformed show acknowledgement evidence.');
  if (acknowledgement.pid !== expected.pid || instanceId !== expected.instanceId) throw new Error('Show acknowledgement engine identity mismatch.');
  if (profileId !== expected.profileId) throw new Error('Show acknowledgement profile identity mismatch.');
  if (acknowledgement.attempts !== 1) throw new Error('Duplicate show acknowledgement evidence.');
  if (!['accepted', 'pending', 'rejected'].includes(String(acknowledgement.status))) throw new Error('Malformed show acknowledgement evidence.');
  const receivedAtMs = typeof acknowledgement.receivedAt === 'string' ? Date.parse(acknowledgement.receivedAt) : Number.NaN;
  if (!Number.isFinite(receivedAtMs) || new Date(receivedAtMs).toISOString() !== acknowledgement.receivedAt) throw new Error('Malformed show acknowledgement evidence.');
  if (timing && receivedAtMs < timing.requestedAtMs) throw new Error('Stale show acknowledgement evidence.');
  if (timing && receivedAtMs > timing.deadlineMs) throw new Error('Late show acknowledgement evidence.');
  if (timing && receivedAtMs > timing.observedAtMs) throw new Error('Future show acknowledgement evidence.');
  if (acknowledgement.status === 'pending') {
    if (acknowledgement.acknowledgedAt !== undefined || acknowledgement.reason !== undefined) throw new Error('Malformed show acknowledgement evidence.');
    return { state: 'pending' };
  }
  const acknowledgedAtMs = typeof acknowledgement.acknowledgedAt === 'string' ? Date.parse(acknowledgement.acknowledgedAt) : Number.NaN;
  if (!Number.isFinite(acknowledgedAtMs) || new Date(acknowledgedAtMs).toISOString() !== acknowledgement.acknowledgedAt) throw new Error('Malformed show acknowledgement evidence.');
  if (timing && acknowledgedAtMs < timing.requestedAtMs) throw new Error('Stale show acknowledgement evidence.');
  if (timing && acknowledgedAtMs > timing.deadlineMs) throw new Error('Late show acknowledgement evidence.');
  if (timing && acknowledgedAtMs > timing.observedAtMs) throw new Error('Future show acknowledgement evidence.');
  if (acknowledgedAtMs < receivedAtMs) throw new Error('Inconsistent show acknowledgement evidence.');
  if (acknowledgement.status === 'accepted' && acknowledgement.reason !== undefined) throw new Error('Malformed show acknowledgement evidence.');
  if (acknowledgement.status === 'rejected' && !SHOW_ACK_REJECTIONS.has(acknowledgement.reason)) throw new Error('Malformed show acknowledgement evidence.');
  return { state: acknowledgement.status, acknowledgement: { requestId, status: acknowledgement.status, pid: expected.pid, instanceId, profileId, receivedAt: new Date(receivedAtMs).toISOString(), acknowledgedAt: new Date(acknowledgedAtMs).toISOString(), attempts: 1, ...(acknowledgement.reason ? { reason: acknowledgement.reason } : {}) } };
}

export function buildShowManifest(manifestValue, acknowledgementValue, recordedAt = new Date().toISOString()) {
  const manifest = asRecord(manifestValue, 'QA session manifest');
  const acknowledgement = asRecord(acknowledgementValue, 'Accepted show acknowledgement');
  assertCredentialFreeEvidence(manifest, 'QA session manifest');
  if (acknowledgement.status !== 'accepted' || acknowledgement.attempts !== 1 || typeof acknowledgement.requestId !== 'string' || !INSTANCE_ID.test(acknowledgement.requestId) || Number(acknowledgement.pid) !== Number(manifest.pid) || normalizeInstanceId(acknowledgement.instanceId, 'show acknowledgement engine instance ID') !== normalizeInstanceId(manifest.instanceId, 'QA show engine instance ID') || normalizeProfileId(acknowledgement.profileId, 'show acknowledgement profile ID') !== normalizeProfileId(manifest.profileId, 'QA show profile ID')) throw new Error('Invalid accepted show acknowledgement.');
  if (typeof acknowledgement.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(acknowledgement.acknowledgedAt)) || typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) throw new Error('Invalid QA show acknowledgement time.');
  return {
    ...manifest,
    windowRequested: true,
    windowRequestedAt: acknowledgement.acknowledgedAt,
    windowRequestId: acknowledgement.requestId,
    windowRequestInstanceId: acknowledgement.instanceId,
    windowRequestProfileId: acknowledgement.profileId,
    windowAcknowledgementStatus: 'accepted',
    windowAcknowledgementAttempts: 1,
    windowEvidenceRecordedAt: recordedAt,
  };
}

export async function coordinateShow(options, dependencies) {
  const manifest = asRecord(options.manifest, 'QA session manifest');
  assertCredentialFreeEvidence(manifest, 'QA session manifest');
  const pid = Number(manifest.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid QA show PID.');
  if (typeof manifest.exe !== 'string' || typeof manifest.profile !== 'string' || typeof manifest.connection !== 'string') throw new Error('Invalid QA show paths.');
  const expectedHash = normalizeExecutableHash(manifest.exeSha256, 'QA show executable hash');
  const mcpUrl = normalizeLocalMcpUrl(manifest.mcpUrl);
  const instanceId = normalizeInstanceId(manifest.instanceId, 'QA show engine instance ID');
  const profileId = normalizeProfileId(manifest.profileId, 'QA show profile ID');
  const requestId = normalizeInstanceId(options.requestId, 'QA show request ID');
  if (profileId !== undefined && profileIdForPath(manifest.profile) !== profileId) throw new Error('Refusing to show AIMuse because the declared profile path has the wrong identity.');
  const acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 2_000;
  const acknowledgementPollMs = options.acknowledgementPollMs ?? 25;
  if (!Number.isFinite(acknowledgementTimeoutMs) || acknowledgementTimeoutMs < 0 || !Number.isFinite(acknowledgementPollMs) || acknowledgementPollMs <= 0) throw new Error('Invalid show acknowledgement polling interval.');
  const requestedAt = dependencies.nowIso();
  const requestedAtMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedAtMs)) throw new Error('Invalid QA show request time.');
  const target = { pid, mcpUrl, instanceId, profileId, requestId };
  const verifyHash = async () => {
    const currentHash = normalizeExecutableHash(await dependencies.hashExecutable(manifest.exe), 'current QA executable hash');
    if (currentHash !== expectedHash) throw new Error(`Refusing to show AIMuse because executable hash changed: expected ${expectedHash}, received ${currentHash}.`);
  };
  const readConnection = async () => normalizeShowConnection(await dependencies.readConnection(manifest.connection), target);
  const inspect = async () => normalizeProcessInspection(await dependencies.inspectProcess(pid), pid);
  const probe = async () => normalizeHealthProbe(await dependencies.probeHealth(mcpUrl, pid, instanceId, profileId), pid, instanceId, profileId);

  await verifyHash();
  if (!instanceId || !profileId || !requestId) throw new Error('Receiver-acknowledged show requires exact engine, profile and request identities.');
  await readConnection();
  const initialProcess = await inspect();
  if (!initialProcess.alive) throw new Error(`Refusing to show AIMuse because QA PID ${pid} is not alive.`);
  const initialHealth = await probe();
  if (showAcknowledgement(initialHealth.body, requestId, target).state !== 'absent') throw new Error('Stale show acknowledgement existed before launch.');
  const afterInitialHealth = await inspect();
  assertStableProcess(initialProcess, afterInitialHealth, pid, 'during initial health verification', 'show');
  const beforeLaunchHealth = await probe();
  if (beforeLaunchHealth.subjectIdentity !== initialHealth.subjectIdentity) throw new Error('Refusing to show AIMuse because health identity changed between probes.');
  if (showAcknowledgement(beforeLaunchHealth.body, requestId, target).state !== 'absent') throw new Error('Stale show acknowledgement existed before launch.');
  await verifyHash();
  await readConnection();
  const beforeLaunch = await inspect();
  assertStableProcess(initialProcess, beforeLaunch, pid, 'before the attach signal', 'show');

  const launchTarget = {
    ...target,
    exe: manifest.exe,
    profile: manifest.profile,
    processIdentity: initialProcess.identity,
    healthIdentity: initialHealth.subjectIdentity,
    requestedAt,
    arguments: [`--user-data-dir=${manifest.profile}`, `--show-engine-instance=${instanceId}`, `--show-profile-id=${profileId}`, `--show-request-id=${requestId}`],
  };
  const child = await dependencies.launchWindowRequest(launchTarget);
  if (child === undefined || child === null) throw new Error('The editor attach signal did not return a child handle.');
  const exitCode = await dependencies.waitForChildExit(child, options.timeoutMs ?? 10_000);
  if (exitCode === undefined) throw new Error('The editor attach signal did not return within 10 seconds.');
  if (!Number.isInteger(exitCode) || exitCode !== 0) throw new Error(`The editor attach signal exited with code ${String(exitCode)}.`);

  const afterChildExit = await inspect();
  assertStableProcess(initialProcess, afterChildExit, pid, 'while the attach helper exited', 'show');
  const deadlineMs = dependencies.now() + acknowledgementTimeoutMs;
  let accepted;
  while (!accepted) {
    const acknowledgementHealth = await probe();
    if (acknowledgementHealth.subjectIdentity !== initialHealth.subjectIdentity) throw new Error('Refusing to record the show request because health identity changed after the attach signal.');
    const duringAcknowledgement = await inspect();
    assertStableProcess(initialProcess, duringAcknowledgement, pid, 'while waiting for receiver acknowledgement', 'show');
    const observedAtMs = dependencies.now();
    const state = showAcknowledgement(acknowledgementHealth.body, requestId, target, { requestedAtMs, deadlineMs, observedAtMs });
    if (state.state === 'rejected') throw new Error('The verified show receiver rejected the attach request.');
    if (state.state === 'accepted') { accepted = state.acknowledgement; break; }
    if (observedAtMs >= deadlineMs) throw new Error('The verified show receiver did not acknowledge the attach request before the deadline.');
    await dependencies.sleep(Math.min(acknowledgementPollMs, deadlineMs - observedAtMs));
  }

  const finalHealth = await probe();
  if (finalHealth.subjectIdentity !== initialHealth.subjectIdentity) throw new Error('Refusing to record the show request because health identity changed before evidence commit.');
  const finalState = showAcknowledgement(finalHealth.body, requestId, target, { requestedAtMs, deadlineMs, observedAtMs: dependencies.now() });
  if (finalState.state !== 'accepted' || JSON.stringify(finalState.acknowledgement) !== JSON.stringify(accepted)) throw new Error('Show acknowledgement changed before evidence commit.');
  const beforeEvidence = await inspect();
  assertStableProcess(initialProcess, beforeEvidence, pid, 'before recording the show request', 'show');
  const updatedManifest = buildShowManifest(manifest, accepted, dependencies.nowIso());
  await dependencies.writeManifest(updatedManifest);
  return { manifest: updatedManifest, acknowledgement: accepted, processIdentity: initialProcess.identity, healthIdentity: initialHealth.subjectIdentity, launchTarget };
}

export async function coordinateStop(options, dependencies) {
  const pid = Number(options.pid);
  const expectedInstanceId = normalizeInstanceId(options.instanceId, 'stop target engine instance ID');
  const expectedProfileId = normalizeProfileId(options.profileId, 'stop target profile ID');
  const inspect = async () => normalizeProcessInspection(await dependencies.inspectProcess(pid), pid);
  const probe = async () => normalizeHealthProbe(await dependencies.probeHealth(options.mcpUrl, pid, expectedInstanceId, expectedProfileId), pid, expectedInstanceId, expectedProfileId);

  const initialProcess = await inspect();
  if (!initialProcess.alive) throw new Error(`Refusing to stop AIMuse because QA PID ${pid} is not alive.`);
  const initialHealth = await probe();

  const afterInitialHealth = await inspect();
  assertStableProcess(initialProcess, afterInitialHealth, pid, 'during initial health verification');
  const finalHealth = await probe();
  if (finalHealth.subjectIdentity !== initialHealth.subjectIdentity) throw new Error('Refusing to stop AIMuse because health identity changed between probes.');

  const beforeSignal = await inspect();
  assertStableProcess(initialProcess, beforeSignal, pid, 'before the quit signal');
  const instanceId = expectedInstanceId ?? initialHealth.instanceId;
  const signalResult = await dependencies.signal({
    pid,
    mcpUrl: options.mcpUrl,
    instanceId,
    profileId: expectedProfileId ?? initialHealth.profileId,
    processIdentity: initialProcess.identity,
    healthIdentity: initialHealth.subjectIdentity,
  });
  return { signalResult, processIdentity: initialProcess.identity, healthIdentity: initialHealth.subjectIdentity, instanceId, profileId: expectedProfileId ?? initialHealth.profileId };
}

function completion(outcome, stopped, connectionCredentialsRedacted, reason, polls, healthUnavailable) {
  return { outcome, stopped, connectionCredentialsRedacted, reason, polls, healthUnavailable };
}

function processContinuity(expectedIdentity, currentIdentity) {
  if (expectedIdentity === currentIdentity) return 'same';
  if (expectedIdentity === undefined || currentIdentity === undefined) return 'ambiguous';
  return 'changed';
}

export async function waitForStopCompletion(options, dependencies) {
  const pid = Number(options.pid);
  const expectedInstanceId = normalizeInstanceId(options.instanceId, 'post-signal engine instance ID');
  const expectedProfileId = normalizeProfileId(options.profileId, 'post-signal profile ID');
  const expectedHealthIdentity = options.healthIdentity ?? `${expectedInstanceId ? `instance:${expectedInstanceId}` : `legacy-pid:${pid}`}${expectedProfileId ? `/profile:${expectedProfileId}` : ''}`;
  if (typeof expectedHealthIdentity !== 'string' || !expectedHealthIdentity) throw new Error('Invalid post-signal health identity.');
  if (options.processIdentity !== undefined && typeof options.processIdentity !== 'string') throw new Error('Invalid post-signal process identity.');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 150;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid post-signal polling interval.');
  const deadline = dependencies.now() + timeoutMs;
  let healthUnavailable = false;
  let polls = 0;

  const inspect = async () => normalizeProcessInspection(await dependencies.inspectProcess(pid), pid);
  while (true) {
    polls += 1;
    let current;
    try { current = await inspect(); } catch {
      return completion('identity-ambiguous', false, false, 'Process identity could not be confirmed after the quit signal.', polls, healthUnavailable);
    }

    if (!current.alive) {
      let confirmation;
      try { confirmation = await inspect(); } catch {
        return completion('identity-ambiguous', false, false, 'Process exit could not be confirmed before credential redaction.', polls, healthUnavailable);
      }
      if (confirmation.alive) {
        const continuity = processContinuity(options.processIdentity, confirmation.identity);
        return completion(continuity === 'changed' ? 'identity-changed' : 'identity-ambiguous', false, false, continuity === 'changed' ? 'The declared PID was recycled before credential redaction.' : 'Process liveness changed during exit confirmation.', polls, healthUnavailable);
      }
      try {
        const redactionResult = await dependencies.redact({ pid, instanceId: expectedInstanceId, profileId: expectedProfileId, processIdentity: options.processIdentity, healthIdentity: expectedHealthIdentity });
        if (redactionResult === false) throw new Error('Redaction stand-in declined cleanup.');
      } catch {
        return completion('redaction-failed', true, false, 'The original engine exited, but credential redaction did not complete.', polls, healthUnavailable);
      }
      return completion('stopped-redacted', true, true, 'The original engine exited and its private connection evidence was redacted.', polls, healthUnavailable);
    }

    const continuity = processContinuity(options.processIdentity, current.identity);
    if (continuity !== 'same') return completion(continuity === 'changed' ? 'identity-changed' : 'identity-ambiguous', false, false, continuity === 'changed' ? 'The declared PID was recycled during shutdown polling.' : 'Process generation became ambiguous during shutdown polling.', polls, healthUnavailable);

    let probe; let probeFailed = false;
    try { probe = await dependencies.probeHealth(options.mcpUrl, pid, expectedInstanceId, expectedProfileId); } catch { healthUnavailable = true; probeFailed = true; }
    if (!probeFailed) {
      if (probe && typeof probe === 'object' && 'unavailable' in probe && probe.unavailable === true) healthUnavailable = true;
      else {
        let identity;
        try { identity = normalizeHealthProbe(probe, pid, expectedInstanceId, expectedProfileId); } catch {
          return completion('identity-changed', false, false, 'Health identity changed during shutdown polling.', polls, healthUnavailable);
        }
        if (identity.subjectIdentity !== expectedHealthIdentity) return completion('identity-changed', false, false, 'Health identity changed during shutdown polling.', polls, healthUnavailable);
      }
    }

    if (dependencies.now() >= deadline) return completion('timeout', false, false, 'The verified engine remained alive through the shutdown deadline.', polls, healthUnavailable);
    await dependencies.sleep(Math.min(pollMs, deadline - dependencies.now()));
  }
}

export function buildStopManifest(manifestValue, completionValue, completedAt = new Date().toISOString()) {
  const manifest = asRecord(manifestValue, 'QA session manifest');
  const result = asRecord(completionValue, 'QA stop completion');
  const outcomeStates = {
    'stopped-redacted': { stopped: true, redacted: true },
    timeout: { stopped: false, redacted: false },
    'identity-changed': { stopped: false, redacted: false },
    'identity-ambiguous': { stopped: false, redacted: false },
    'redaction-failed': { stopped: true, redacted: false },
  };
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) throw new Error('Invalid QA stop completion time.');
  if (typeof result.outcome !== 'string' || !(result.outcome in outcomeStates) || typeof result.stopped !== 'boolean' || typeof result.connectionCredentialsRedacted !== 'boolean' || typeof result.reason !== 'string' || !result.reason || !Number.isSafeInteger(result.polls) || result.polls <= 0 || typeof result.healthUnavailable !== 'boolean') throw new Error('Invalid QA stop completion evidence.');
  const expected = outcomeStates[result.outcome];
  if (result.stopped !== expected.stopped || result.connectionCredentialsRedacted !== expected.redacted) throw new Error(`Inconsistent QA stop evidence for outcome ${result.outcome}.`);
  return {
    ...manifest,
    stoppedAt: completedAt,
    stopped: result.stopped,
    stopOutcome: result.outcome,
    stopReason: result.reason,
    stopPolls: result.polls,
    stopHealthUnavailable: Boolean(result.healthUnavailable),
    connectionCredentialsRedacted: result.connectionCredentialsRedacted,
  };
}
