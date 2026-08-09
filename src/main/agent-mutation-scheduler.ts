export interface AgentMutationSchedulerOptions {
  maxActive?: number;
  maxQueuedPerActor?: number;
  maxQueuedCost?: number;
  retryAfterMs?: number;
}

export interface AgentMutationRequest<T> {
  actorId: string;
  projectId: string;
  cost: number;
  run: () => Promise<T>;
  onStateChange?: () => void;
}

export type AgentMutationResult<T> =
  | { accepted: true; result: T; waitMs: number }
  | { accepted: false; code: 'actor_queue_full' | 'global_queue_full' | 'cancelled'; message: string; retryAfterMs: number; queueDepth: number; globalQueueDepth: number };

interface QueuedMutation {
  actorId: string;
  projectId: string;
  cost: number;
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (result: AgentMutationResult<unknown>) => void;
  reject: (reason: unknown) => void;
  onStateChange?: () => void;
}

export interface AgentMutationSchedulerStatus {
  active: number;
  queued: number;
  queuedCost: number;
  actors: Record<string, { active: number; queued: number }>;
}

const DEFAULTS = { maxActive: 4, maxQueuedPerActor: 4, maxQueuedCost: 2_048, retryAfterMs: 250 } as const;

export class FairAgentMutationScheduler {
  private readonly options: Required<AgentMutationSchedulerOptions>;
  private readonly queues = new Map<string, QueuedMutation[]>();
  private readonly actorOrder: string[] = [];
  private readonly activeByActor = new Map<string, number>();
  private active = 0;
  private queuedCost = 0;

  constructor(options: AgentMutationSchedulerOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    }
  }

  submit<T>(request: AgentMutationRequest<T>): Promise<AgentMutationResult<T>> {
    if (!Number.isInteger(request.cost) || request.cost <= 0) throw new Error('Mutation cost must be a positive integer.');
    const actorQueue = this.queues.get(request.actorId) ?? [];
    if (actorQueue.length >= this.options.maxQueuedPerActor) {
      return Promise.resolve(this.rejection('actor_queue_full', 'This actor’s mutation queue is full. Retry after current work completes.', request.actorId));
    }
    if (this.queuedCost + request.cost > this.options.maxQueuedCost) {
      return Promise.resolve(this.rejection('global_queue_full', 'The shared mutation queue is full. Retry after current work completes.', request.actorId));
    }
    return new Promise<AgentMutationResult<T>>((resolve, reject) => {
      const wasEmpty = actorQueue.length === 0;
      actorQueue.push({
        ...request,
        enqueuedAt: Date.now(),
        run: request.run as () => Promise<unknown>,
        resolve: (result) => resolve(result as AgentMutationResult<T>),
        reject,
      });
      this.queues.set(request.actorId, actorQueue);
      if (wasEmpty) this.actorOrder.push(request.actorId);
      this.queuedCost += request.cost;
      this.notify(request.onStateChange);
      this.drain();
    });
  }

  cancelQueued(filter: { actorId?: string; projectId?: string } = {}): number {
    let cancelled = 0;
    const callbacks = new Set<() => void>();
    for (const [actorId, queue] of this.queues) {
      const retained: QueuedMutation[] = [];
      for (const item of queue) {
        const matchesActor = filter.actorId === undefined || item.actorId === filter.actorId;
        const matchesProject = filter.projectId === undefined || item.projectId === filter.projectId;
        if (!matchesActor || !matchesProject) { retained.push(item); continue; }
        cancelled += 1;
        this.queuedCost -= item.cost;
        if (item.onStateChange) callbacks.add(item.onStateChange);
        item.resolve(this.rejection('cancelled', 'Queued mutation was cancelled before it started.', actorId));
      }
      if (retained.length) this.queues.set(actorId, retained); else this.queues.delete(actorId);
    }
    for (let index = this.actorOrder.length - 1; index >= 0; index -= 1) if (!this.queues.has(this.actorOrder[index])) this.actorOrder.splice(index, 1);
    for (const callback of callbacks) this.notify(callback);
    return cancelled;
  }

  status(): AgentMutationSchedulerStatus {
    const actors: AgentMutationSchedulerStatus['actors'] = {};
    for (const actorId of new Set([...this.queues.keys(), ...this.activeByActor.keys()])) {
      actors[actorId] = { active: this.activeByActor.get(actorId) ?? 0, queued: this.queues.get(actorId)?.length ?? 0 };
    }
    return { active: this.active, queued: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0), queuedCost: this.queuedCost, actors };
  }

  private rejection(code: 'actor_queue_full' | 'global_queue_full' | 'cancelled', message: string, actorId: string): AgentMutationResult<never> {
    return { accepted: false, code, message, retryAfterMs: this.options.retryAfterMs, queueDepth: this.queues.get(actorId)?.length ?? 0, globalQueueDepth: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0) };
  }

  private drain(): void {
    while (this.active < this.options.maxActive && this.actorOrder.length) {
      const actorId = this.actorOrder.shift()!;
      const queue = this.queues.get(actorId);
      const item = queue?.shift();
      if (!item || !queue) { this.queues.delete(actorId); continue; }
      this.queuedCost -= item.cost;
      if (queue.length) this.actorOrder.push(actorId); else this.queues.delete(actorId);
      this.active += 1;
      this.activeByActor.set(actorId, (this.activeByActor.get(actorId) ?? 0) + 1);
      this.notify(item.onStateChange);
      void Promise.resolve().then(item.run).then(
        (result) => item.resolve({ accepted: true, result, waitMs: Math.max(0, Date.now() - item.enqueuedAt) }),
        item.reject,
      ).finally(() => {
        this.active -= 1;
        const actorActive = (this.activeByActor.get(actorId) ?? 1) - 1;
        if (actorActive) this.activeByActor.set(actorId, actorActive); else this.activeByActor.delete(actorId);
        this.notify(item.onStateChange);
        this.drain();
      });
    }
  }

  private notify(callback?: () => void): void {
    try { callback?.(); } catch { /* presence reporting cannot break scheduling */ }
  }
}
