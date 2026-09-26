import { sleep } from '../adapters/network.js';

export const lifecycleOffsets = [0, 100, 250, 500, 1000] as const;
const epoch = Date.now() - performance.now();
const monotonicClock = { now: () => epoch + performance.now(), sleep };
export interface LifecycleSample<T> {
  targetMs: number; startedMs: number; completedMs: number; elapsedMs: number;
  quote?: T; netProfitUsd: number | null; error?: string;
}
/** Absolute deadlines; slow RPC calls are recorded late, never relabeled as 100ms observations. */
export async function trackLifecycle<T>(quote: () => Promise<T>, profit: (q: T) => number,
  record: (sample: LifecycleSample<T>) => void, clock = monotonicClock): Promise<LifecycleSample<T>[]> {
  const origin = clock.now();
  const samples: LifecycleSample<T>[] = [];
  for (const targetMs of lifecycleOffsets) {
    await clock.sleep(Math.max(0, origin + targetMs - clock.now()));
    const startedMs = clock.now();
    let result: T | undefined; let error: string | undefined; let netProfitUsd: number | null = null;
    try {
      result = await quote(); netProfitUsd = profit(result);
      if (!Number.isFinite(netProfitUsd)) throw new Error('Non-finite profit');
    } catch (e) { error = String(e); netProfitUsd = null; }
    const completedMs = clock.now();
    const sample = { targetMs, startedMs, completedMs, elapsedMs: completedMs - origin, quote: result, netProfitUsd, error };
    samples.push(sample); record(sample);
  }
  return samples;
}

export function summarizeLifecycle(samples: LifecycleSample<unknown>[]) {
  const first = samples[0];
  if (!first || first.netProfitUsd === null || first.netProfitUsd <= 0) return { status: 'not-observed-profitable', crossingMs: null, halfLifeMs: null };
  const crossing = samples.find(s => s.netProfitUsd !== null && s.netProfitUsd <= 0);
  const half = samples.find(s => s.netProfitUsd !== null && s.netProfitUsd <= first.netProfitUsd! / 2);
  const previous = crossing ? samples.slice(0, samples.indexOf(crossing)).filter(s => s.netProfitUsd !== null && s.netProfitUsd > 0).at(-1) : undefined;
  return { status: crossing ? 'crossed' : samples.some(s => s.error) ? 'unknown' : 'right-censored',
    crossingMs: crossing?.elapsedMs ?? null, crossingIntervalMs: crossing ? [previous?.elapsedMs ?? 0, crossing.elapsedMs] : null,
    halfLifeMs: half?.elapsedMs ?? null, observedThroughMs: samples.at(-1)?.elapsedMs ?? 0 };
}
