import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { Actor, AuthorityPolicy } from '@aimuse/core';
import type { EngineStatus } from '../common/contracts';
import { AudioEngineController } from './audio-engine';
import { AuthorityManager } from './authority-manager';
import { LocalCredentialStore, ProviderCredentialStore } from './credentials';
import { ExportManager } from './export-manager';
import { GenerationManager } from './generation-manager';
import { RecoveryJournal } from './journal';
import { McpHost } from './mcp-host';
import { MediaManager } from './media-manager';
import { PluginManager } from './plugin-manager';
import { ProjectService } from './project-service';
import { TransactionTraceStore } from './trace-store';

export interface EngineRuntimeOptions { userDataPath: string; profileId: string; appVersion: string; nativeAudioBinary?: string; pluginScannerBinary?: string; playbackRenderWorker?: string; authorityPolicyPath?: string; mode: 'headless' | 'interactive' }
const ENGINE_ACTOR: Actor = { id: 'system-engine', kind: 'system', name: 'AIMuse Engine', color: '#64748b' };

/** The single canonical runtime used by headless MCP and the attachable editor. */
export class EngineRuntime {
  readonly authority: AuthorityManager; readonly audio: AudioEngineController; readonly projects: ProjectService; readonly providerCredentials: ProviderCredentialStore; readonly media: MediaManager; readonly plugins: PluginManager; readonly generation: GenerationManager; readonly exports: ExportManager; readonly mcp: McpHost;
  private compactTimer?: NodeJS.Timeout; private started = false; private uiAttached = false;
  constructor(private readonly options: EngineRuntimeOptions) {
    const data = options.userDataPath; this.authority = new AuthorityManager(); this.audio = new AudioEngineController(options.nativeAudioBinary, options.appVersion, join(data, 'managed', 'playback'), options.playbackRenderWorker); this.projects = new ProjectService({ appVersion: options.appVersion, checkpointRoot: join(data, 'managed', 'checkpoints'), journal: new RecoveryJournal(join(data, 'recovery')), trace: new TransactionTraceStore(join(data, 'traces')), audio: this.audio }); this.providerCredentials = new ProviderCredentialStore(join(data, 'credentials', 'providers.json'), safeStorage); this.media = new MediaManager(join(data, 'managed'), this.projects, this.authority); this.plugins = new PluginManager(join(data, 'plugins', 'catalog.json'), options.pluginScannerBinary, this.projects, this.authority); this.generation = new GenerationManager(join(data, 'managed', 'generation'), this.projects, this.authority, this.providerCredentials); this.exports = new ExportManager(this.projects, this.audio, this.authority); this.mcp = new McpHost({ appVersion: options.appVersion, profileId: options.profileId, portSettingsPath: join(data, 'mcp-port.json'), cacheRoot: join(data, 'managed'), projects: this.projects, audio: this.audio, authority: this.authority, media: this.media, plugins: this.plugins, generation: this.generation, exports: this.exports });
  }
  async start(): Promise<void> { if (this.started) return; this.started = true; if (this.options.authorityPolicyPath) { const raw = JSON.parse(await readFile(this.options.authorityPolicyPath, 'utf8')) as AuthorityPolicy; const installed = await this.authority.install(raw); if (!installed.installed) throw new Error(`Authority policy was rejected: ${installed.reason}`); } await this.audio.start(); await this.projects.initialize(); await this.plugins.initialize(); this.compactTimer = setInterval(() => void this.projects.compactRecovery(), 60_000); this.compactTimer.unref(); try { const token = await new LocalCredentialStore(join(this.options.userDataPath, 'credentials', 'mcp-token.json'), safeStorage).loadOrCreateToken(); const info = await this.mcp.start(token); this.projects.setMcpInfo({ running: true, ...info }); } catch (error) { this.projects.setMcpInfo({ running: false, tokenHint: error instanceof Error ? error.message : String(error) }); } }
  async stop(): Promise<void> { if (!this.started) return; this.started = false; if (this.compactTimer) clearInterval(this.compactTimer); this.compactTimer = undefined; for (const project of this.projects.getProjects()) if (project.projectPath && project.dirty) await this.projects.save(project.id, undefined, ENGINE_ACTOR).catch(() => undefined); await this.mcp.stop(); this.projects.setMcpInfo({ running: false }); await this.audio.stop(); }
  setUiAttached(attached: boolean): void { this.uiAttached = attached; }
  status(): EngineStatus { return { running: this.started, uiAttached: this.uiAttached, startsAtLogin: false, startAtLoginSupported: process.platform === 'win32', mode: this.options.mode, audio: this.audio.status() }; }
}
