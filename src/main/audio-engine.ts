import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { createId, samplesToTicks, ticksToSamples, type AIMuseProject, type Id, type TransportState } from '@aimuse/core';
import type { AudioHostEvent, AudioHostRequest, AudioHostResponse } from '../common/audio-protocol';
import { audioServiceArguments, validateNativePlaybackModeReport, type AudioPlaybackMode, type EffectiveAudioPlaybackMode } from './audio-playback-mode';
import { nativeAudioBackendLabel, nativeAudioDriverLabel, type NativeAudioDriver } from './platform';
import { settleAudioChildShutdown } from './audio-child-lifecycle';
import { unavailableMidiDiscovery, validateNativeMidiDiscovery, type MidiDiscoveryStatus } from './midi-discovery';
import { settleAudioPreviewWork } from './audio-preview-lifecycle';
import { reconcileNativeAudioTelemetry } from './audio-telemetry';
import { renderProjectToWav, type ProjectRenderResult } from './project-renderer';

export interface AudioEngineStatus { mode: 'native' | 'fallback'; connected: boolean; driver: NativeAudioDriver; requestedPlaybackMode: AudioPlaybackMode; effectivePlaybackMode: EffectiveAudioPlaybackMode; midiDiscovery: MidiDiscoveryStatus; message?: string }
interface NativeHello { protocolVersion: number; serviceVersion: string; driver: NativeAudioDriver; requestedPlaybackMode?: unknown; effectivePlaybackMode?: unknown; realtimeBackendReady: boolean; features: string[]; sampleRate?: number; latencySamples?: number; midiDiscovery?: unknown; diagnostic?: string }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface PlaybackPreview { key: string; path: string; durationSamples: number; sampleRate: number }

export class AudioEngineController extends EventEmitter {
  private project?: AIMuseProject;
  private preparedProject?: AIMuseProject;
  private timer?: NodeJS.Timeout;
  private playStartedAt = 0;
  private playStartedTick = 0;
  private state: TransportState = { status: 'stopped', tick: 0, sample: 0, loopEnabled: false, loopStartTick: 0, loopEndTick: 15_360, metronomeEnabled: true, cpuLoad: 0, xruns: 0, latencySamples: 256, graphRevision: 0 };
  private statusValue: AudioEngineStatus;
  private native?: ChildProcessWithoutNullStreams;
  private nativeLines?: ReadLineInterface;
  private nativeStopping = false;
  private pending = new Map<Id, PendingRequest>();
  private nativeDiagnostic = '';
  private previews = new Map<Id, PlaybackPreview>();
  private previewBuilds = new Map<string, Promise<PlaybackPreview>>();
  private previewRefreshTimer?: NodeJS.Timeout;
  private previewRefreshTask?: Promise<void>;
  private previewRefreshRequested?: AIMuseProject;
  private previewRefreshRunning = false;
  private nativePreviewKey?: string;
  private nativePreviewProjectId?: Id;
  private renderWorkerAvailable?: boolean;
  private readonly playbackCacheRoot: string;

  constructor(private readonly nativeBinary?: string, private readonly appVersion = 'development', playbackCacheRoot?: string, private readonly renderWorkerPath?: string, private readonly requestedPlaybackMode: AudioPlaybackMode = 'shared') {
    super();
    this.playbackCacheRoot = playbackCacheRoot ?? join(tmpdir(), 'aimuse-playback', `${process.pid}-${createId('engine')}`);
    this.statusValue = {
      mode: 'fallback', connected: true, driver: 'offline',
      requestedPlaybackMode: this.requestedPlaybackMode, effectivePlaybackMode: 'unavailable',
      midiDiscovery: unavailableMidiDiscovery(),
      message: `Native service is not built; requested ${nativeAudioBackendLabel()} ${this.requestedPlaybackMode} output is unavailable, while deterministic offline rendering and transport remain active.`,
    };
  }

