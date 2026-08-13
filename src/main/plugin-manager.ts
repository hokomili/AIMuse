import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import {
  HUMAN_ACTOR, createId, entityBase, nowIso,
  type Actor, type Device, type DeviceParameter, type Id, type PluginDescriptor, type ProjectTransaction,
} from '@aimuse/core';
import { AuthorityManager } from './authority-manager';
import { atomicWriteFile, sha256File } from './persistence';
import { ProjectService } from './project-service';

export interface PluginScannerOutput {
  pluginUid: string; name: string; vendor?: string; version?: string; categories?: string[]; instrument?: boolean; parameters?: DeviceParameter[];
}
interface QuarantineEntry { path: string; hash?: string; reason: string; occurredAt: string }
interface PluginCatalogFile { version: 1; scannedAt: string; plugins: PluginDescriptor[]; quarantine: QuarantineEntry[] }
export interface PluginScanPartialEffects {
  discovery: 'not-started' | 'may-have-completed' | 'completed';
  nativeHelper: 'not-started' | 'unconfirmed' | 'settled';
  candidateResults: 'none' | 'partial' | 'complete';
  catalog: 'unchanged' | 'write-may-have-completed' | 'replaced';
}
export interface PluginScanJobResult {
  partial: PluginScanPartialEffects;
  discoveredCandidates?: number;
  processedCandidates: number;
  pluginCount: number;
  quarantined: number;
}
export interface PluginScanRuntime {
  scannerAvailable?(executable: string): Promise<boolean>;
  findCandidates?(roots: string[]): Promise<string[]>;
  scanModule?(executable: string, pluginPath: string, timeoutMs: number): Promise<PluginScannerOutput[]>;
  /** Model the production atomic writer: resolve after replacement, or reject while the previous catalog remains canonical. */
  persistCatalog?(catalogPath: string, payload: string): Promise<void>;
}

