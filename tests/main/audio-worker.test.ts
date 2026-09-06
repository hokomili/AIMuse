import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProject } from '@aimuse/core';
import { AudioEngineController } from '../../src/main/audio-engine';
import { decodeWav } from '../../src/main/wav';

describe('background audio rendering', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aimuse-worker-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps the caller event loop responsive while a worker produces the WAV', async () => {
    const destination = join(root, 'worker.wav');
    const audio = new AudioEngineController(undefined, 'test', join(root, 'cache'), resolve('tests/fixtures/render-worker.mjs'));
    let eventLoopAdvanced = false;
    setTimeout(() => { eventLoopAdvanced = true; }, 0);
    const rendering = audio.render(createProject('song', 'Worker'), destination, 0, 960);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(eventLoopAdvanced).toBe(true);
    await expect(rendering).resolves.toEqual({ destination, durationSamples: 1, warnings: [] });
    expect(decodeWav(await readFile(destination))).toMatchObject({ sampleRate: 48_000, channels: 2, frames: 1 });
  });
  it('retains a non-retryable capability error across the render worker boundary', async () => {
    const audio = new AudioEngineController(undefined, 'test', join(root, 'cache'), resolve('tests/fixtures/render-worker-capability-error.mjs'));
    await expect(audio.render(createProject('song'), join(root, 'unsupported.wav'))).rejects.toMatchObject({ code: 'unsupported-audio-render', retryable: false, message: 'Unsupported fixture processing.' });
  });

});