  async start(): Promise<void> {
    if (!this.nativeBinary || !isAbsolute(this.nativeBinary) || !(await access(this.nativeBinary).then(() => true, () => false))) return;
    this.nativeStopping = false;
    const child = spawn(this.nativeBinary, audioServiceArguments(this.requestedPlaybackMode), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.native = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.nativeLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.nativeLines.on('line', (line) => this.handleNativeLine(line));
    child.stderr.on('data', (chunk: string) => { this.nativeDiagnostic = `${this.nativeDiagnostic}${chunk}`.slice(-8_000); });
    child.once('error', (error) => this.degradeNative(`Native audio service failed to start: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.native === child) this.native = undefined;
      if (!this.nativeStopping) this.degradeNative(`Native audio service exited (${signal ?? code ?? 'unknown'}). ${this.nativeDiagnostic.trim()}`.trim());
    });
    try {
      const hello = await this.nativeCall<NativeHello>('hello', { appVersion: this.appVersion }, 4_000);
      if (hello.protocolVersion !== 1) throw new Error(`Unsupported native protocol ${hello.protocolVersion}.`);
      const playbackMode = validateNativePlaybackModeReport(this.requestedPlaybackMode, hello);
      this.statusValue = {
        mode: 'native', connected: true, driver: hello.realtimeBackendReady ? hello.driver : 'offline',
        ...playbackMode,
        midiDiscovery: validateNativeMidiDiscovery(hello.midiDiscovery),
        message: hello.realtimeBackendReady
          ? `Native ${nativeAudioDriverLabel(hello.driver)} ${playbackMode.effectivePlaybackMode} output ${hello.serviceVersion} connected at ${hello.sampleRate ?? 48_000} Hz.`
          : `Native DSP service ${hello.serviceVersion} connected; requested ${nativeAudioBackendLabel()} ${playbackMode.requestedPlaybackMode} output is unavailable: ${hello.diagnostic ?? 'the service did not provide a diagnostic.'}`,
      };
      if (hello.latencySamples !== undefined) this.state.latencySamples = hello.latencySamples;
    } catch (error) {
      child.kill();
      this.degradeNative(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<void> {
    this.nativeStopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.previewRefreshTimer) clearTimeout(this.previewRefreshTimer);
    this.timer = undefined;
    this.previewRefreshTimer = undefined;
    this.previewRefreshRequested = undefined;
    await settleAudioPreviewWork(this.previewRefreshTask, this.previewBuilds.values());
    const child = this.native;
    if (child) {
      await settleAudioChildShutdown(
        child,
        () => this.nativeCall('shutdown', {}, 1_500),
        () => { child.kill(); },
        1_500,
      );
    }
    this.nativeLines?.close(); this.nativeLines = undefined; this.native = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native audio service stopped.')); }
    this.pending.clear(); this.preparedProject = undefined; this.state.status = 'stopped'; this.emit('transport', this.snapshot());
    this.previews.clear(); this.previewBuilds.clear(); this.nativePreviewKey = undefined; this.nativePreviewProjectId = undefined;
    this.previewRefreshTask = undefined;
  }
  status(): AudioEngineStatus { return { ...this.statusValue }; }
  snapshot(): TransportState { return structuredClone(this.state); }

  async prepareProject(project: AIMuseProject): Promise<{ graphRevision: number }> {
    for (const device of Object.values(project.devices)) {
      if (device.format !== 'builtin' && !device.pluginId) throw new Error(`Plug-in device ${device.name} has no stable ID.`);
      for (const parameter of Object.values(device.parameters)) if (!Number.isFinite(parameter.value) || parameter.value < parameter.min || parameter.value > parameter.max) throw new Error(`Device parameter ${parameter.name} is invalid.`);
    }
    if (this.native) {
      const prepared = await this.nativeCall<{ graphRevision: number; prepared: boolean }>('prepare-project', { projectId: project.id, revision: project.revision, project }, 15_000);
      if (!prepared.prepared || prepared.graphRevision !== project.revision) throw new Error(`Native graph acknowledgement mismatch: expected ${project.revision}, received ${prepared.graphRevision}.`);
    }
    this.preparedProject = structuredClone(project); return { graphRevision: project.revision };
  }

  async commitPreparedProject(project: AIMuseProject = this.preparedProject!): Promise<{ graphRevision: number }> {
    if (!project || !this.preparedProject || project.id !== this.preparedProject.id || project.revision !== this.preparedProject.revision) throw new Error('No matching prepared audio graph is available to commit.');
    const sameProject = this.project?.id === project.id;
    if (sameProject && (this.state.status === 'playing' || this.state.status === 'recording')) this.updateClock();
    if (this.native) {
      try { await this.nativeCall<{ graphRevision: number; committed: boolean }>('commit-project', { projectId: project.id, revision: project.revision }, 3_000); }
      catch (error) { this.degradeNative(`Native graph commit failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.project = structuredClone(project); this.preparedProject = undefined; this.state.projectId = project.id; this.state.graphRevision = project.revision; this.state.metronomeEnabled = project.settings.metronomeEnabled;
    if (!sameProject) {
      this.state.status = 'stopped'; this.state.tick = 0; this.state.sample = 0;
      this.nativePreviewKey = undefined; this.nativePreviewProjectId = undefined;
    } else {
      this.state.sample = ticksToSamples(project, this.state.tick);
      if (this.state.status === 'playing' || this.state.status === 'recording') { this.playStartedTick = this.state.tick; this.playStartedAt = performance.now(); }
    }
    this.schedulePreviewRefresh(project);
    return { graphRevision: project.revision };
  }

  async abortPreparedProject(project?: AIMuseProject): Promise<void> {
    const candidate = project ?? this.preparedProject; if (!candidate) return;
    if (this.native) await this.nativeCall('abort-project', { projectId: candidate.id, revision: candidate.revision }, 2_000).catch(() => undefined);
    if (this.preparedProject?.id === candidate.id && this.preparedProject.revision === candidate.revision) this.preparedProject = undefined;
  }

  async synchronizeProject(project: AIMuseProject): Promise<{ graphRevision: number }> { await this.prepareProject(project); return this.commitPreparedProject(project); }

  async transport(action: 'play' | 'record' | 'pause' | 'stop' | 'seek' | 'loop', options: { tick?: number; loopEnabled?: boolean; loopStartTick?: number; loopEndTick?: number } = {}): Promise<TransportState> {
    if (action === 'pause' && (this.state.status === 'playing' || this.state.status === 'recording')) this.updateClock();
    if ((action === 'play' || action === 'record') && this.native && this.statusValue.driver !== 'offline') await this.ensureNativePlayback();
    const tick = action === 'seek' ? Math.max(0, Math.round(options.tick ?? 0)) : this.state.tick;
    const loopStartTick = options.loopStartTick === undefined ? this.state.loopStartTick : Math.max(0, Math.round(options.loopStartTick));
    const loopEndTick = options.loopEndTick === undefined ? this.state.loopEndTick : Math.max(loopStartTick + 1, Math.round(options.loopEndTick));
    const loopEnabled = options.loopEnabled ?? this.state.loopEnabled;
    let nativeState: (Pick<TransportState, 'sample'> & { cpuLoad?: unknown; xruns?: unknown }) | undefined;
    if (this.native && this.statusValue.driver !== 'offline') {
      try {
        const receivedState = await this.nativeCall<Pick<TransportState, 'sample'> & { cpuLoad?: unknown; xruns?: unknown }>('transport', {
          action, projectId: this.project?.id, tick,
          sample: this.project ? ticksToSamples(this.project, tick) : 0,
          loopEnabled, loopStartTick, loopEndTick,
          loopStartSample: this.project ? ticksToSamples(this.project, loopStartTick) : 0,
          loopEndSample: this.project ? ticksToSamples(this.project, loopEndTick) : 1,
        }, 3_000);
        const telemetry = reconcileNativeAudioTelemetry(this.state, receivedState);
        this.state.cpuLoad = telemetry.cpuLoad;
        this.state.xruns = telemetry.xruns;
        nativeState = receivedState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.degradeNative(message);
        if (action === 'play' || action === 'record') throw new Error(`Real-time playback failed: ${message}`);
      }
    }
    if (action === 'seek') { this.state.tick = Math.max(0, Math.round(options.tick ?? 0)); this.state.sample = this.project ? ticksToSamples(this.project, this.state.tick) : 0; }
    if (action === 'loop') { if (options.loopStartTick !== undefined) this.state.loopStartTick = Math.max(0, Math.round(options.loopStartTick)); if (options.loopEndTick !== undefined) this.state.loopEndTick = Math.max(this.state.loopStartTick + 1, Math.round(options.loopEndTick)); if (options.loopEnabled !== undefined) this.state.loopEnabled = options.loopEnabled; }
    if (action === 'play') { this.state.status = 'playing'; this.playStartedAt = performance.now(); this.playStartedTick = this.state.tick; this.ensureTimer(); }
    if (action === 'record') { this.state.status = 'recording'; this.playStartedAt = performance.now(); this.playStartedTick = this.state.tick; this.ensureTimer(); }
    if (action === 'pause') { this.state.status = 'paused'; if (nativeState && this.project) { this.state.sample = Math.max(0, Math.round(nativeState.sample)); this.state.tick = samplesToTicks(this.project, this.state.sample); } }
    if (action === 'stop') { this.state.status = 'stopped'; this.state.tick = 0; this.state.sample = 0; }
    if (action === 'seek' && (this.state.status === 'playing' || this.state.status === 'recording')) { this.playStartedTick = this.state.tick; this.playStartedAt = performance.now(); }
    this.emit('transport', this.snapshot()); return this.snapshot();
  }

  private previewKey(project: AIMuseProject): string { return `${project.id}:${project.revision}`; }

  private async ensureNativePlayback(): Promise<void> {
    const project = this.project;
    if (!project) throw new Error('No committed project is available for playback.');
    const key = this.previewKey(project);
    if (this.nativePreviewProjectId === project.id) { if (this.nativePreviewKey !== key) this.schedulePreviewRefresh(project); return; }
    const preview = await this.ensurePreviewBuilt(project);
    await this.installPreview(project, preview, false);
  }

  private async installPreview(project: AIMuseProject, preview: PlaybackPreview, preserveTransport: boolean): Promise<void> {
    const loaded = await this.nativeCall<{ loaded: boolean; graphRevision: number; sampleRate: number }>('load-playback', {
      projectId: project.id, revision: project.revision, previewPath: preview.path, preserveTransport,
    }, 30_000);
    if (!loaded.loaded || loaded.graphRevision !== project.revision || loaded.sampleRate !== project.settings.sampleRate) throw new Error('Native playback preview acknowledgement did not match the committed project.');
    this.nativePreviewKey = preview.key; this.nativePreviewProjectId = project.id;
  }

  private schedulePreviewRefresh(project: AIMuseProject): void {
    if (this.nativeStopping || !this.native || this.statusValue.driver === 'offline') return;
    this.previewRefreshRequested = structuredClone(project);
    if (this.previewRefreshRunning) return;
    if (this.previewRefreshTimer) clearTimeout(this.previewRefreshTimer);
    this.previewRefreshTimer = setTimeout(() => {
      this.previewRefreshTimer = undefined;
      const task = this.drainPreviewRefresh();
      this.previewRefreshTask = task;
      const clearTask = () => { if (this.previewRefreshTask === task) this.previewRefreshTask = undefined; };
      void task.then(clearTask, clearTask);
    }, 75);
    this.previewRefreshTimer.unref();
  }

  private async drainPreviewRefresh(): Promise<void> {
    if (this.nativeStopping || this.previewRefreshRunning) return;
    const project = this.previewRefreshRequested;
    if (!project) return;
    this.previewRefreshRequested = undefined;
    this.previewRefreshRunning = true;
    try {
      const preview = await this.ensurePreviewBuilt(project);
      if (!this.nativeStopping && this.project && this.previewKey(this.project) === preview.key && this.native && this.statusValue.driver !== 'offline') {
        await this.installPreview(project, preview, this.nativePreviewProjectId === project.id);
      }
    } catch (error) {
      if (this.project && this.previewKey(this.project) === this.previewKey(project)) {
        this.statusValue = { ...this.statusValue, message: `Playback refresh failed: ${error instanceof Error ? error.message : String(error)} The previous revision remains available.` };
        this.emit('status', this.status());
      }
    } finally {
      this.previewRefreshRunning = false;
      if (!this.nativeStopping && this.previewRefreshRequested) this.schedulePreviewRefresh(this.previewRefreshRequested);
    }
  }

  private async ensurePreviewBuilt(project: AIMuseProject): Promise<PlaybackPreview> {
    const key = this.previewKey(project);
    const existing = this.previews.get(project.id);
    if (existing?.key === key && await access(existing.path).then(() => true, () => false)) return existing;
    const building = this.previewBuilds.get(key);
    if (building) return building;
    const promise = this.buildPlaybackPreview(project);
    this.previewBuilds.set(key, promise);
    try { return await promise; }
    finally { if (this.previewBuilds.get(key) === promise) this.previewBuilds.delete(key); }
  }

  private async buildPlaybackPreview(project: AIMuseProject): Promise<PlaybackPreview> {
    const key = this.previewKey(project);
    const safeProjectId = project.id.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(this.playbackCacheRoot, `${safeProjectId}-${project.revision}.wav`);
    const endTick = Math.max(
      project.settings.ppq * 4 * 16,
      ...Object.values(project.clips).map((clip) => clip.startTick + clip.durationTicks),
      ...Object.values(project.sfxDeliverables).map((deliverable) => deliverable.endTick),
    ) + project.settings.ppq * 4 * 4;
    let rendered: ProjectRenderResult;
    if (await access(path).then(() => true, () => false)) rendered = { destination: path, durationSamples: ticksToSamples(project, endTick), warnings: [] };
    else rendered = await this.render(project, path, 0, endTick);
    const previous = this.previews.get(project.id);
    const preview = { key, path, durationSamples: rendered.durationSamples, sampleRate: project.settings.sampleRate };
    this.previews.set(project.id, preview);
    if (previous && previous.path !== path) await rm(previous.path, { force: true }).catch(() => undefined);
    return preview;
  }

  private nativeCall<T = unknown>(method: AudioHostRequest['method'], params: unknown, timeoutMs: number): Promise<T> {
    const child = this.native;
    if (!child || child.killed || child.exitCode !== null) return Promise.reject(new Error('Native audio service is unavailable.'));
    const id = createId('audio-request');
    const request = { version: 1, id, method, params } as AudioHostRequest;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native ${method} request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject, timer });
      child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error);
      });
    });
  }

  private handleNativeLine(line: string): void {
    if (line.length > 8_000_000) { this.degradeNative('Native audio service emitted an oversized protocol message.'); return; }
    let message: AudioHostResponse | AudioHostEvent;
    try { message = JSON.parse(line) as AudioHostResponse | AudioHostEvent; }
    catch { this.degradeNative('Native audio service emitted malformed JSON.'); return; }
    if ('event' in message) {
      if (message.event === 'transport') this.emit('transport', message.state);
      else if (message.event === 'meter') this.emit('meter', message);
      else if (message.event === 'xrun') { this.state.xruns = message.count; }
      else if (message.event === 'plugin-crash') this.emit('plugin-crash', message);
      return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(`${message.error?.code ?? 'native-error'}: ${message.error?.message ?? 'Native request failed.'}`));
  }

  private degradeNative(message: string): void {
    const child = this.native;
    this.nativeLines?.close(); this.nativeLines = undefined;
    this.native = undefined;
    if (child && child.exitCode === null && !child.killed) child.kill();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    this.statusValue = {
      mode: 'fallback', connected: true, driver: 'offline',
      requestedPlaybackMode: this.requestedPlaybackMode, effectivePlaybackMode: 'unavailable',
      midiDiscovery: unavailableMidiDiscovery(),
      message: `${message} Deterministic offline rendering remains available.`,
    };
    this.nativePreviewKey = undefined;
    this.emit('status', this.status());
  }

  private ensureTimer(): void { if (this.timer) return; this.timer = setInterval(() => { if (this.state.status === 'playing' || this.state.status === 'recording') { this.updateClock(); this.emit('transport', this.snapshot()); } }, 50); this.timer.unref(); }

  private updateClock(): void {
    if (!this.project || (this.state.status !== 'playing' && this.state.status !== 'recording')) return;
    const elapsedSamples = Math.round((performance.now() - this.playStartedAt) / 1000 * this.project.settings.sampleRate);
    const startSamples = ticksToSamples(this.project, this.playStartedTick); const targetSamples = startSamples + elapsedSamples;
    let tick = this.playStartedTick; let low = this.playStartedTick; let high = this.playStartedTick + Math.ceil(elapsedSamples / this.project.settings.sampleRate * 400 * this.project.settings.ppq / 60) + this.project.settings.ppq;
    while (low <= high) { const middle = Math.floor((low + high) / 2); const samples = ticksToSamples(this.project, middle); if (samples < targetSamples) { tick = middle; low = middle + 1; } else high = middle - 1; }
    if (this.state.loopEnabled && tick >= this.state.loopEndTick) { this.state.tick = this.state.loopStartTick; this.playStartedTick = this.state.tick; this.playStartedAt = performance.now(); }
    else if (this.previews.get(this.project.id)?.key === this.previewKey(this.project) && targetSamples >= this.previews.get(this.project.id)!.durationSamples) { const preview = this.previews.get(this.project.id)!; this.state.sample = preview.durationSamples; this.state.tick = samplesToTicks(this.project, this.state.sample); this.state.status = 'paused'; return; }
    else this.state.tick = tick;
    this.state.sample = ticksToSamples(this.project, this.state.tick);
  }

  async render(project: AIMuseProject, destination: string, startTick = 0, endTick?: number, trackIds?: Id[]): Promise<{ destination: string; durationSamples: number; warnings: string[] }> {
    const request = { project, destination, startTick, endTick, trackIds };
    if (await this.hasRenderWorker()) return this.renderInWorker(request);
    return renderProjectToWav(request);
  }

  private async hasRenderWorker(): Promise<boolean> {
    if (this.renderWorkerAvailable !== undefined) return this.renderWorkerAvailable;
    this.renderWorkerAvailable = Boolean(this.renderWorkerPath && isAbsolute(this.renderWorkerPath) && await access(this.renderWorkerPath).then(() => true, () => false));
    return this.renderWorkerAvailable;
  }

  private renderInWorker(request: Parameters<typeof renderProjectToWav>[0]): Promise<ProjectRenderResult> {
    return new Promise<ProjectRenderResult>((resolvePromise, reject) => {
      const worker = new Worker(this.renderWorkerPath!, { workerData: request });
      let settled = false;
      const finish = (callback: () => void) => { if (settled) return; settled = true; callback(); void worker.terminate(); };
      worker.once('message', (message: { ok: boolean; result?: ProjectRenderResult; error?: string }) => {
        if (message.ok && message.result) finish(() => resolvePromise(message.result!));
        else finish(() => reject(new Error(message.error ?? 'Playback render worker failed.')));
      });
      worker.once('error', (error) => finish(() => reject(error)));
      worker.once('exit', (code) => { if (code !== 0) finish(() => reject(new Error(`Playback render worker exited with code ${code}.`))); });
    });
  }
}
