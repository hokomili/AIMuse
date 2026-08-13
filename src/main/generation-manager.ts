import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseFile } from 'music-metadata';
import {
  HUMAN_ACTOR, createId, createTrack, entityBase, nowIso,
  type Actor, type AsyncJob, type GenerationProvenance, type Id, type MediaAsset, type ProjectOperation, type ProjectTransaction,
} from '@aimuse/core';
import type { ApplyTransactionResponse } from '../common/contracts';
import type { GenerationCandidate, GenerationJobResult, GenerationRequest, ProviderCapabilities } from '../common/generation';
import { AuthorityManager } from './authority-manager';
import { atomicWriteFile } from './persistence';
import { ProjectService } from './project-service';

export interface ProviderCredentials {
  get(provider: GenerationRequest['provider']): Promise<string | undefined>;
  set(provider: GenerationRequest['provider'], value: string): Promise<void>;
  status(): Promise<Record<GenerationRequest['provider'], boolean>>;
}

interface RawGeneration { bytes: Buffer; mimeType: string; extension: string; requestId?: string; providerMetadata: Record<string, unknown>; costMinor?: number; currency?: string }
type Fetch = typeof globalThis.fetch;
interface GenerationExecution {
  controller: AbortController;
  phase: 'preparing' | 'provider' | 'candidate-cache';
  submittedRequests: number;
  fulfilledRequests: number;
  lateFulfilledRequests: number;
  candidates: GenerationCandidate[];
}

class ProviderError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly ambiguousCharge = false) { super(message); this.name = 'ProviderError'; }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); const abort = (): void => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); }
async function errorText(response: Response): Promise<string> { const text = await response.text().catch(() => ''); return text.slice(0, 4_000) || `${response.status} ${response.statusText}`; }
function providerFailure(provider: string, response: Response, body: string, submitted: boolean): ProviderError { const moderation = response.status === 403 || response.status === 422; const rate = response.status === 429; return new ProviderError(`${provider}: ${body}`, moderation ? 'moderated' : rate ? 'rate-limited' : `http-${response.status}`, rate || response.status >= 500, submitted && response.status >= 500); }
function redactCredential(message: string, credential?: string): string { return credential ? message.split(credential).join('[provider credential redacted]') : message; }
function outputFor(request: GenerationRequest): { extension: string; mimeType: string } { if (request.outputFormat === 'wav' || request.outputFormat === 'pcm') return { extension: 'wav', mimeType: 'audio/wav' }; if (request.outputFormat === 'opus') return { extension: 'opus', mimeType: 'audio/opus' }; return { extension: 'mp3', mimeType: 'audio/mpeg' }; }

export function defaultCapabilities(configured: Record<GenerationRequest['provider'], boolean>, lyriaEnabled: boolean): ProviderCapabilities[] {
  return [
    { provider: 'elevenlabs', configured: configured.elevenlabs, experimental: false, models: [
      { id: 'music_v2', label: 'Eleven Music v2', capabilities: ['text-to-music', 'vocals', 'custom-lyrics', 'section-plan', 'section-replace'], minDurationMs: 3_000, maxDurationMs: 600_000, formats: ['mp3', 'pcm'], costKnownBeforeRequest: false },
      { id: 'music_v1', label: 'Eleven Music v1', capabilities: ['text-to-music', 'vocals', 'custom-lyrics', 'section-plan'], minDurationMs: 3_000, maxDurationMs: 600_000, formats: ['mp3', 'pcm'], costKnownBeforeRequest: false },
      { id: 'eleven_text_to_sound_v2', label: 'Eleven Sound Effects v2', capabilities: ['text-to-sfx', 'seamless-loop'], minDurationMs: 500, maxDurationMs: 30_000, formats: ['mp3', 'pcm'], costKnownBeforeRequest: true },
    ] },
    { provider: 'stability', configured: configured.stability, experimental: false, models: [
      { id: 'stable-audio-3', label: 'Stable Audio 3.0', capabilities: ['text-to-music', 'text-to-sfx', 'audio-to-audio'], minDurationMs: 1_000, maxDurationMs: 380_000, formats: ['wav', 'mp3'], costKnownBeforeRequest: true },
      { id: 'stable-audio-2.5', label: 'Stable Audio 2.5', capabilities: ['text-to-music', 'text-to-sfx', 'audio-to-audio'], minDurationMs: 1_000, maxDurationMs: 190_000, formats: ['wav', 'mp3'], costKnownBeforeRequest: true },
    ] },
    { provider: 'lyria', configured: configured.lyria, experimental: true, unavailableReason: lyriaEnabled ? undefined : 'Lyria 3 preview is disabled until the user opts in.', models: [
      { id: 'lyria-3-clip-preview', label: 'Lyria 3 Clip (Preview)', capabilities: ['text-to-music', 'vocals'], minDurationMs: 30_000, maxDurationMs: 30_000, formats: ['mp3'], costKnownBeforeRequest: false },
      { id: 'lyria-3-pro-preview', label: 'Lyria 3 Pro (Preview)', capabilities: ['text-to-music', 'vocals'], minDurationMs: 30_000, maxDurationMs: 240_000, formats: ['wav', 'mp3'], costKnownBeforeRequest: false },
    ] },
  ];
}

