import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_ACTOR, type AsyncJob } from '@aimuse/core';
import type { GenerationJobResult, GenerationRequest } from '../../src/common/generation';
import { AudioEngineController } from '../../src/main/audio-engine';
import { AuthorityManager } from '../../src/main/authority-manager';
import { GenerationManager, type ProviderCredentials } from '../../src/main/generation-manager';
import { RecoveryJournal } from '../../src/main/journal';
import { ProjectService } from '../../src/main/project-service';
import { TransactionTraceStore } from '../../src/main/trace-store';

describe('provider-neutral generation', () => {
  let root: string;
  let audio: AudioEngineController;
  let projects: ProjectService;
  let credentials: ProviderCredentials;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aimuse-generation-'));
    audio = new AudioEngineController();
    projects = new ProjectService({
      appVersion: 'test', checkpointRoot: join(root, 'checkpoints'),
      journal: new RecoveryJournal(join(root, 'recovery')),
      trace: new TransactionTraceStore(join(root, 'traces')), audio,
    });
    credentials = {
      get: async (provider) => `${provider}-key`,
      set: async () => undefined,
      status: async () => ({ elevenlabs: true, stability: true, lyria: true }),
    };
    await audio.start();
    await projects.initialize();
  });

  afterEach(async () => {
    await audio.stop();
    await rm(root, { recursive: true, force: true });
  });

  function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
    return {
      projectId: projects.getActiveProjectId()!, provider: 'elevenlabs', model: 'music_v1', kind: 'music',
      prompt: 'Warm analog instrumental with a strong chorus', instrumental: true, durationMs: 3_000,
      resultCount: 1, referenceAssetIds: [], outputFormat: 'mp3', rightsDeclaration: 'original', providerOptions: {},
      ...overrides,
    };
  }

  async function terminal(jobId: string): Promise<AsyncJob<GenerationJobResult>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = projects.getJob<GenerationJobResult>(jobId)!;
      if (['completed', 'failed', 'cancelled', 'waiting-for-user'].includes(job.status)) return job;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error('Generation job did not reach a terminal state.');
  }

  it('keeps immutable candidates outside the arrangement until explicit acceptance', async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from('ID3\u0004fixture-audio'), { status: 200, headers: { 'content-type': 'audio/mpeg', 'song-id': 'song-123' } }));
    const generation = new GenerationManager(join(root, 'generation'), projects, new AuthorityManager(), credentials, fetcher as typeof fetch);
    const { jobId } = await generation.start(request({ estimatedCostMinor: 25, currency: 'USD' }), HUMAN_ACTOR);
    const completed = await terminal(jobId);

    expect(completed.status).toBe('completed');
    expect(completed.result?.candidates).toHaveLength(1);
    expect(Object.keys(projects.getActiveProject()!.assets)).toHaveLength(0);
    expect(Object.keys(projects.getActiveProject()!.clips)).toHaveLength(0);
    const candidate = completed.result!.candidates[0];
    expect(generation.candidateMedia(jobId, candidate.id)).toEqual({ path: candidate.managedPath, mimeType: candidate.asset.mimeType });
    expect(generation.candidateMedia(jobId, 'missing-candidate')).toBeUndefined();

    expect(await generation.accept(jobId, candidate.id, undefined, 960, HUMAN_ACTOR)).toMatchObject({ status: 'committed' });
    const project = projects.getActiveProject()!;
    expect(project.assets[candidate.asset.id]).toMatchObject({ source: 'generation', sha256: candidate.asset.sha256 });
    expect(Object.values(project.provenance)[0]).toMatchObject({
      assetId: candidate.asset.id, provider: 'elevenlabs', model: 'music_v1', prompt: request().prompt,
      requestId: 'song-123', costMinor: 25, currency: 'USD', rightsDeclaration: 'original', transformations: [],
    });
    expect(Object.values(project.clips)[0]).toMatchObject({ kind: 'audio', assetId: candidate.asset.id, startTick: 960 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [422, 'moderated', false],
    [429, 'rate-limited', false],
    [500, 'http-500', true],
  ] as const)('does not retry or substitute after provider HTTP %i', async (status, code, ambiguousCharge) => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => { void input; return new Response(`provider failure ${status}`, { status }); });
    const generation = new GenerationManager(join(root, 'generation'), projects, new AuthorityManager(), credentials, fetcher as typeof fetch);
    const { jobId } = await generation.start(request());
    const failed = await terminal(jobId);

    expect(failed).toMatchObject({ status: 'failed', error: { code, ambiguousCharge } });
    expect(failed.message).toContain('No automatic retry or provider substitution was attempted.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('api.elevenlabs.io');
  });

  it('does not retry an ambiguous network submission and supports cancellation', async () => {
    const failedFetch = vi.fn(async () => { throw new Error('connection reset after upload'); });
    const failing = new GenerationManager(join(root, 'failing'), projects, new AuthorityManager(), credentials, failedFetch as typeof fetch);
    const failedId = (await failing.start(request())).jobId;
    expect(await terminal(failedId)).toMatchObject({ status: 'failed', error: { code: 'network', ambiguousCharge: true } });
    expect(failedFetch).toHaveBeenCalledTimes(1);

    const pendingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const cancellable = new GenerationManager(join(root, 'cancellable'), projects, new AuthorityManager(), credentials, pendingFetch as typeof fetch);
    const cancelledId = (await cancellable.start(request())).jobId;
    for (let attempt = 0; attempt < 50 && pendingFetch.mock.calls.length === 0; attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    cancellable.cancel(cancelledId);
    expect(await terminal(cancelledId)).toMatchObject({ status: 'cancelled' });
    expect(pendingFetch).toHaveBeenCalledTimes(1);
  });

  it('fails unsupported modes explicitly before making a chargeable request', async () => {
    const fetcher = vi.fn();
    const generation = new GenerationManager(join(root, 'generation'), projects, new AuthorityManager(), credentials, fetcher as typeof fetch);
    await expect(generation.start(request({ provider: 'stability', model: 'stable-audio-2.5', lyrics: 'Do not merge me into the prompt.' }))).rejects.toThrow('no structured custom-lyrics input');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
