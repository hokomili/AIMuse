import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AuthorityDecision, AuthorityPolicy, AuthorityUsage, GenerationProvider } from '@aimuse/core';
import { canonicalizePath } from './persistence';

const PolicySchema = z.object({
  version: z.literal(1), id: z.string().min(1).max(240), issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), maxRuntimeMinutes: z.number().int().min(1).max(60 * 24 * 30),
  budget: z.object({ currency: z.string().min(1).max(10), maxSpendMinor: z.number().int().nonnegative(), maxGenerationRequests: z.number().int().nonnegative(), maxUnknownCostRequests: z.number().int().nonnegative() }).strict(),
  providers: z.partialRecord(z.enum(['elevenlabs', 'stability', 'lyria']), z.object({ models: z.array(z.string().min(1).max(300)).max(100), enabled: z.boolean() }).strict()),
  readRoots: z.array(z.string().min(1).max(32_000)).max(100), writeRoots: z.array(z.string().min(1).max(32_000)).max(100), overwritePaths: z.array(z.string().min(1).max(32_000)).max(10_000), pluginAllowlist: z.array(z.string().min(1).max(500)).max(10_000),
  allowMicrophone: z.boolean(), allowMidiInput: z.boolean(), allowMidiOutput: z.boolean(),
}).strict();

function normalized(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value; }
function within(root: string, path: string): boolean { const value = relative(root, path); return value === '' || (!value.startsWith('..') && !isAbsolute(value)); }

export class AuthorityManager {
  private policy?: AuthorityPolicy;
  private usage?: AuthorityUsage;
  private readRoots: string[] = [];
  private writeRoots: string[] = [];
  private overwritePaths = new Set<string>();

  async install(value: unknown): Promise<{ installed: boolean; reason?: string }> {
    try {
      const parsed = PolicySchema.parse(value) as AuthorityPolicy;
      if (new Date(parsed.expiresAt).getTime() <= Date.now()) return { installed: false, reason: 'Authority policy has expired.' };
      this.policy = structuredClone(parsed);
      this.usage = { spentMinor: 0, generationRequests: 0, unknownCostRequests: 0, startedAt: new Date().toISOString() };
      this.readRoots = await Promise.all(parsed.readRoots.map(canonicalizePath)).then((paths) => paths.map(normalized));
      this.writeRoots = await Promise.all(parsed.writeRoots.map(canonicalizePath)).then((paths) => paths.map(normalized));
      this.overwritePaths = new Set((await Promise.all(parsed.overwritePaths.map(canonicalizePath))).map(normalized));
      return { installed: true };
    } catch (error) {
      return { installed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  clear(): void { this.policy = undefined; this.usage = undefined; this.readRoots = []; this.writeRoots = []; this.overwritePaths.clear(); }

  snapshot(): { policy?: AuthorityPolicy; usage?: AuthorityUsage } { return { policy: this.policy ? structuredClone(this.policy) : undefined, usage: this.usage ? structuredClone(this.usage) : undefined }; }

  private active(): AuthorityDecision {
    if (!this.policy || !this.usage) return { allowed: false, reason: 'No process-lifetime authority policy is installed.' };
    if (Date.now() >= new Date(this.policy.expiresAt).getTime()) return { allowed: false, reason: 'Authority policy expired.' };
    if (Date.now() - new Date(this.usage.startedAt).getTime() > this.policy.maxRuntimeMinutes * 60_000) return { allowed: false, reason: 'Authority runtime limit was reached.' };
    return { allowed: true };
  }

  async file(path: string, mode: 'read' | 'write', existsAlready: boolean): Promise<AuthorityDecision> {
    const active = this.active(); if (!active.allowed) return { ...active, approvalKind: mode === 'read' ? 'file-read' : 'file-write' };
    const target = normalized(await canonicalizePath(path));
    const roots = mode === 'read' ? this.readRoots : this.writeRoots;
    if (!roots.some((root) => within(root, target))) return { allowed: false, reason: `Path is outside approved ${mode} roots.`, approvalKind: mode === 'read' ? 'file-read' : 'file-write' };
    if (mode === 'write' && existsAlready && !this.overwritePaths.has(target)) return { allowed: false, reason: 'Existing destination was not explicitly approved for overwrite.', approvalKind: 'overwrite' };
    return { allowed: true };
  }

  plugin(pluginId: string): AuthorityDecision {
    const active = this.active(); if (!active.allowed) return { ...active, approvalKind: 'plugin' };
    if (!this.policy!.pluginAllowlist.includes(pluginId)) return { allowed: false, reason: 'Plug-in is outside the authority allowlist.', approvalKind: 'plugin' };
    return { allowed: true };
  }

  recording(kind: 'microphone' | 'midi-input' | 'midi-output'): AuthorityDecision {
    const active = this.active(); if (!active.allowed) return { ...active, approvalKind: 'recording' };
    const allowed = kind === 'microphone' ? this.policy!.allowMicrophone : kind === 'midi-input' ? this.policy!.allowMidiInput : this.policy!.allowMidiOutput;
    return allowed ? { allowed: true } : { allowed: false, reason: `${kind} is not authorized.`, approvalKind: 'recording' };
  }

  generation(provider: GenerationProvider, model: string, estimatedCostMinor?: number): AuthorityDecision {
    const active = this.active(); if (!active.allowed) return { ...active, approvalKind: 'generation' };
    const settings = this.policy!.providers[provider];
    if (!settings?.enabled || !settings.models.includes(model)) return { allowed: false, reason: 'Provider or model is not authorized.', approvalKind: 'generation' };
    if (this.usage!.generationRequests >= this.policy!.budget.maxGenerationRequests) return { allowed: false, reason: 'Generation request limit reached.', approvalKind: 'generation' };
    if (estimatedCostMinor === undefined && this.usage!.unknownCostRequests >= this.policy!.budget.maxUnknownCostRequests) return { allowed: false, reason: 'Unknown-cost request limit reached.', approvalKind: 'unknown-cost' };
    if (estimatedCostMinor !== undefined && this.usage!.spentMinor + estimatedCostMinor > this.policy!.budget.maxSpendMinor) return { allowed: false, reason: 'Generation spend limit would be exceeded.', approvalKind: 'generation' };
    return { allowed: true };
  }

  consumeGeneration(estimatedCostMinor?: number): void {
    if (!this.usage) return;
    this.usage.generationRequests += 1;
    if (estimatedCostMinor === undefined) this.usage.unknownCostRequests += 1;
    else this.usage.spentMinor += estimatedCostMinor;
  }
}