function validateRequest(request: GenerationRequest, matrices: ProviderCapabilities[], projectAssetIds: Set<Id>): void {
  if (!request.prompt.trim() || request.prompt.length > 10_000) throw new Error('Generation prompt must contain 1–10,000 characters.'); if (!Number.isInteger(request.resultCount) || request.resultCount < 1 || request.resultCount > 4) throw new Error('Generation result count must be 1–4.');
  const forbidden = Object.keys(request.providerOptions).find((key) => /voice|speaker|clone|finetune/i.test(key)); if (forbidden) throw new Error(`Voice-cloning or speaker-selection option is not exposed by AIMuse: ${forbidden}`);
  const provider = matrices.find((value) => value.provider === request.provider); const model = provider?.models.find((value) => value.id === request.model); if (!provider || !model || provider.unavailableReason) throw new Error(provider?.unavailableReason ?? 'Provider model is unavailable.');
  const needed = request.kind === 'sfx' ? 'text-to-sfx' : request.kind === 'audio-to-audio' ? 'audio-to-audio' : request.kind === 'section-replace' ? 'section-replace' : 'text-to-music'; if (!model.capabilities.includes(needed)) throw new Error(`${request.provider}/${request.model} does not support ${request.kind}.`);
  if (request.lyrics && !model.capabilities.includes('custom-lyrics')) throw new Error(`${request.provider}/${request.model} has no structured custom-lyrics input; AIMuse will not merge lyrics into the prompt silently.`); if (request.seamlessLoop && !model.capabilities.includes('seamless-loop')) throw new Error(`${request.provider}/${request.model} does not support explicit seamless loops.`);
  if (request.durationMs < model.minDurationMs || request.durationMs > model.maxDurationMs || (request.model === 'lyria-3-clip-preview' && request.durationMs !== 30_000)) throw new Error(`Duration is outside ${request.model}'s supported range.`);
  if (!model.formats.includes(request.outputFormat)) throw new Error(`${request.model} cannot return ${request.outputFormat}.`); if (request.referenceAssetIds.some((id) => !projectAssetIds.has(id))) throw new Error('Generation references media outside the project.');
  if (request.kind === 'audio-to-audio' && request.referenceAssetIds.length !== 1) throw new Error('Audio-to-audio requires exactly one reference asset.'); if (!['original', 'licensed', 'owned-reference'].includes(request.rightsDeclaration)) throw new Error('A rights declaration is required.');
}

