import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { settleAudioChildShutdown } from '../../src/main/audio-child-lifecycle.ts';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function controlledClock() {
  let scheduled;
  return {
    clock: {
      schedule(callback, delayMs) {
        assert.equal(scheduled, undefined);
        scheduled = { callback, delayMs };
        return scheduled;
      },
      cancel(handle) {
        if (scheduled === handle) scheduled = undefined;
      },
    },
    pending() { return scheduled; },
    expire() {
      assert.ok(scheduled);
      const { callback } = scheduled;
      scheduled = undefined;
      callback();
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('successful protocol shutdown waits for the natural exit before considering force', async () => {
  const child = new FakeChild();
  const clock = controlledClock();
  const shutdown = deferred();
  let forceAttempts = 0;
  let settled = false;
  const stopping = settleAudioChildShutdown(child, () => shutdown.promise, () => { forceAttempts += 1; }, 1_500, clock.clock)
    .then((result) => { settled = true; return result; });

  await Promise.resolve();
  assert.equal(clock.pending(), undefined);
  assert.equal(forceAttempts, 0);
  shutdown.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.pending().delayMs, 1_500);
  assert.equal(settled, false);
  assert.equal(forceAttempts, 0);

  child.exit(0, null);
  assert.equal(await stopping, 'natural-exit');
  assert.equal(forceAttempts, 0);
  assert.equal(clock.pending(), undefined);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a live survivor reaches the existing fallback only after the grace deadline', async () => {
  const child = new FakeChild();
  const clock = controlledClock();
  let forceAttempts = 0;
  const stopping = settleAudioChildShutdown(child, async () => undefined, () => { forceAttempts += 1; }, 1_500, clock.clock);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(forceAttempts, 0);
  clock.expire();
  assert.equal(await stopping, 'forced');
  assert.equal(forceAttempts, 1);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a failed shutdown request still allows natural exit during the bounded grace period', async () => {
  const child = new FakeChild();
  const clock = controlledClock();
  let forceAttempts = 0;
  const stopping = settleAudioChildShutdown(child, async () => { throw new Error('protocol response lost'); }, () => { forceAttempts += 1; }, 1_500, clock.clock);

  await Promise.resolve();
  await Promise.resolve();
  child.exit(0, null);
  assert.equal(await stopping, 'natural-exit');
  assert.equal(forceAttempts, 0);
});

test('controller stop delegates its force decision to the awaited lifecycle helper', async () => {
  const source = await readFile(new URL('../../src/main/audio-engine.ts', import.meta.url), 'utf8');
  const stopStart = source.indexOf('  async stop(): Promise<void> {');
  const stopEnd = source.indexOf('  status(): AudioEngineStatus', stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stopSource = source.slice(stopStart, stopEnd);
  assert.match(stopSource, /await settleAudioChildShutdown\(\s*child,/);
  assert.match(stopSource, /\(\) => this\.nativeCall\('shutdown', \{\}, 1_500\)/);
  assert.match(stopSource, /\(\) => \{ child\.kill\(\); \},\s*1_500,/);
  assert.doesNotMatch(stopSource, /if \(child\.exitCode === null[^\n]+child\.kill\(\)/);
});
