export interface AudioChildExitTarget {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface AudioChildExitClock {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const systemClock: AudioChildExitClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function hasExited(child: AudioChildExitTarget): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForAudioChildExit(
  child: AudioChildExitTarget,
  timeoutMs: number,
  clock: AudioChildExitClock,
): Promise<boolean> {
  if (hasExited(child) || child.killed) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: unknown = undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      if (timer !== undefined) clock.cancel(timer);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    if (hasExited(child) || child.killed) { finish(true); return; }
    timer = clock.schedule(() => finish(false), timeoutMs);
  });
}

/**
 * Request protocol shutdown, then give that exact child a bounded opportunity to
 * report its natural exit before invoking the existing production fallback.
 */
export async function settleAudioChildShutdown(
  child: AudioChildExitTarget,
  requestShutdown: () => Promise<unknown>,
  forceStop: () => void,
  gracefulExitTimeoutMs: number,
  clock: AudioChildExitClock = systemClock,
): Promise<'natural-exit' | 'forced'> {
  if (!Number.isFinite(gracefulExitTimeoutMs) || gracefulExitTimeoutMs < 0) throw new Error('Audio child exit timeout must be a finite non-negative duration.');
  await requestShutdown().catch(() => undefined);
  if (await waitForAudioChildExit(child, gracefulExitTimeoutMs, clock)) return 'natural-exit';
  if (hasExited(child) || child.killed) return 'natural-exit';
  forceStop();
  return 'forced';
}