export class GenerationManager {
  private readonly executions = new Map<Id, GenerationExecution>(); private readonly actors = new Map<Id, Actor>(); private lyriaEnabled = false;
  constructor(private readonly root: string, private readonly projects: ProjectService, private readonly authority: AuthorityManager, private readonly credentials: ProviderCredentials, private readonly fetcher: Fetch = globalThis.fetch) {
    projects.on('approval-resolved', (job: AsyncJob<GenerationJobResult>, decision: string) => { if (job.kind === 'generation' && decision !== 'deny' && this.actors.has(job.id)) void this.run(job.id, this.actors.get(job.id)!, true); });
  }
  setLyriaOptIn(enabled: boolean): void { this.lyriaEnabled = enabled; }
  async capabilities(): Promise<ProviderCapabilities[]> { return defaultCapabilities(await this.credentials.status(), this.lyriaEnabled); }
  async setCredential(provider: GenerationRequest['provider'], value: string): Promise<void> { await this.credentials.set(provider, value); }

  async start(request: GenerationRequest, actor: Actor = HUMAN_ACTOR, approvalReservationId?: Id): Promise<{ jobId: Id }> {
    const project = this.projects.getProject(request.projectId); if (!project) throw new Error('Project is not open.'); validateRequest(request, await this.capabilities(), new Set(Object.keys(project.assets)));
    const credential = await this.credentials.get(request.provider); if (!credential) throw new Error(`${request.provider} credentials are not configured.`);
    const jobId = createId('generation-job'); if (approvalReservationId && !this.projects.bindApprovalReservation(approvalReservationId, jobId, actor.id)) throw new Error('Approval reservation is no longer available.'); const timestamp = nowIso(); const job: AsyncJob<GenerationJobResult> = { id: jobId, ownerActorId: actor.id, projectId: request.projectId, kind: 'generation', status: 'queued', progress: 0, message: 'Generation queued.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, result: { request: structuredClone(request), candidates: [], acceptedCandidateIds: [], rejectedCandidateIds: [] } };
    if (actor.kind === 'agent') { const decision = this.authority.generation(request.provider, request.model, request.estimatedCostMinor); if (!decision.allowed) { job.status = 'waiting-for-user'; job.message = decision.reason ?? 'Generation requires approval.'; job.approval = { kind: decision.approvalKind ?? 'generation', summary: `${actor.name} requests ${request.resultCount} ${request.provider} generation${request.resultCount === 1 ? '' : 's'}.`, request: { provider: request.provider, model: request.model, durationMs: request.durationMs, resultCount: request.resultCount, estimatedCostMinor: request.estimatedCostMinor, currency: request.currency }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }; } }
    this.actors.set(jobId, structuredClone(actor)); this.projects.upsertJob(job); if (job.status === 'queued') void this.run(jobId, actor, false); return { jobId };
  }

  async run(jobId: Id, actor: Actor, authorityOverride: boolean): Promise<void> {
    const initial = this.projects.getJob<GenerationJobResult>(jobId); if (!initial?.result || !['queued', 'waiting-for-user'].includes(initial.status)) return; const request = initial.result.request; const credential = await this.credentials.get(request.provider);
    const runnable = this.projects.getJob<GenerationJobResult>(jobId); if (!runnable?.result || !['queued', 'waiting-for-user'].includes(runnable.status)) return; if (!credential) return this.fail(runnable, new ProviderError('Provider credential is unavailable.', 'credential', false));
    const controller = new AbortController(); const candidates = [...runnable.result.candidates]; const execution: GenerationExecution = { controller, phase: 'preparing', submittedRequests: 0, fulfilledRequests: 0, lateFulfilledRequests: 0, candidates }; this.executions.set(jobId, execution); this.projects.upsertJob({ ...runnable, status: 'running', progress: 0.02, message: `Generating with ${request.provider}/${request.model}…`, updatedAt: nowIso(), approval: undefined });
    try {
      await mkdir(join(this.root, request.projectId), { recursive: true });
      for (let index = candidates.length; index < request.resultCount; index += 1) {
        execution.phase = 'preparing'; if (this.isCancelled(jobId, controller.signal)) throw new DOMException('Cancelled', 'AbortError'); if (actor.kind === 'agent' && !authorityOverride) { const decision = this.authority.generation(request.provider, request.model, request.estimatedCostMinor); if (!decision.allowed) throw new ProviderError(decision.reason ?? 'Authority exhausted.', 'authority-exhausted', false); }
        execution.phase = 'provider'; let submitted = false; const raw = await this.generateOne(request, credential, controller.signal, () => { if (this.isCancelled(jobId, controller.signal)) throw new DOMException('Cancelled', 'AbortError'); if (!submitted) { submitted = true; execution.submittedRequests += 1; } });
        const fulfilledLate = this.isCancelled(jobId, controller.signal); execution.fulfilledRequests += 1; if (fulfilledLate) execution.lateFulfilledRequests += 1; if (actor.kind === 'agent' && !authorityOverride) this.authority.consumeGeneration(request.estimatedCostMinor); if (fulfilledLate) throw new DOMException('Cancelled', 'AbortError');
        execution.phase = 'candidate-cache'; const candidate = await this.persistCandidate(request, raw, actor); candidates.push(candidate); if (this.isCancelled(jobId, controller.signal)) { this.settleCancellation(jobId, execution, 'retained'); return; }
        execution.phase = 'preparing'; const current = this.projects.getJob<GenerationJobResult>(jobId); if (!current?.result || current.status !== 'running') return; this.projects.upsertJob({ ...current, progress: 0.05 + 0.9 * candidates.length / request.resultCount, message: `Generated candidate ${candidates.length} of ${request.resultCount}.`, updatedAt: nowIso(), result: { ...current.result, candidates } });
      }
      const current = this.projects.getJob<GenerationJobResult>(jobId); if (!current?.result) return; if (current.status === 'cancelled') { this.settleCancellation(jobId, execution); return; } if (current.status !== 'running') return; this.projects.upsertJob({ ...current, status: 'completed', progress: 1, message: `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} ready for review.`, updatedAt: nowIso(), cancellable: false, result: { ...current.result, candidates } });
    } catch (error) { const current = this.projects.getJob<GenerationJobResult>(jobId); if (controller.signal.aborted || current?.status === 'cancelled' || (error instanceof DOMException && error.name === 'AbortError')) this.settleCancellation(jobId, execution); else if (current?.result && !['completed', 'failed', 'cancelled'].includes(current.status)) this.fail(current, error, candidates, credential); }
    finally { if (this.executions.get(jobId) === execution) this.executions.delete(jobId); }
  }

  cancel(jobId: Id): AsyncJob | undefined {
    const before = this.projects.getJob<GenerationJobResult>(jobId); const execution = this.executions.get(jobId); execution?.controller.abort(); const cancelled = this.projects.cancelJob(jobId);
    if (cancelled?.status !== 'cancelled' || !before?.result || !Array.isArray(before.result.candidates)) return cancelled; return this.settleCancellation(jobId, execution ?? { controller: new AbortController(), phase: 'preparing', submittedRequests: 0, fulfilledRequests: 0, lateFulfilledRequests: 0, candidates: [...before.result.candidates] });
  }

  candidateMedia(jobId: Id, candidateId: Id): { path: string; mimeType: string } | undefined {
    const candidate = this.projects.getJob<GenerationJobResult>(jobId)?.result?.candidates.find((value) => value.id === candidateId);
    return candidate ? { path: candidate.managedPath, mimeType: candidate.asset.mimeType } : undefined;
  }

  async accept(jobId: Id, candidateId: Id, trackId?: Id, startTick?: number, actor: Actor = HUMAN_ACTOR): Promise<ApplyTransactionResponse> {
    const job = this.projects.getJob<GenerationJobResult>(jobId); const result = job?.result; const candidate = result?.candidates.find((value) => value.id === candidateId); if (!job || !result || !candidate) return { status: 'conflict', message: 'Generation candidate does not exist.', conflict: { retryable: false } }; if (result.acceptedCandidateIds.includes(candidateId)) return { status: 'duplicate', message: 'Candidate is already accepted.' };
    const project = this.projects.getProject(result.request.projectId); if (!project) return { status: 'conflict', message: 'Project is not open.', conflict: { retryable: false } }; const operations: ProjectOperation[] = [{ kind: 'asset.add', asset: candidate.asset }];
    const provenance: GenerationProvenance = { ...entityBase('provenance', actor), assetId: candidate.asset.id, provider: result.request.provider, model: result.request.model, modelVersion: typeof candidate.providerMetadata.modelVersion === 'string' ? candidate.providerMetadata.modelVersion : undefined, kind: result.request.kind, prompt: result.request.prompt, lyrics: result.request.lyrics, referenceAssetIds: [...result.request.referenceAssetIds], requestId: candidate.requestId, costMinor: candidate.costMinor, currency: candidate.currency, rightsDeclaration: result.request.rightsDeclaration, transformations: [], experimental: result.request.provider === 'lyria' };
    operations.push({ kind: 'provenance.register', provenance }); let destinationTrackId = trackId;
    if (!destinationTrackId) destinationTrackId = Object.values(project.tracks).find((track) => track.kind === 'audio')?.id;
    if (!destinationTrackId) { const master = Object.values(project.tracks).find((track) => track.kind === 'master')!; const track = createTrack('audio', 'AI Candidates', actor.color, actor); track.routing.outputTrackId = master.id; operations.push({ kind: 'track.add', track, index: Math.max(0, project.trackOrder.length - 1) }); destinationTrackId = track.id; }
    const durationTicks = Math.max(1, Math.round((candidate.asset.durationSamples ?? project.settings.sampleRate) / (candidate.asset.sampleRate ?? project.settings.sampleRate) * project.settings.ppq * 2)); const clipStart = startTick ?? result.request.targetRange?.startTick ?? 0;
    operations.push({ kind: 'clip.add', clip: { ...entityBase('clip', actor), kind: 'audio', trackId: destinationTrackId, assetId: candidate.asset.id, name: basename(candidate.asset.name, extname(candidate.asset.name)), color: actor.color, startTick: clipStart, durationTicks, muted: false, gainDb: 0, fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' }, loopEnabled: Boolean(result.request.seamlessLoop), loopLengthTicks: result.request.seamlessLoop ? durationTicks : undefined, sourceStartSample: 0, sourceDurationSamples: candidate.asset.durationSamples ?? project.settings.sampleRate, transposeSemitones: 0, stretchMode: 'stretch', reverse: false, warpMarkers: [] } });
    const tx: ProjectTransaction = { id: createId('tx'), clientOperationId: createId('accept-generation'), projectId: project.id, actor, label: `Accept generated ${result.request.kind}`, createdAt: nowIso(), operations, checkpointPolicy: 'none' }; this.projects.registerAssetSource(candidate.asset.id, candidate.managedPath); const applied = await this.projects.apply(tx, actor); if (applied.status === 'committed') { const current = this.projects.getJob<GenerationJobResult>(jobId)!; this.projects.upsertJob({ ...current, updatedAt: nowIso(), message: 'Candidate accepted into the arrangement.', result: { ...current.result!, acceptedCandidateIds: [...current.result!.acceptedCandidateIds, candidateId], rejectedCandidateIds: current.result!.rejectedCandidateIds.filter((id) => id !== candidateId) } }); } return applied;
  }

  reject(jobId: Id, candidateId: Id): AsyncJob<GenerationJobResult> | undefined { const job = this.projects.getJob<GenerationJobResult>(jobId); if (!job?.result || !job.result.candidates.some((value) => value.id === candidateId)) return job; const rejected = job.result.rejectedCandidateIds.includes(candidateId) ? job.result.rejectedCandidateIds : [...job.result.rejectedCandidateIds, candidateId]; const next = { ...job, updatedAt: nowIso(), message: 'Candidate rejected; immutable audition media retained for traceability.', result: { ...job.result, rejectedCandidateIds: rejected } }; this.projects.upsertJob(next); return next; }

  private isCancelled(jobId: Id, signal: AbortSignal): boolean { return signal.aborted || this.projects.getJob(jobId)?.status === 'cancelled'; }

  private settleCancellation(jobId: Id, execution: GenerationExecution, candidateCache?: NonNullable<GenerationJobResult['partial']>['candidateCache']): AsyncJob<GenerationJobResult> | undefined {
    const current = this.projects.getJob<GenerationJobResult>(jobId); if (!current?.result || current.status !== 'cancelled') return current;
    const cache = candidateCache ?? (execution.phase === 'candidate-cache' ? 'may-be-partial' : execution.candidates.length ? 'retained' : 'unchanged'); const retained = execution.candidates.length;
    const providerMessage = execution.lateFulfilledRequests ? `${execution.lateFulfilledRequests} provider request${execution.lateFulfilledRequests === 1 ? '' : 's'} fulfilled after cancellation.` : execution.fulfilledRequests ? `${execution.fulfilledRequests} provider request${execution.fulfilledRequests === 1 ? '' : 's'} fulfilled before cancellation.` : execution.submittedRequests ? 'A submitted provider request may still finish or charge.' : 'No provider request was submitted.';
    const cacheMessage = cache === 'retained' ? `${retained} immutable candidate${retained === 1 ? '' : 's'} remain in managed cache for owner review.` : cache === 'may-be-partial' ? 'A candidate cache write was already running; re-observe this job, but its retained effect may remain unconfirmed.' : 'No candidate cache write started.';
    const next: AsyncJob<GenerationJobResult> = { ...current, status: 'cancelled', cancellable: false, message: `Generation cancelled. ${providerMessage} ${cacheMessage} Generation itself made no project transaction, and no provider request was retried automatically.`, updatedAt: nowIso(), approval: undefined, error: undefined, result: { ...current.result, candidates: execution.candidates, partial: { provider: { submittedRequests: execution.submittedRequests, fulfilledRequests: execution.fulfilledRequests, lateFulfilledRequests: execution.lateFulfilledRequests }, candidateCache: cache, retainedCandidateCount: retained, project: 'unchanged' } } };
    this.projects.upsertJob(next); return this.projects.getJob<GenerationJobResult>(jobId);
  }

  private async generateOne(request: GenerationRequest, credential: string, signal: AbortSignal, onSubmitted: () => void): Promise<RawGeneration> { if (request.provider === 'elevenlabs') return this.elevenLabs(request, credential, signal, onSubmitted); if (request.provider === 'stability') return this.stability(request, credential, signal, onSubmitted); return this.lyria(request, credential, signal, onSubmitted); }

  private async elevenLabs(request: GenerationRequest, credential: string, signal: AbortSignal, onSubmitted: () => void): Promise<RawGeneration> {
    const output = outputFor(request); const sfx = request.kind === 'sfx'; const endpoint = sfx ? 'https://api.elevenlabs.io/v1/sound-generation' : 'https://api.elevenlabs.io/v1/music'; let body: Record<string, unknown>;
    if (sfx) body = { text: request.prompt, loop: Boolean(request.seamlessLoop), duration_seconds: request.durationMs / 1000, prompt_influence: request.providerOptions.promptInfluence ?? 0.3, model_id: request.model };
    else if (request.lyrics || request.structure?.length) { const chunks = request.structure?.length ? request.structure.map((section, index) => ({ text: `[${section.name}]${section.lyrics ? `\n${section.lyrics}` : index === 0 && request.lyrics ? `\n${request.lyrics}` : ''}`, duration_ms: Math.max(3_000, section.endMs - section.startMs), positive_styles: [section.prompt ?? request.prompt], negative_styles: request.negativePrompt ? [request.negativePrompt] : [], context_adherence: 'high' })) : [{ text: `[Song]\n${request.lyrics ?? ''}`, duration_ms: request.durationMs, positive_styles: [request.prompt], negative_styles: request.negativePrompt ? [request.negativePrompt] : [], context_adherence: 'high' }]; body = { composition_plan: { chunks }, model_id: request.model, sign_with_c2pa: output.extension === 'mp3' }; }
    else body = { prompt: request.prompt, music_length_ms: request.durationMs, model_id: request.model, force_instrumental: request.instrumental, sign_with_c2pa: output.extension === 'mp3' };
    let response: Response; try { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); onSubmitted(); response = await this.fetcher(`${endpoint}?output_format=${output.extension === 'wav' ? 'pcm_44100' : 'mp3_44100_192'}`, { method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': credential }, body: JSON.stringify(body), signal }); } catch (error) { throw new ProviderError(`ElevenLabs request failed: ${error instanceof Error ? error.message : String(error)}`, 'network', true, true); }
    if (!response.ok) throw providerFailure('ElevenLabs', response, await errorText(response), true); const bytes = Buffer.from(await response.arrayBuffer()); if (!bytes.length) throw new ProviderError('ElevenLabs returned empty audio.', 'empty-response', false, true); return { bytes, mimeType: output.mimeType, extension: output.extension, requestId: response.headers.get('song-id') ?? response.headers.get('request-id') ?? undefined, providerMetadata: { modelVersion: request.model, characterCost: response.headers.get('character-cost'), traceId: response.headers.get('x-trace-id') }, costMinor: request.estimatedCostMinor, currency: request.currency };
  }

  private async stability(request: GenerationRequest, credential: string, signal: AbortSignal, onSubmitted: () => void): Promise<RawGeneration> {
    const output = outputFor(request); const form = new FormData(); form.set('prompt', request.prompt); form.set('model', request.model); form.set('duration', String(request.durationMs / 1000)); form.set('output_format', output.extension === 'wav' ? 'wav' : 'mp3'); if (request.seed !== undefined) form.set('seed', String(request.seed)); if (request.providerOptions.steps !== undefined) form.set('steps', String(request.providerOptions.steps)); if (request.providerOptions.cfgScale !== undefined) form.set('cfg_scale', String(request.providerOptions.cfgScale));
    let endpoint = request.model === 'stable-audio-3' ? 'https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio' : 'https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio';
    if (request.kind === 'audio-to-audio') { const path = this.projects.getAssetSource(request.projectId, request.referenceAssetIds[0]); if (!path) throw new ProviderError('Reference audio is unavailable.', 'missing-reference', false); const bytes = await readFile(path); form.set('audio', new Blob([bytes]), basename(path)); if (request.providerOptions.strength !== undefined) form.set('strength', String(request.providerOptions.strength)); endpoint = request.model === 'stable-audio-3' ? 'https://api.stability.ai/v2beta/audio/stable-audio/audio-to-audio' : 'https://api.stability.ai/v2beta/audio/stable-audio-2/audio-to-audio'; } else form.set('none', new Blob([]), 'none');
    let response: Response; try { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); onSubmitted(); response = await this.fetcher(endpoint, { method: 'POST', headers: { authorization: `Bearer ${credential}`, accept: 'audio/*', 'stability-client-id': 'AIMuse' }, body: form, signal }); } catch (error) { throw new ProviderError(`Stability request failed: ${error instanceof Error ? error.message : String(error)}`, 'network', true, true); }
    if (response.status === 200) return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: output.mimeType, extension: output.extension, requestId: response.headers.get('x-request-id') ?? undefined, providerMetadata: { modelVersion: request.model }, costMinor: request.estimatedCostMinor, currency: request.currency ?? 'credits' };
    if (response.status !== 202) throw providerFailure('Stability', response, await errorText(response), true); const initial = await response.json() as { id?: string }; if (!initial.id) throw new ProviderError('Stability did not return a generation ID.', 'invalid-response', false, true);
    for (let attempt = 0; attempt < 600; attempt += 1) { await delay(1_000, signal); let result: Response; try { result = await this.fetcher(`https://api.stability.ai/v2beta/audio/results/${encodeURIComponent(initial.id)}`, { headers: { authorization: `Bearer ${credential}`, accept: 'audio/*' }, signal }); } catch (error) { throw new ProviderError(`Stability result lookup failed: ${error instanceof Error ? error.message : String(error)}`, 'result-network', true, true); } if (result.status === 202) continue; if (!result.ok) throw providerFailure('Stability', result, await errorText(result), true); return { bytes: Buffer.from(await result.arrayBuffer()), mimeType: output.mimeType, extension: output.extension, requestId: initial.id, providerMetadata: { modelVersion: request.model }, costMinor: request.estimatedCostMinor, currency: request.currency ?? 'credits' }; }
    throw new ProviderError('Stability generation did not complete within ten minutes.', 'timeout', true, true);
  }

  private async lyria(request: GenerationRequest, credential: string, signal: AbortSignal, onSubmitted: () => void): Promise<RawGeneration> {
    if (!this.lyriaEnabled) throw new ProviderError('Lyria preview is not opted in.', 'experimental-disabled', false); const output = outputFor(request); let response: Response; try { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); onSubmitted(); response = await this.fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': credential }, body: JSON.stringify({ model: request.model, input: request.prompt, ...(output.extension === 'wav' ? { response_format: { type: 'audio' } } : {}) }), signal }); } catch (error) { throw new ProviderError(`Lyria request failed: ${error instanceof Error ? error.message : String(error)}`, 'network', true, true); }
    if (!response.ok) throw providerFailure('Lyria', response, await errorText(response), true); const value = await response.json() as { id?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }> }> }; const blocks = value.steps?.flatMap((step) => step.type === 'model_output' ? step.content ?? [] : []) ?? []; const audio = blocks.find((block) => block.type === 'audio' && block.data); if (!audio?.data) throw new ProviderError('Lyria returned no audio block. Preview contract may have changed.', 'preview-contract-changed', false, true); const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).filter(Boolean); return { bytes: Buffer.from(audio.data, 'base64'), mimeType: audio.mime_type ?? output.mimeType, extension: audio.mime_type?.includes('wav') ? 'wav' : output.extension, requestId: value.id, providerMetadata: { modelVersion: request.model, outputText: text }, costMinor: request.estimatedCostMinor, currency: request.currency };
  }

  private async persistCandidate(request: GenerationRequest, raw: RawGeneration, actor: Actor): Promise<GenerationCandidate> { const sha256 = createHash('sha256').update(raw.bytes).digest('hex'); const managedPath = join(this.root, request.projectId, `${sha256}.${raw.extension}`); await atomicWriteFile(managedPath, raw.bytes); const metadata = await parseFile(managedPath, { duration: true, skipCovers: true }).catch(() => undefined); const asset: MediaAsset = { ...entityBase('asset', actor), kind: 'audio', name: `Generated ${request.kind}.${raw.extension}`, mimeType: raw.mimeType, sha256, byteLength: raw.bytes.byteLength, storage: 'managed-cache', externalPath: managedPath, sampleRate: metadata?.format.sampleRate, channels: metadata?.format.numberOfChannels, durationSamples: metadata?.format.duration && metadata.format.sampleRate ? Math.round(metadata.format.duration * metadata.format.sampleRate) : undefined, source: 'generation' }; return { id: createId('candidate'), requestId: raw.requestId, asset, managedPath, costMinor: raw.costMinor, currency: raw.currency, providerMetadata: raw.providerMetadata }; }

  private fail(job: AsyncJob<GenerationJobResult>, error: unknown, candidates: GenerationCandidate[] = job.result?.candidates ?? [], credential?: string): void { const provider = error instanceof ProviderError ? error : new ProviderError(error instanceof Error ? error.message : String(error), 'unexpected', false); const message = redactCredential(provider.message, credential); this.projects.upsertJob({ ...job, status: 'failed', progress: candidates.length ? candidates.length / Math.max(1, job.result?.request.resultCount ?? 1) : job.progress, message: `${message} No automatic retry or provider substitution was attempted.`, updatedAt: nowIso(), result: job.result ? { ...job.result, candidates } : undefined, error: { code: provider.code, message, retryable: provider.retryable, ambiguousCharge: provider.ambiguousCharge } }); }
}
