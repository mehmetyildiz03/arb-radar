export class StaleCandidateError extends Error {
  constructor(readonly ageMs: number, readonly maxAgeMs: number) {
    super(`Candidate stale in queue: ${Math.round(ageMs)}ms > ${Math.round(maxAgeMs)}ms`);
    this.name = 'StaleCandidateError';
  }
}

export interface QueueCandidate<T> {
  key: string;
  discoveredAtMs: number;
  priority: number;
  value: T;
}

export interface StageSchedulerMetrics {
  queued: number;
  droppedStale: number;
  probesStarted: number;
  probesCompleted: number;
  sizingStarted: number;
  sizingCompleted: number;
  maxActiveProbes: number;
  maxActiveSizing: number;
}

export interface CandidateStageControls {
  withProbePhase<R>(work: () => Promise<R>): Promise<R>;
  waitForProbeStage(): Promise<void>;
  withSizingPhase<R>(work: () => Promise<R>): Promise<R>;
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly limit: number, private readonly onActive?: (active: number) => void) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active++;
    this.onActive?.(this.active);
    try {
      return await work();
    } finally {
      this.active--;
      this.onActive?.(this.active);
      this.waiters.shift()?.();
    }
  }
}

export function rankQueueCandidates<T>(items: readonly QueueCandidate<T>[]): QueueCandidate<T>[] {
  return [...items].sort((a,b) =>
    b.priority - a.priority ||
    a.discoveredAtMs - b.discoveredAtMs ||
    a.key.localeCompare(b.key));
}

export async function runStagedCandidates<T, R>(
  candidates: readonly QueueCandidate<T>[],
  options: {
    probeConcurrency: number;
    sizingConcurrency: number;
    maxQueueAgeMs: number;
    now?: () => number;
    onMetrics?: (metrics: StageSchedulerMetrics) => void;
  },
  worker: (candidate: QueueCandidate<T>, controls: CandidateStageControls) => Promise<R>,
): Promise<Array<{ candidate: QueueCandidate<T>; status: 'fulfilled'; value: R } | { candidate: QueueCandidate<T>; status: 'rejected'; reason: unknown }>> {
  const ordered = rankQueueCandidates(candidates);
  const now = options.now ?? Date.now;
  const probeConcurrency = boundedInteger(options.probeConcurrency,1,8);
  const sizingConcurrency = boundedInteger(options.sizingConcurrency,1,4);
  const maxQueueAgeMs = Number.isFinite(options.maxQueueAgeMs) && options.maxQueueAgeMs > 0 ? options.maxQueueAgeMs : 2_500;

  const metrics: StageSchedulerMetrics = {
    queued: ordered.length,
    droppedStale: 0,
    probesStarted: 0,
    probesCompleted: 0,
    sizingStarted: 0,
    sizingCompleted: 0,
    maxActiveProbes: 0,
    maxActiveSizing: 0,
  };
  const emit = () => options.onMetrics?.({ ...metrics });

  let activeProbes = 0;
  let activeSizing = 0;
  const probeSemaphore = new Semaphore(probeConcurrency, active => {
    activeProbes = active;
    metrics.maxActiveProbes = Math.max(metrics.maxActiveProbes, activeProbes);
  });
  const sizingSemaphore = new Semaphore(sizingConcurrency, active => {
    activeSizing = active;
    metrics.maxActiveSizing = Math.max(metrics.maxActiveSizing, activeSizing);
  });

  let probeFinished = 0;
  let releaseProbeBarrier: (() => void) | undefined;
  const probeBarrier = new Promise<void>(resolve => { releaseProbeBarrier = resolve; });
  const markProbeFinished = () => {
    probeFinished++;
    if (probeFinished >= ordered.length) releaseProbeBarrier?.();
  };
  if (ordered.length === 0) releaseProbeBarrier?.();

  const tasks = ordered.map(candidate => (async () => {
    let probeMarked = false;
    const controls: CandidateStageControls = {
      withProbePhase: async <V>(work: () => Promise<V>) => probeSemaphore.run(async () => {
        const ageMs = Math.max(0, now() - candidate.discoveredAtMs);
        if (ageMs > maxQueueAgeMs) {
          metrics.droppedStale++;
          emit();
          throw new StaleCandidateError(ageMs,maxQueueAgeMs);
        }
        metrics.probesStarted++;
        emit();
        try {
          return await work();
        } finally {
          metrics.probesCompleted++;
          if (!probeMarked) {
            probeMarked = true;
            markProbeFinished();
          }
          emit();
        }
      }),
      waitForProbeStage: () => probeBarrier,
      withSizingPhase: async <V>(work: () => Promise<V>) => sizingSemaphore.run(async () => {
        metrics.sizingStarted++;
        emit();
        try {
          return await work();
        } finally {
          metrics.sizingCompleted++;
          emit();
        }
      }),
    };
    try {
      return await worker(candidate,controls);
    } finally {
      if (!probeMarked) {
        probeMarked = true;
        markProbeFinished();
      }
    }
  })());

  const settled = await Promise.allSettled(tasks);
  emit();
  return settled.map((entry,index) => entry.status === 'fulfilled'
    ? { candidate: ordered[index]!, status:'fulfilled' as const, value:entry.value }
    : { candidate: ordered[index]!, status:'rejected' as const, reason:entry.reason });
}


export function sharedAsyncResource<T>(factory: () => Promise<T>): () => Promise<T> {
  let shared: Promise<T> | null = null;
  return () => {
    shared ??= Promise.resolve().then(factory);
    return shared;
  };
}
