import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultSoakMs = 5_000;
const restartProbeMs = 180;

export function createProbeWav(sampleRate = 48_000, durationMs = 500, amplitude = 0.005) {
  const frames = Math.round(sampleRate * durationMs / 1_000);
  const channels = 2;
  const bytesPerSample = 4;
  const dataBytes = frames * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.sin(2 * Math.PI * 220 * frame / sampleRate) * amplitude;
    wav.writeFloatLE(sample, 44 + frame * 8);
    wav.writeFloatLE(sample, 48 + frame * 8);
  }
  return { wav, frames, sampleRate, durationMs, peak: amplitude };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit({ exited: false }), timeoutMs);
    child.once('close', (code, signal) => { clearTimeout(timer); resolveExit({ exited: true, code, signal }); });
  });
}

function protocolClient(child) {
  const pending = new Map();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); }
    catch { return; }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(`Native ${response.error?.code ?? 'request'} failed: ${response.error?.message ?? 'unknown error'}`));
  });
  return {
    request(id, method, parameters = {}, timeoutMs = 5_000) {
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Native ${method} timed out.${stderr ? ` ${stderr.trim()}` : ''}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, ...parameters })}\n`);
      });
    },
    close() {
      lines.close();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Native protocol client closed.'));
      }
      pending.clear();
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`CoreAudio ${label} was not a non-negative safe integer: ${String(value)}.`);
  return value;
}

export function validateCoreAudioHello(hello) {
  if (hello.driver !== 'coreaudio' || hello.realtimeBackendReady !== true) throw new Error(`CoreAudio was not ready: ${hello.diagnostic ?? 'no diagnostic'}`);
  if (hello.requestedPlaybackMode !== 'shared' || hello.effectivePlaybackMode !== 'shared') throw new Error('CoreAudio did not retain the requested shared playback mode.');
  if (!Array.isArray(hello.features) || !hello.features.includes('coreaudio-shared-playback')) throw new Error('CoreAudio shared playback was not declared by the native service.');
  return hello;
}

export function validateCoreAudioExclusiveHello(hello) {
  if (hello.driver !== 'offline' || hello.realtimeBackendReady !== false || hello.requestedPlaybackMode !== 'exclusive' || hello.effectivePlaybackMode !== 'unavailable') {
    throw new Error('Unsupported CoreAudio exclusive output did not retain the fail-closed unavailable shape.');
  }
  if (hello.diagnostic !== 'CoreAudio exclusive output is not implemented; no shared-mode fallback was attempted.') {
    throw new Error(`CoreAudio exclusive rejection was not precise: ${String(hello.diagnostic)}.`);
  }
  return hello;
}

export function validateStableDeviceTelemetry(report, label = 'probe') {
  const telemetry = {
    callbackCount: nonnegativeInteger(report.callbackCount, `${label} callback count`),
    callbackFrames: nonnegativeInteger(report.callbackFrames, `${label} callback frames`),
    renderedFrames: nonnegativeInteger(report.renderedFrames, `${label} rendered frames`),
    deviceReroutes: nonnegativeInteger(report.deviceReroutes, `${label} device reroutes`),
    deviceInterruptions: nonnegativeInteger(report.deviceInterruptions, `${label} device interruptions`),
    deviceUnexpectedStops: nonnegativeInteger(report.deviceUnexpectedStops, `${label} unexpected device stops`),
  };
  if (report.realtimeBackendReady !== true) throw new Error(`CoreAudio became unavailable during the ${label}: ${report.deviceDiagnostic ?? 'no diagnostic'}`);
  if (report.deviceInterruptionActive !== false) throw new Error(`CoreAudio remained interrupted after the ${label}.`);
  if (telemetry.deviceInterruptions !== 0 || telemetry.deviceUnexpectedStops !== 0) {
    throw new Error(`CoreAudio reported ${telemetry.deviceInterruptions} interruption(s) and ${telemetry.deviceUnexpectedStops} unexpected stop(s) during the ${label}.`);
  }
  return telemetry;
}

export function validateSoakWindow(before, after, minimumRenderedFrames) {
  const baseline = validateStableDeviceTelemetry(before, 'soak baseline');
  const observed = validateStableDeviceTelemetry(after, 'bounded soak');
  const callbackCount = observed.callbackCount - baseline.callbackCount;
  const callbackFrames = observed.callbackFrames - baseline.callbackFrames;
  const renderedFrames = observed.renderedFrames - baseline.renderedFrames;
  if (callbackCount <= 0 || callbackFrames <= 0) throw new Error('CoreAudio callbacks did not advance during the bounded soak.');
  if (renderedFrames < minimumRenderedFrames) {
    throw new Error(`CoreAudio rendered only ${renderedFrames} frames during the bounded soak; required at least ${minimumRenderedFrames}.`);
  }
  return { callbackCount, callbackFrames, renderedFrames, telemetry: observed };
}

async function shutdownNaturally(child, client, id) {
  await client.request(`${id}-shutdown`, 'shutdown', {}, 2_000);
  child.stdin.end();
  const exit = await waitForExit(child, 3_000);
  if (!exit.exited) throw new Error(`${id} native audio service survived graceful shutdown.`);
  if (exit.code !== 0 || exit.signal !== null) throw new Error(`${id} native audio service exited with code ${String(exit.code)} and signal ${String(exit.signal)}.`);
  return true;
}

async function withAudioService(binary, arguments_, runCase) {
  const child = spawn(binary, arguments_, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const client = protocolClient(child);
  let exited = false;
  try {
    const result = await runCase(child, client);
    exited = child.exitCode !== null || child.signalCode !== null;
    return result;
  } finally {
    client.close();
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, 2_000);
    }
  }
}

async function preparePreview(client, prefix, previewPath, revision) {
  const projectId = `macos-coreaudio-${prefix}`;
  await client.request(`${prefix}-prepare`, 'prepare-project', { projectId, revision });
  await client.request(`${prefix}-commit`, 'commit-project', { projectId, revision });
  await client.request(`${prefix}-load`, 'load-playback', { projectId, revision, previewPath, preserveTransport: false });
  return projectId;
}

async function runSoakCycle(binary, previewPath, probe, soakMs) {
  return withAudioService(binary, ['--stdio'], async (child, client) => {
    const hello = validateCoreAudioHello(await client.request('soak-hello', 'hello'));
    await preparePreview(client, 'soak', previewPath, 1);
    const baseline = await client.request('soak-baseline', 'transport', { action: 'stop' });
    validateStableDeviceTelemetry(baseline, 'soak baseline');
    await client.request('soak-play', 'transport', {
      action: 'play', tick: 0, sample: 0, loopEnabled: true,
      loopStartTick: 0, loopEndTick: 1, loopStartSample: 0, loopEndSample: probe.frames,
    });
    await delay(soakMs);
    const paused = await client.request('soak-pause', 'transport', { action: 'pause' });
    const minimumRenderedFrames = Math.max(probe.frames * 2, Math.floor(probe.sampleRate * soakMs / 2_000));
    const soak = validateSoakWindow(baseline, paused, minimumRenderedFrames);

    const stopped = await client.request('restart-stop', 'transport', { action: 'stop', loopEnabled: false });
    if (stopped.status !== 'stopped' || stopped.sample !== 0) throw new Error('CoreAudio transport stop did not reset the playback cursor.');
    const restartBaseline = validateStableDeviceTelemetry(stopped, 'transport restart baseline');
    await client.request('restart-play', 'transport', { action: 'play', tick: 0, sample: 0, loopEnabled: false });
    await delay(restartProbeMs);
    const restarted = await client.request('restart-pause', 'transport', { action: 'pause' });
    const restartTelemetry = validateStableDeviceTelemetry(restarted, 'transport restart');
    if (!Number.isSafeInteger(restarted.sample) || restarted.sample <= 0 || restarted.sample > probe.frames) {
      throw new Error(`CoreAudio transport did not advance after stop/restart: ${String(restarted.sample)} samples.`);
    }
    if (restartTelemetry.renderedFrames <= restartBaseline.renderedFrames) throw new Error('CoreAudio rendered-frame telemetry did not advance after stop/restart.');
    await client.request('restart-final-stop', 'transport', { action: 'stop' });
    await shutdownNaturally(child, client, 'soak');
    return {
      pid: child.pid,
      hello,
      soak,
      restartSamples: restarted.sample,
      restartRenderedFrames: restartTelemetry.renderedFrames - restartBaseline.renderedFrames,
      naturalExit: true,
    };
  });
}

async function runProcessRestartCycle(binary, previewPath, probe) {
  return withAudioService(binary, ['--stdio'], async (child, client) => {
    const hello = validateCoreAudioHello(await client.request('process-restart-hello', 'hello'));
    await preparePreview(client, 'process-restart', previewPath, 2);
    const baseline = await client.request('process-restart-baseline', 'transport', { action: 'stop' });
    const baselineTelemetry = validateStableDeviceTelemetry(baseline, 'process restart baseline');
    await client.request('process-restart-play', 'transport', { action: 'play', tick: 0, sample: 0 });
    await delay(restartProbeMs);
    const paused = await client.request('process-restart-pause', 'transport', { action: 'pause' });
    const telemetry = validateStableDeviceTelemetry(paused, 'process restart');
    if (!Number.isSafeInteger(paused.sample) || paused.sample <= 0 || paused.sample > probe.frames || telemetry.renderedFrames <= baselineTelemetry.renderedFrames) {
      throw new Error('A fresh CoreAudio service did not render after process restart.');
    }
    await shutdownNaturally(child, client, 'process-restart');
    return { pid: child.pid, hello, callbackSamplesObserved: paused.sample, naturalExit: true };
  });
}

async function runExclusiveRejectionCycle(binary, previewPath) {
  return withAudioService(binary, ['--stdio', '--playback-mode=exclusive'], async (child, client) => {
    const hello = validateCoreAudioExclusiveHello(await client.request('exclusive-hello', 'hello'));
    await client.request('exclusive-prepare', 'prepare-project', { projectId: 'macos-coreaudio-exclusive', revision: 3 });
    await client.request('exclusive-commit', 'commit-project', { projectId: 'macos-coreaudio-exclusive', revision: 3 });
    const stopped = await client.request('exclusive-stop', 'transport', { action: 'stop' });
    if (stopped.realtimeBackendReady !== false || stopped.effectivePlaybackMode !== 'unavailable') throw new Error('Exclusive transport diagnostics did not remain fail closed.');
    let loadRejected = false;
    try {
      await client.request('exclusive-load', 'load-playback', {
        projectId: 'macos-coreaudio-exclusive', revision: 3, previewPath, preserveTransport: false,
      });
    } catch (error) {
      loadRejected = /playback-load-failed.*CoreAudio exclusive output is not implemented; no shared-mode fallback was attempted\./.test(String(error));
      if (!loadRejected) throw error;
    }
    if (!loadRejected) throw new Error('CoreAudio exclusive preview load did not fail closed.');
    await shutdownNaturally(child, client, 'exclusive');
    return { pid: child.pid, diagnostic: hello.diagnostic, loadRejected, naturalExit: true };
  });
}

function commandLine() {
  let binary;
  let soakMs = defaultSoakMs;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--binary') binary = process.argv[++index];
    else if (argument === '--soak-ms') soakMs = Number(process.argv[++index]);
    else if (!argument.startsWith('--') && binary === undefined) binary = argument;
    else throw new Error(`Unknown CoreAudio smoke argument: ${argument}`);
  }
  if (!Number.isSafeInteger(soakMs) || soakMs < 1_000 || soakMs > 120_000) throw new Error('--soak-ms must be an integer from 1000 through 120000.');
  return {
    binary: resolve(binary ?? join(workspace, 'native', `build-darwin-${process.arch}`, 'aimuse-audio')),
    soakMs,
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error(`CoreAudio smoke requires darwin, received ${process.platform}.`);
  const options = commandLine();
  const runRoot = await mkdtemp(join(tmpdir(), 'aimuse-coreaudio-smoke-'));
  const previewPath = join(runRoot, 'probe.wav');
  const probe = createProbeWav();
  await writeFile(previewPath, probe.wav, { mode: 0o600 });
  try {
    const soak = await runSoakCycle(options.binary, previewPath, probe, options.soakMs);
    const processRestart = await runProcessRestartCycle(options.binary, previewPath, probe);
    if (processRestart.pid === soak.pid) throw new Error('CoreAudio process restart reused the prior live process identity.');
    const exclusive = await runExclusiveRejectionCycle(options.binary, previewPath);
    const deviceReroutes = soak.soak.telemetry.deviceReroutes;
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      driver: soak.hello.driver,
      requestedPlaybackMode: soak.hello.requestedPlaybackMode,
      effectivePlaybackMode: soak.hello.effectivePlaybackMode,
      sampleRate: soak.hello.sampleRate,
      latencySamples: soak.hello.latencySamples,
      probeDurationMs: probe.durationMs,
      probePeak: probe.peak,
      soakDurationMs: options.soakMs,
      soakCallbackCount: soak.soak.callbackCount,
      soakCallbackFrames: soak.soak.callbackFrames,
      soakRenderedFrames: soak.soak.renderedFrames,
      transportRestartSamplesObserved: soak.restartSamples,
      transportRestartRenderedFrames: soak.restartRenderedFrames,
      processRestart: {
        firstPid: soak.pid,
        secondPid: processRestart.pid,
        callbackSamplesObserved: processRestart.callbackSamplesObserved,
        bothExitedNaturally: soak.naturalExit && processRestart.naturalExit,
      },
      deviceNotifications: {
        reroutes: deviceReroutes,
        interruptions: soak.soak.telemetry.deviceInterruptions,
        unexpectedStops: soak.soak.telemetry.deviceUnexpectedStops,
        physicalDeviceEventObserved: deviceReroutes > 0,
        injectedHandlerCoverageOnlyWhenFalse: deviceReroutes === 0,
      },
      exclusiveMode: {
        status: 'explicit-non-feature',
        loadRejected: exclusive.loadRejected,
        diagnostic: exclusive.diagnostic,
        naturalExit: exclusive.naturalExit,
      },
      naturalExit: true,
    }, null, 2)}\n`);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`AIMuse CoreAudio smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
