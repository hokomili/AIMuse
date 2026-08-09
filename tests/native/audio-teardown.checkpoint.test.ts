import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createProject, entityBase, type MidiClip } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { decodeWav } from '../../src/main/wav';

const processGuard = vi.hoisted(() => ({ children: [] as ChildProcessWithoutNullStreams[], forceAttempts: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...arguments_: unknown[]) => {
      const child = Reflect.apply(actual.spawn, actual, arguments_) as ChildProcessWithoutNullStreams;
      child.kill = (() => { processGuard.forceAttempts += 1; return false; }) as ChildProcessWithoutNullStreams['kill'];
      processGuard.children.push(child);
      return child;
    },
  };
});

interface ControllerProbe {
  native?: ChildProcessWithoutNullStreams;
  previewRefreshRunning: boolean;
  previewRefreshTask?: Promise<void>;
}

interface RetainedEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface NativeCaseEvidence {
  schemaVersion: 1;
  status: 'PASS' | 'FAIL';
  phase: string;
  hostPid: number;
  audioPid?: number;
  driver?: string;
  sampleRate?: number;
  previewPeak?: number;
  audibleDurationMs: number;
  refreshObservedPending: boolean;
  forceAttempted: boolean;
  gracefulExitObserved: boolean;
  gracefulExitCode?: number | null;
  gracefulExitSignal?: string | null;
  gracefulExitTimeoutMs: number;
  playbackRootRenamed: boolean;
  originalPlaybackRootAbsentAfterQuietWindow: boolean;
  retainedManifestStable: boolean;
  quietWindowMs: number;
  retainedEntries: RetainedEntry[];
  survivorPid?: number;
  error?: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required checkpoint environment ${name} is missing.`);
  return value;
}

function controllerProbe(controller: AudioEngineController): ControllerProbe {
  return controller as unknown as ControllerProbe;
}

function sanitize(message: string, runRoot: string): string {
  return message.replaceAll(runRoot, '<run-root>').replaceAll(process.cwd(), '<workspace>');
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
}

async function retainedManifest(root: string): Promise<RetainedEntry[]> {
  const entries: RetainedEntry[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: (await stat(path)).size, sha256: await sha256(path) });
      else throw new Error('Playback evidence contains a non-file, non-directory object.');
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function waitForRefresh(probe: ControllerProbe, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (probe.previewRefreshRunning && probe.previewRefreshTask) return true;
    await delay(10);
  }
  return false;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ exited: boolean; code?: number | null; signal?: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ exited: false }), timeoutMs);
    timer.unref();
    child.once('exit', (code, signal) => { clearTimeout(timer); resolvePromise({ exited: true, code, signal }); });
  });
}

function unrefSurvivor(child: ChildProcessWithoutNullStreams): void {
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const candidate = stream as unknown as { unref?: () => void };
    candidate.unref?.();
  }
}

describe('AUD-02 retained native teardown checkpoint', () => {
  it('quiesces preview work before a retained rename probe without force or cleanup', async () => {
    const runRoot = requiredEnvironment('AIMUSE_AUD02_RUN_ROOT');
    const audioBinary = requiredEnvironment('AIMUSE_AUD02_AUDIO_EXE');
    const playbackRoot = join(runRoot, 'playback-root');
    const retainedPlaybackRoot = join(runRoot, 'retained-playback-root');
    const evidencePath = join(runRoot, 'native-case.json');
    if (existsSync(playbackRoot) || existsSync(retainedPlaybackRoot) || existsSync(evidencePath)) throw new Error('Checkpoint-owned paths must be absent before the native case starts.');

    const evidence: NativeCaseEvidence = {
      schemaVersion: 1,
      status: 'FAIL',
      phase: 'start',
      hostPid: process.pid,
      audibleDurationMs: 180,
      refreshObservedPending: false,
      forceAttempted: false,
      gracefulExitObserved: false,
      gracefulExitTimeoutMs: 3_000,
      playbackRootRenamed: false,
      originalPlaybackRootAbsentAfterQuietWindow: false,
      retainedManifestStable: false,
      quietWindowMs: 2_000,
      retainedEntries: [],
    };
    const controller = new AudioEngineController(audioBinary, 'aud02-native-teardown-checkpoint', playbackRoot);
    let child: ChildProcessWithoutNullStreams | undefined;
    let stopCalled = false;

    try {
      evidence.phase = 'native-start';
      await controller.start();
      child = processGuard.children.at(-1) ?? controllerProbe(controller).native;
      if (!child?.pid) throw new Error('Native audio child identity was unavailable after start.');
      evidence.audioPid = child.pid;
      const status = controller.status();
      evidence.driver = status.driver;
      expect(status).toMatchObject({ mode: 'native', connected: true, driver: 'wasapi' });

      evidence.phase = 'initial-preview';
      const project = createProject('song', 'AUD-02 retained teardown');
      project.revision = 101;
      const track = project.tracks[project.trackOrder[0]];
      const note = { ...entityBase('note'), startTick: 0, durationTicks: 960, pitch: 69, velocity: 0.25, releaseVelocity: 0.25, channel: 0, probability: 1 };
      const clip: MidiClip = {
        ...entityBase('clip'), kind: 'midi', trackId: track.id, name: 'Bounded 440 Hz checkpoint tone', color: track.color,
        startTick: 0, durationTicks: 57_600, muted: false, gainDb: 0,
        fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: false,
        notes: { [note.id]: note }, noteOrder: [note.id], controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
      };
      project.clips[clip.id] = clip;
      track.clipIds.push(clip.id);
      await controller.prepareProject(project);
      await controller.commitPreparedProject(project);
      await controller.transport('play');
      await delay(evidence.audibleDurationMs);
      await controller.transport('pause');

      const previewNames = (await readdir(playbackRoot)).filter((name) => name.endsWith('.wav'));
      expect(previewNames).toHaveLength(1);
      const preview = decodeWav(await readFile(join(playbackRoot, previewNames[0])));
      evidence.sampleRate = preview.sampleRate;
      evidence.previewPeak = Math.max(...preview.data[0].subarray(0, Math.min(preview.frames, preview.sampleRate)));
      expect(evidence.previewPeak).toBeGreaterThan(0.005);
      expect(evidence.previewPeak).toBeLessThan(0.05);

      evidence.phase = 'refresh-race';
      const edited = structuredClone(project);
      edited.revision = 102;
      edited.tracks[edited.trackOrder[0]].mute = true;
      await controller.prepareProject(edited);
      await controller.commitPreparedProject(edited);
      evidence.refreshObservedPending = await waitForRefresh(controllerProbe(controller), 5_000);
      expect(evidence.refreshObservedPending).toBe(true);

      evidence.phase = 'graceful-stop';
      stopCalled = true;
      await controller.stop();
      evidence.forceAttempted = processGuard.forceAttempts > 0;
      const exit = await waitForExit(child, evidence.gracefulExitTimeoutMs);
      evidence.gracefulExitObserved = exit.exited;
      evidence.gracefulExitCode = exit.code;
      evidence.gracefulExitSignal = exit.signal;
      if (!exit.exited) {
        evidence.survivorPid = child.pid;
        unrefSurvivor(child);
      }
      expect(evidence.forceAttempted).toBe(false);
      expect(exit).toMatchObject({ exited: true, code: 0, signal: null });

      evidence.phase = 'retained-rename-probe';
      const before = await retainedManifest(playbackRoot);
      expect(before.some((entry) => entry.path.endsWith('.wav'))).toBe(true);
      await rename(playbackRoot, retainedPlaybackRoot);
      evidence.playbackRootRenamed = true;
      await delay(evidence.quietWindowMs);
      evidence.originalPlaybackRootAbsentAfterQuietWindow = !existsSync(playbackRoot);
      const after = await retainedManifest(retainedPlaybackRoot);
      evidence.retainedManifestStable = JSON.stringify(before) === JSON.stringify(after);
      evidence.retainedEntries = after;
      expect(evidence.originalPlaybackRootAbsentAfterQuietWindow).toBe(true);
      expect(evidence.retainedManifestStable).toBe(true);

      evidence.phase = 'complete';
      evidence.status = 'PASS';
    } catch (error) {
      evidence.error = sanitize(error instanceof Error ? error.message : String(error), runRoot);
      if (!stopCalled) {
        stopCalled = true;
        await controller.stop().catch((stopError) => {
          evidence.error = `${evidence.error}; graceful stop failed: ${sanitize(stopError instanceof Error ? stopError.message : String(stopError), runRoot)}`;
        });
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = await waitForExit(child, evidence.gracefulExitTimeoutMs);
        evidence.gracefulExitObserved = exit.exited;
        evidence.gracefulExitCode = exit.code;
        evidence.gracefulExitSignal = exit.signal;
        if (!exit.exited) { evidence.survivorPid = child.pid; unrefSurvivor(child); }
      }
      throw error;
    } finally {
      evidence.forceAttempted = processGuard.forceAttempts > 0;
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
  }, 45_000);
});