export function standardPluginRoots(platform: NodeJS.Platform = process.platform, home = homedir(), environment: NodeJS.ProcessEnv = process.env): string[] {
  const values = platform === 'darwin'
    ? [
        '/Library/Audio/Plug-Ins/VST3',
        join(home, 'Library', 'Audio', 'Plug-Ins', 'VST3'),
        '/Library/Audio/Plug-Ins/CLAP',
        join(home, 'Library', 'Audio', 'Plug-Ins', 'CLAP'),
      ]
    : platform === 'win32'
      ? [
          join(environment.ProgramFiles ?? 'C:\\Program Files', 'Common Files', 'VST3'),
          join(environment.LOCALAPPDATA ?? '', 'Programs', 'Common', 'VST3'),
          join(environment.ProgramFiles ?? 'C:\\Program Files', 'Common Files', 'CLAP'),
          join(environment.LOCALAPPDATA ?? '', 'Programs', 'Common', 'CLAP'),
        ]
      : [];
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

async function exists(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
export async function findPluginCandidates(roots: string[], platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const output: string[] = []; const pending = roots.map((value) => resolve(value)); let visited = 0;
  while (pending.length) {
    const folder = pending.pop()!; if (!(await exists(folder))) continue; let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) { if (++visited > 100_000) throw new Error('Plug-in scan exceeded the filesystem entry limit.'); if (entry.isSymbolicLink()) continue; const path = join(folder, entry.name); const extension = extname(entry.name).toLowerCase(); if (extension === '.vst3' && entry.isDirectory()) output.push(path); else if (extension === '.clap' && (entry.isFile() || (platform === 'darwin' && entry.isDirectory()))) output.push(path); else if (entry.isDirectory()) pending.push(path); }
  }
  return [...new Set(output)].sort();
}

export async function pluginBinaryFor(path: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const info = await stat(path); if (info.isFile()) {
    if (platform === 'darwin' && (info.mode & 0o111) === 0) throw new Error('CLAP module is not executable on macOS.');
    return path;
  }
  if (platform === 'darwin') {
    const contents = join(path, 'Contents', 'MacOS');
    if (await exists(contents)) {
      const files = (await readdir(contents, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((left, right) => left.name.localeCompare(right.name));
      const expectedName = basename(path, extname(path));
      const exact = files.find((entry) => entry.name === expectedName);
      const module = exact ?? (files.length === 1 ? files[0] : undefined);
      if (module) {
        const modulePath = join(contents, module.name);
        await access(modulePath, constants.X_OK).catch(() => { throw new Error('VST3/CLAP bundle module is not executable on macOS.'); });
        return modulePath;
      }
      if (files.length > 1) throw new Error('VST3/CLAP bundle has ambiguous macOS modules and no bundle-named executable.');
    }
    throw new Error('VST3/CLAP bundle has no macOS module.');
  }
  if (platform === 'win32') {
    const architecture = join(path, 'Contents', 'x86_64-win'); if (await exists(architecture)) { const files = await readdir(architecture); const module = files.find((name) => ['.vst3', '.dll'].includes(extname(name).toLowerCase())); if (module) return join(architecture, module); }
    throw new Error('VST3 bundle has no x64 Windows module.');
  }
  throw new Error(`VST3/CLAP bundle modules are unsupported on ${platform}.`);
}

function runScanner(executable: string, pluginPath: string, timeoutMs: number): Promise<PluginScannerOutput[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['--scan', pluginPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let errors = ''; let settled = false;
    const finish = (error?: Error, value?: PluginScannerOutput[]): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolvePromise(value ?? []); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Scanner timed out after ${timeoutMs} ms.`)); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 2_000_000) { child.kill(); finish(new Error('Scanner output exceeded 2 MB.')); } }); child.stderr.on('data', (chunk: string) => { errors += chunk; if (errors.length > 100_000) errors = errors.slice(-100_000); });
    child.once('error', (error) => finish(error)); child.once('exit', (code) => { if (code !== 0) return finish(new Error(`Scanner exited with ${code}: ${errors.trim() || 'no diagnostic'}`)); try { const parsed = JSON.parse(output) as unknown; const values = Array.isArray(parsed) ? parsed : [parsed]; finish(undefined, values as PluginScannerOutput[]); } catch (error) { finish(new Error(`Scanner returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`)); } });
  });
}

export class PluginManager {
  private plugins = new Map<string, PluginDescriptor>(); private quarantine: QuarantineEntry[] = [];
  private readonly scanRuntime: Required<PluginScanRuntime>;
  constructor(private readonly catalogPath: string, private readonly scannerExecutable: string | undefined, private readonly projects: ProjectService, private readonly authority: AuthorityManager, runtime: PluginScanRuntime = {}) {
    this.scanRuntime = {
      scannerAvailable: runtime.scannerAvailable ?? exists,
      findCandidates: runtime.findCandidates ?? ((roots) => findPluginCandidates(roots)),
      scanModule: runtime.scanModule ?? runScanner,
      persistCatalog: runtime.persistCatalog ?? ((path, payload) => atomicWriteFile(path, payload)),
    };
  }

  async initialize(): Promise<void> { try { const value = JSON.parse(await readFile(this.catalogPath, 'utf8')) as PluginCatalogFile; if (value.version === 1) { this.plugins = new Map(value.plugins.map((plugin) => [plugin.id, plugin])); this.quarantine = value.quarantine ?? []; } } catch { /* empty catalog */ } this.projects.setPlugins([...this.plugins.values()]); }
  list(): PluginDescriptor[] { return [...this.plugins.values()].map((value) => structuredClone(value)); }

  scan(roots: string[] = standardPluginRoots(), actor: Actor = HUMAN_ACTOR): { jobId: Id } {
    const jobId = createId('plugin-scan'); const timestamp = nowIso(); const result: PluginScanJobResult = { partial: { discovery: 'not-started', nativeHelper: 'not-started', candidateResults: 'none', catalog: 'unchanged' }, processedCandidates: 0, pluginCount: 0, quarantined: 0 }; this.projects.upsertJob({ id: jobId, ownerActorId: actor.id, projectId: this.projects.getActiveProjectId(), kind: 'plugin-scan', status: 'queued', progress: 0, message: 'Plug-in scan queued.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, result }); void this.runScan(jobId, roots, actor); return { jobId };
  }

  private async runScan(jobId: Id, roots: string[], actor: Actor): Promise<void> {
    const partial: PluginScanPartialEffects = { discovery: 'not-started', nativeHelper: 'not-started', candidateResults: 'none', catalog: 'unchanged' };
    let discoveredCandidates: number | undefined; let processedCandidates = 0; const found = new Map<string, PluginDescriptor>(); const quarantine: QuarantineEntry[] = [];
    const result = (): PluginScanJobResult => ({ partial: { ...partial }, ...(discoveredCandidates === undefined ? {} : { discoveredCandidates }), processedCandidates, pluginCount: found.size, quarantined: quarantine.length });
    const retainCancellation = (): boolean => {
      const current = this.projects.getJob<PluginScanJobResult>(jobId); if (current?.status !== 'cancelled') return false;
      const message = partial.catalog === 'replaced'
        ? 'Cancelled while finalizing the scan. The complete replacement catalog remains available.'
        : partial.catalog === 'write-may-have-completed'
          ? 'Cancelled while the atomic catalog write was running. Its retained effect is not yet confirmed.'
          : partial.candidateResults === 'none' && discoveredCandidates === 0
            ? 'Cancelled after discovery found no candidates. The existing catalog remains available.'
            : 'Cancelled during plug-in scanning. Candidate results were not published and the existing catalog remains available.';
      this.projects.upsertJob({ ...current, cancellable: false, message, updatedAt: nowIso(), result: result() }); return true;
    };
    const publishProgress = (message: string, progress: number): void => {
      const current = this.projects.getJob<PluginScanJobResult>(jobId); if (!current || current.status === 'cancelled') return;
      this.projects.upsertJob({ ...current, status: 'running', progress, message, updatedAt: nowIso(), result: result() });
    };
    try {
      if (actor.kind === 'agent') for (const root of roots) { const decision = await this.authority.file(root, 'read', true); if (!decision.allowed) throw new Error(decision.reason); }
      if (retainCancellation()) return;
      if (!this.scannerExecutable || !(await this.scanRuntime.scannerAvailable(this.scannerExecutable))) throw new Error('The isolated native plug-in scanner is not built. Existing catalog remains available.');
      if (retainCancellation()) return;
      partial.discovery = 'may-have-completed'; publishProgress('Discovering VST3 and CLAP modules…', 0.01);
      const candidates = await this.scanRuntime.findCandidates(roots); discoveredCandidates = candidates.length; partial.discovery = 'completed';
      if (retainCancellation()) return;
      for (let index = 0; index < candidates.length; index += 1) {
        const path = candidates[index]; if (retainCancellation()) return; publishProgress(`Scanning ${basename(path)} (${index + 1}/${candidates.length})`, 0.03 + 0.94 * index / Math.max(1, candidates.length));
        let hash: string | undefined; let helperStarted = false; try { const binary = await pluginBinaryFor(path); hash = (await sha256File(binary)).sha256; if (retainCancellation()) return; const format = extname(path).toLowerCase() === '.clap' ? 'clap' as const : 'vst3' as const; helperStarted = true; partial.nativeHelper = 'unconfirmed'; publishProgress(`Scanning ${basename(path)} (${index + 1}/${candidates.length})`, 0.03 + 0.94 * index / Math.max(1, candidates.length)); const outputs = await this.scanRuntime.scanModule(this.scannerExecutable, path, 15_000); partial.nativeHelper = 'settled'; if (!outputs.length) throw new Error('Module reported no plug-in classes.');
          for (const output of outputs) { if (!output.pluginUid || !output.name) throw new Error('Module metadata has no stable class ID or name.'); const id = `${format}:${output.pluginUid}`; found.set(id, { id, format, name: output.name.slice(0, 500), vendor: (output.vendor ?? 'Unknown').slice(0, 500), version: (output.version ?? '0').slice(0, 100), path, sha256: hash, categories: (output.categories ?? []).slice(0, 100), instrument: Boolean(output.instrument), quarantined: false, parameters: (output.parameters ?? []).slice(0, 100_000) }); }
        } catch (error) { if (helperStarted) partial.nativeHelper = 'settled'; quarantine.push({ path, hash, reason: error instanceof Error ? error.message : String(error), occurredAt: nowIso() }); }
        processedCandidates += 1; partial.candidateResults = processedCandidates === candidates.length ? 'complete' : 'partial';
        if (retainCancellation()) return;
      }
      if (retainCancellation()) return;
      partial.catalog = 'write-may-have-completed'; publishProgress('Persisting replacement plug-in catalog…', 0.98); await this.persist(found, quarantine);
      this.plugins = found; this.quarantine = quarantine; partial.catalog = 'replaced'; this.projects.setPlugins(this.list());
      if (retainCancellation()) return;
      const current = this.projects.getJob<PluginScanJobResult>(jobId)!; this.projects.upsertJob({ ...current, status: 'completed', progress: 1, cancellable: false, message: `Found ${found.size} plug-in class${found.size === 1 ? '' : 'es'}; quarantined ${quarantine.length}.`, updatedAt: nowIso(), result: result() });
    } catch (error) { if (partial.catalog === 'write-may-have-completed') partial.catalog = 'unchanged'; if (retainCancellation()) return; const current = this.projects.getJob<PluginScanJobResult>(jobId)!; this.projects.upsertJob({ ...current, status: 'failed', cancellable: false, message: error instanceof Error ? error.message : String(error), updatedAt: nowIso(), result: result(), error: { code: 'plugin-scan-failed', message: error instanceof Error ? error.message : String(error), retryable: true } }); }
  }

  async instantiate(projectId: Id, trackId: Id, pluginId: string, actor: Actor = HUMAN_ACTOR, authorityOverride = false): Promise<{ deviceId?: Id; status: string; message?: string }> {
    const plugin = this.plugins.get(pluginId); if (!plugin || plugin.quarantined) return { status: 'conflict', message: 'Plug-in is missing or quarantined.' }; if (actor.kind === 'agent' && !authorityOverride) { const decision = this.authority.plugin(pluginId); if (!decision.allowed) return { status: 'approval-required', message: decision.reason }; }
    const device: Device = { ...entityBase('device', actor), trackId, format: plugin.format, pluginId: plugin.id, pluginVersion: plugin.version, pluginHash: plugin.sha256, name: plugin.name, vendor: plugin.vendor, bypassed: false, degraded: false, latencySamples: 0, parameters: Object.fromEntries(plugin.parameters.map((parameter) => [parameter.id, structuredClone(parameter)])) };
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('plugin-add'), projectId, actor, label: `Add ${plugin.name}`, createdAt: nowIso(), operations: [{ kind: 'device.add', device }], checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); return { deviceId: result.status === 'committed' ? device.id : undefined, status: result.status, message: result.message };
  }

  async markCrashed(projectId: Id, deviceId: Id, diagnostic: string): Promise<void> { const project = this.projects.getProject(projectId); const device = project?.devices[deviceId]; if (!project || !device) return; const actor: Actor = { id: 'system-plugin-bridge', kind: 'system', name: 'Plug-in Bridge', color: '#ef4444' }; const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('plugin-crash'), projectId, actor, label: `${device.name} bridge crashed`, createdAt: nowIso(), operations: [{ kind: 'device.update', deviceId, changes: { bypassed: true, degraded: true }, expectedRevision: device.revision }], checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); if (result.status === 'committed') this.projects.upsertJob({ id: createId('plugin-host'), ownerActorId: actor.id, projectId, kind: 'plugin-host', status: 'failed', progress: 1, message: `${device.name} was bypassed; its state remains in the project.`, createdAt: nowIso(), updatedAt: nowIso(), cancellable: false, error: { code: 'plugin-bridge-crash', message: diagnostic.slice(0, 2_000), retryable: true } }); }

  async reconcileMissing(projectId: Id): Promise<number> { const project = this.projects.getProject(projectId); if (!project) return 0; const actor: Actor = { id: 'system-plugin-catalog', kind: 'system', name: 'Plug-in Catalog', color: '#f59e0b' }; const operations = Object.values(project.devices).filter((device) => device.format !== 'builtin' && device.pluginId && !this.plugins.has(device.pluginId) && !device.degraded).map((device) => ({ kind: 'device.update' as const, deviceId: device.id, changes: { bypassed: true, degraded: true }, expectedRevision: device.revision })); if (!operations.length) return 0; const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('missing-plugins'), projectId, actor, label: 'Preserve missing plug-ins as bypassed placeholders', createdAt: nowIso(), operations, checkpointPolicy: 'none' }; const result = await this.projects.apply(tx, actor); return result.status === 'committed' ? operations.length : 0; }

  private async persist(plugins = this.plugins, quarantine = this.quarantine): Promise<void> { const payload: PluginCatalogFile = { version: 1, scannedAt: nowIso(), plugins: [...plugins.values()].map((value) => structuredClone(value)), quarantine: quarantine.map((value) => structuredClone(value)) }; await this.scanRuntime.persistCatalog(this.catalogPath, `${JSON.stringify(payload, null, 2)}\n`); }
}
