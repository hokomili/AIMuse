import assert from 'node:assert/strict';
import test from 'node:test';
import { settleAudioPreviewWork } from '../../src/main/audio-preview-lifecycle.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('preview shutdown waits for refresh and build ownership to settle', async () => {
  const refresh = deferred();
  const build = deferred();
  let settled = false;
  const settling = settleAudioPreviewWork(refresh.promise, [build.promise]).then(() => { settled = true; });

  await Promise.resolve();
  assert.equal(settled, false);
  refresh.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  build.resolve();
  await settling;
  assert.equal(settled, true);
});

test('preview shutdown absorbs task failures after they settle', async () => {
  const refresh = deferred();
  const build = deferred();
  const settling = settleAudioPreviewWork(refresh.promise, [build.promise]);

  refresh.reject(new Error('refresh failed'));
  build.reject(new Error('build failed'));
  await assert.doesNotReject(settling);
});
