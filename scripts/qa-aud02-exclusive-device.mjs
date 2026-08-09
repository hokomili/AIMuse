import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

function parseArguments(arguments_) {
  const values = new Map();
  let mode;
  for (let index = 0; index < arguments_.length; ++index) {
    const argument = arguments_[index];
    if (argument === '--identity-only' || argument === '--device') {
      if (mode) throw new Error('Exactly one runner mode is required.');
      mode = argument.slice(2);
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= arguments_.length) throw new Error('Malformed runner argument.');
    if (values.has(argument)) throw new Error('Runner arguments may be supplied only once.');
    values.set(argument, arguments_[++index]);
  }
  return { mode, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Required runner argument ${name} is missing.`);
  return value;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function inspectDirectory(path) {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Checkpoint root must be a non-link directory.');
  const canonical = realpathSync.native(resolved);
  if (canonical.toUpperCase() !== resolved.toUpperCase()) throw new Error('Checkpoint root canonical identity changed.');
  const stable = statSync(resolved, { bigint: true });
  return {
    canonicalPathSha256: sha256Bytes(Buffer.from(canonical.toUpperCase(), 'utf8')),
    device: stable.dev.toString(),
    inode: stable.ino.toString(),
    isDirectory: stable.isDirectory(),
    isSymbolicLink: metadata.isSymbolicLink(),
  };
}

function sanitize(message, runRoot, audioExecutable) {
  return String(message).replaceAll(runRoot, '<device-root>').replaceAll(audioExecutable, '<audio-executable>');
}

function createProbeWav() {
  const sampleRate = 48_000;
  const durationMs = 180;
  const frames = Math.round(sampleRate * durationMs / 1_000);
  const channels = 2;
  const bytesPerSample = 4;
  const dataBytes = frames * channels * bytesPerSample;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(3, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  output.writeUInt16LE(channels * bytesPerSample, 32);
  output.writeUInt16LE(bytesPerSample * 8, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; ++frame) {
    const sample = Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.02;
    output.writeFloatLE(sample, 44 + frame * 8);
    output.writeFloatLE(sample, 48 + frame * 8);
  }
  return { bytes: output, sampleRate, durationMs, peak: 0.02, frames };
}

class ProtocolClient {
  constructor(child) {
    this.child = child;
    this.counter = 0;
    this.pending = new Map();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.onLine(line));
    child.once('error', (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.once('exit', (code, signal) => {
      const error = new Error(`Audio service exited before completing all requests (${signal ?? code ?? 'unknown'}).`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(`${message.error?.code ?? 'native-error'}: ${message.error?.message ?? 'Native request failed.'}`));
  }

  request(method, params, timeoutMs = 4_000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error('Audio service is not running.'));
    const id = `aud02-${++this.counter}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native ${method} request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ version: 1, id, method, params })}\n`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  close() {
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Protocol client closed.'));
    }
    this.pending.clear();
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ exited: false }), timeoutMs);
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ exited: true, code, signal });
    });
  });
}

function detachSurvivor(child) {
  child.unref();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

function validateModeReport(requestedMode, report, allowUnavailable) {
  if (report.requestedPlaybackMode !== requestedMode) throw new Error(`Requested mode mismatch for ${requestedMode} case.`);
  if (!Array.isArray(report.features) || !report.features.includes('wasapi-exclusive-opt-in')) throw new Error('Native hello lacks the exclusive opt-in feature declaration.');
  if (report.realtimeBackendReady) {
    if (report.driver !== 'wasapi' || report.effectivePlaybackMode !== requestedMode) {
      throw new Error(`Ready ${requestedMode} case did not report effective WASAPI ${requestedMode} output.`);
    }
    return 'ready';
  }
  if (!allowUnavailable || report.driver !== 'offline' || report.effectivePlaybackMode !== 'unavailable') {
    throw new Error(`${requestedMode} output was unavailable without the permitted fail-closed shape.`);
  }
  if (typeof report.diagnostic !== 'string' || !/^WASAPI exclusive output (context initialization|initialization|start) failed: /.test(report.diagnostic)) {
    throw new Error('Exclusive rejection did not include a precise initialization/start diagnostic.');
  }
  return 'precise-rejection';
}

async function runPlaybackCase({ audioExecutable, deviceRoot, mode, wavPath }) {
  const arguments_ = mode === 'exclusive' ? ['--stdio', '--playback-mode=exclusive'] : ['--stdio'];
  const child = spawn(audioExecutable, arguments_, {
    cwd: deviceRoot,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const client = new ProtocolClient(child);
  const evidence = {
    caseId: mode === 'exclusive' ? 'explicit-exclusive' : 'default-shared',
    status: 'FAIL',
    arguments: arguments_,
    pid: child.pid,
    requestedMode: mode,
    outcome: 'FAIL',
    audibleDurationMs: 0,
    gracefulExitObserved: false,
    exitCode: null,
    exitSignal: null,
    forceAttempted: false,
  };

  try {
    const hello = await client.request('hello', { appVersion: 'aud02-exclusive-native-checkpoint' });
    evidence.hello = {
      protocolVersion: hello.protocolVersion,
      driver: hello.driver,
      realtimeBackendReady: hello.realtimeBackendReady,
      requestedPlaybackMode: hello.requestedPlaybackMode,
      effectivePlaybackMode: hello.effectivePlaybackMode,
      diagnostic: hello.diagnostic,
      exclusiveFeatureDeclared: Array.isArray(hello.features) && hello.features.includes('wasapi-exclusive-opt-in'),
    };
    const modeOutcome = validateModeReport(mode, hello, mode === 'exclusive');
    evidence.outcome = modeOutcome;

    const projectId = `aud02-${mode}`;
    const revision = mode === 'exclusive' ? 202 : 101;
    await client.request('prepare-project', { projectId, revision, project: {} });
    await client.request('commit-project', { projectId, revision });
    if (modeOutcome === 'ready') {
      const loaded = await client.request('load-playback', { projectId, revision, previewPath: wavPath, preserveTransport: false }, 10_000);
      if (!loaded.loaded || loaded.sampleRate !== 48_000) throw new Error(`${mode} preview acknowledgement was invalid.`);
      const playing = await client.request('transport', { action: 'play', projectId, tick: 0, sample: 0 });
      if (playing.requestedPlaybackMode !== mode || playing.effectivePlaybackMode !== mode) throw new Error(`${mode} transport diagnostics did not match effective output.`);
      await delay(180);
      evidence.audibleDurationMs = 180;
      const paused = await client.request('transport', { action: 'pause', projectId });
      if (paused.requestedPlaybackMode !== mode || paused.effectivePlaybackMode !== mode) throw new Error(`${mode} pause diagnostics changed playback mode.`);
    } else {
      const stopped = await client.request('transport', { action: 'stop', projectId });
      if (stopped.requestedPlaybackMode !== 'exclusive' || stopped.effectivePlaybackMode !== 'unavailable') {
        throw new Error('Exclusive rejection transport diagnostics were not fail-closed.');
      }
    }
    await client.request('shutdown', {}, 2_000);
    const exit = await waitForExit(child, 3_000);
    evidence.gracefulExitObserved = exit.exited;
    evidence.exitCode = exit.code ?? null;
    evidence.exitSignal = exit.signal ?? null;
    if (!exit.exited) {
      evidence.survivorPid = child.pid;
      detachSurvivor(child);
      throw new Error(`${mode} audio child survived graceful shutdown.`);
    }
    if (exit.code !== 0 || exit.signal !== null) throw new Error(`${mode} audio child did not exit naturally with code zero.`);
    evidence.status = 'PASS';
    return evidence;
  } catch (error) {
    evidence.error = String(error instanceof Error ? error.message : error);
    if (child.exitCode === null && child.signalCode === null) {
      await client.request('shutdown', {}, 1_000).catch(() => undefined);
      const exit = await waitForExit(child, 3_000);
      evidence.gracefulExitObserved = exit.exited;
      evidence.exitCode = exit.code ?? null;
      evidence.exitSignal = exit.signal ?? null;
      if (!exit.exited) {
        evidence.survivorPid = child.pid;
        detachSurvivor(child);
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { caseEvidence: evidence });
  } finally {
    client.close();
    evidence.stderr = stderr;
  }
}

async function runDevice(values) {
  const deviceRoot = resolve(required(values, '--run-root'));
  const audioExecutable = resolve(required(values, '--audio-exe'));
  const expectedAudioSha256 = required(values, '--expected-audio-sha256').toUpperCase();
  const evidencePath = resolve(deviceRoot, 'device-case.json');
  if (!existsSync(deviceRoot) || existsSync(evidencePath)) throw new Error('Device evidence root must exist and be unused.');
  if ((await readdir(deviceRoot)).length !== 0) throw new Error('Device evidence root must be empty before the runner starts.');
  const rootIdentity = inspectDirectory(deviceRoot);
  const audioMetadata = statSync(audioExecutable);
  const audioSha256 = await sha256File(audioExecutable);
  if (audioSha256 !== expectedAudioSha256) throw new Error('Prospective audio executable identity mismatch.');

  process.chdir(deviceRoot);
  const probe = createProbeWav();
  const wavPath = resolve(deviceRoot, 'aud02-exclusive-probe.wav');
  await writeFile(wavPath, probe.bytes, { flag: 'wx' });
  const evidence = {
    schemaVersion: 1,
    status: 'FAIL',
    scope: 'AUD-02 default-shared plus explicit-exclusive native endpoint checkpoint only',
    rootIdentity,
    audioExecutable: { name: basename(audioExecutable), bytes: audioMetadata.size, sha256: audioSha256 },
    probe: { name: basename(wavPath), bytes: probe.bytes.length, sha256: sha256Bytes(probe.bytes), sampleRate: probe.sampleRate, frames: probe.frames, durationMs: probe.durationMs, peak: probe.peak },
    cases: [],
    maximumAudibleDurationMs: 360,
    forceAttempted: false,
    automaticCleanupPerformed: false,
    networkProviderCredentialActivityAuthorized: false,
  };
  try {
    evidence.cases.push(await runPlaybackCase({ audioExecutable, deviceRoot, mode: 'shared', wavPath }));
    evidence.cases.push(await runPlaybackCase({ audioExecutable, deviceRoot, mode: 'exclusive', wavPath }));
    evidence.status = 'PASS';
  } catch (error) {
    if (error?.caseEvidence) evidence.cases.push(error.caseEvidence);
    evidence.error = sanitize(error instanceof Error ? error.message : String(error), deviceRoot, audioExecutable);
    throw error;
  } finally {
    for (const entry of evidence.cases) {
      if (entry.error) entry.error = sanitize(entry.error, deviceRoot, audioExecutable);
      if (entry.stderr) entry.stderr = sanitize(entry.stderr, deviceRoot, audioExecutable);
    }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
}

const { mode, values } = parseArguments(process.argv.slice(2));
if (mode === 'identity-only') {
  process.stdout.write(`${JSON.stringify(inspectDirectory(required(values, '--run-root')))}\n`);
} else if (mode === 'device') {
  await runDevice(values);
} else {
  throw new Error('Runner mode must be --identity-only or --device.');
}
