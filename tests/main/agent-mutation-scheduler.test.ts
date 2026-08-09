import { describe, expect, it } from 'vitest';
import { FairAgentMutationScheduler } from '@main/agent-mutation-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe('FairAgentMutationScheduler', () => {
  it('runs at most four mutations concurrently', async () => {
    const scheduler = new FairAgentMutationScheduler();
    const gates = Array.from({ length: 6 }, () => deferred<number>());
    let active = 0;
    let maximum = 0;
    const submissions = gates.map((gate, index) => scheduler.submit({
      actorId: `actor-${index}`, projectId: `project-${index}`, cost: 1,
      run: async () => { active += 1; maximum = Math.max(maximum, active); const result = await gate.promise; active -= 1; return result; },
    }));
    await turn();
    expect(scheduler.status()).toMatchObject({ active: 4, queued: 2 });
    expect(maximum).toBe(4);
    gates.slice(0, 4).forEach((gate, index) => gate.resolve(index));
    await turn();
    expect(scheduler.status().active).toBe(2);
    gates.slice(4).forEach((gate, index) => gate.resolve(index + 4));
    const results = await Promise.all(submissions);
    expect(results.every((result) => result.accepted)).toBe(true);
    expect(scheduler.status()).toMatchObject({ active: 0, queued: 0, queuedCost: 0 });
  });

  it('serves queued actors in round-robin order', async () => {
    const scheduler = new FairAgentMutationScheduler({ maxActive: 1 });
    const blocker = deferred<void>();
    const started: string[] = [];
    const first = scheduler.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => { started.push('a0'); await blocker.promise; } });
    await turn();
    const queued = [
      scheduler.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => { started.push('a1'); } }),
      scheduler.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => { started.push('a2'); } }),
      scheduler.submit({ actorId: 'b', projectId: 'p', cost: 1, run: async () => { started.push('b1'); } }),
      scheduler.submit({ actorId: 'b', projectId: 'p', cost: 1, run: async () => { started.push('b2'); } }),
    ];
    blocker.resolve();
    await Promise.all([first, ...queued]);
    expect(started).toEqual(['a0', 'a1', 'b1', 'a2', 'b2']);
  });

  it('rejects per-actor and global queue overflow with retry guidance', async () => {
    const actorLimited = new FairAgentMutationScheduler({ maxActive: 1, maxQueuedPerActor: 2, maxQueuedCost: 10 });
    const blocker = deferred<void>();
    const running = actorLimited.submit({ actorId: 'running', projectId: 'p', cost: 1, run: () => blocker.promise });
    await turn();
    const queuedOne = actorLimited.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => undefined });
    const queuedTwo = actorLimited.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => undefined });
    const actorRejected = await actorLimited.submit({ actorId: 'a', projectId: 'p', cost: 1, run: async () => undefined });
    expect(actorRejected).toMatchObject({ accepted: false, code: 'actor_queue_full', retryAfterMs: 250, queueDepth: 2 });
    blocker.resolve();
    await Promise.all([running, queuedOne, queuedTwo]);

    const globalLimited = new FairAgentMutationScheduler({ maxActive: 1, maxQueuedPerActor: 4, maxQueuedCost: 2 });
    const secondBlocker = deferred<void>();
    const secondRunning = globalLimited.submit({ actorId: 'running', projectId: 'p', cost: 1, run: () => secondBlocker.promise });
    await turn();
    const globallyQueued = globalLimited.submit({ actorId: 'a', projectId: 'p', cost: 2, run: async () => undefined });
    const globalRejected = await globalLimited.submit({ actorId: 'b', projectId: 'p', cost: 1, run: async () => undefined });
    expect(globalRejected).toMatchObject({ accepted: false, code: 'global_queue_full', globalQueueDepth: 1 });
    secondBlocker.resolve();
    await Promise.all([secondRunning, globallyQueued]);
  });

  it('cancels matching queued work without disturbing other projects', async () => {
    const scheduler = new FairAgentMutationScheduler({ maxActive: 1 });
    const blocker = deferred<void>();
    const running = scheduler.submit({ actorId: 'running', projectId: 'p0', cost: 1, run: () => blocker.promise });
    await turn();
    const cancelled = scheduler.submit({ actorId: 'a', projectId: 'p1', cost: 1, run: async () => 'should-not-run' });
    const retained = scheduler.submit({ actorId: 'a', projectId: 'p2', cost: 1, run: async () => 'ran' });
    expect(scheduler.cancelQueued({ projectId: 'p1' })).toBe(1);
    await expect(cancelled).resolves.toMatchObject({ accepted: false, code: 'cancelled' });
    blocker.resolve();
    await running;
    await expect(retained).resolves.toMatchObject({ accepted: true, result: 'ran' });
  });
});
