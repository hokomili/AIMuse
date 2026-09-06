import { describe, expect, it, vi } from 'vitest';
import { createProject, type AIMuseProject } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

interface AudioLifecycleProbe {
  nativeStopping: boolean;
  previewBuilds: Map<string, Promise<unknown>>;
  previewRefreshTask?: Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>['resolve'];
  let rejectPromise!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function probe(controller: AudioEngineController): AudioLifecycleProbe {
  return controller as unknown as AudioLifecycleProbe;
}

describe('audio engine lifecycle', () => {
  it('does not finish stopping until active preview refresh and build work settles', async () => {
    const controller = new AudioEngineController();
    const lifecycle = probe(controller);
    const refresh = deferred<void>();
    const build = deferred<void>();
    lifecycle.previewRefreshTask = refresh.promise;
    lifecycle.previewBuilds.set('revision', build.promise);

    let stopped = false;
    const stopping = controller.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(lifecycle.nativeStopping).toBe(true);
    expect(stopped).toBe(false);

    refresh.resolve(undefined);
    await Promise.resolve();
    expect(stopped).toBe(false);

    build.resolve(undefined);
    await stopping;
    expect(stopped).toBe(true);
    expect(lifecycle.previewBuilds.size).toBe(0);
    expect(lifecycle.previewRefreshTask).toBeUndefined();
  });

  it('continues shutdown after failed preview work settles', async () => {
    const controller = new AudioEngineController();
    const lifecycle = probe(controller);
    const refresh = deferred<void>();
    const build = deferred<void>();
    lifecycle.previewRefreshTask = refresh.promise;
    lifecycle.previewBuilds.set('revision', build.promise);

    const stopping = controller.stop();
    refresh.reject(new Error('refresh failed'));
    build.reject(new Error('build failed'));

    await expect(stopping).resolves.toBeUndefined();
    expect(lifecycle.previewBuilds.size).toBe(0);
    expect(lifecycle.previewRefreshTask).toBeUndefined();
  });
  it('pauses a stale preview when the current authored revision cannot render', async () => {
    const controller = new AudioEngineController(); const project = createProject('song');
    const runtime = controller as unknown as {
      project: AIMuseProject; previewRefreshRequested: AIMuseProject;
      ensurePreviewBuilt(project: AIMuseProject): Promise<unknown>;
      drainPreviewRefresh(): Promise<void>;
      nativePreviewKey?: string;
    };
    await controller.synchronizeProject(project); await controller.transport('play');
    runtime.previewRefreshRequested = project; runtime.nativePreviewKey = 'older-revision';
    vi.spyOn(runtime, 'ensurePreviewBuilt').mockRejectedValue(new Error('Sampler is not supported by audio rendering.'));
    await runtime.drainPreviewRefresh();
    expect(controller.snapshot().status).toBe('paused'); expect(runtime.nativePreviewKey).toBeUndefined();
    expect(controller.status().message).toContain('current revision could not render');
    await controller.stop();
  });

});
