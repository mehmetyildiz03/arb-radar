import { lifecycleOffsets, monotonicClock, trackLifecycle, type LifecycleSample } from './lifecycle.js';

export interface CaptureTiming {
  discoveredAtMs: number;
  firstExecutableQuoteStartedMs: number | null;
  firstExecutableQuoteCompletedMs: number | null;
  firstExecutableQuoteSucceeded: boolean;
  sizingStartedMs: number | null;
  sizingCompletedMs: number | null;
  postSizingLifecycleStartedMs: number | null;
}
export function timingReport(t: CaptureTiming) {
  return { ...t,
    discoveryToFirstQuoteStartedMs: t.firstExecutableQuoteStartedMs === null ? null : t.firstExecutableQuoteStartedMs - t.discoveredAtMs,
    discoveryToFirstQuoteCompletedMs: t.firstExecutableQuoteCompletedMs === null ? null : t.firstExecutableQuoteCompletedMs - t.discoveredAtMs,
    sizingDurationMs: t.sizingStartedMs === null || t.sizingCompletedMs === null ? null : t.sizingCompletedMs - t.sizingStartedMs,
    discoveryToPostSizingLifecycleMs: t.postSizingLifecycleStartedMs === null ? null : t.postSizingLifecycleStartedMs - t.discoveredAtMs,
    captureCapability: 'unproven: quote completion is not transaction inclusion',
  };
}

/** Probe before exhaustive sizing; keep the probe size fixed for comparable decay samples. */
export async function measureCandidate<C, Q, B>(options: {
  discoveredAtMs: number;
  prepare: () => Promise<C>;
  quote: (context: C) => Promise<Q>;
  size: (context: C) => Promise<B>;
  profit: (quote: Q) => number;
  recordSample: (sample: LifecycleSample<Q>) => void;
  recordTiming: (timing: ReturnType<typeof timingReport>) => void;
  withProbePhase?: <T>(work: () => Promise<T>) => Promise<T>;
  beforeSizing?: () => Promise<void>;
  withSizingPhase?: <T>(work: () => Promise<T>) => Promise<T>;
}, clock = monotonicClock) {
  const timing: CaptureTiming = { discoveredAtMs: options.discoveredAtMs,
    firstExecutableQuoteStartedMs: null, firstExecutableQuoteCompletedMs: null, firstExecutableQuoteSucceeded: false,
    sizingStartedMs: null, sizingCompletedMs: null, postSizingLifecycleStartedMs: null };
  try {
    const probePhase = async () => {
      const context = await options.prepare();
      const first = await trackLifecycle(async () => {
        timing.firstExecutableQuoteStartedMs = clock.now();
        try { const q = await options.quote(context); timing.firstExecutableQuoteSucceeded = true; return q; }
        finally { timing.firstExecutableQuoteCompletedMs = clock.now(); }
      }, options.profit, options.recordSample, clock, { discoveredAtMs: options.discoveredAtMs, offsets: [0] });
      return { context, first };
    };
    const { context, first } = options.withProbePhase
      ? await options.withProbePhase(probePhase)
      : await probePhase();
    if (first[0].error) {
      timing.firstExecutableQuoteSucceeded = false;
      return { best: null, samples: first, timing: timingReport(timing) };
    }
    if (options.beforeSizing) await options.beforeSizing();
    timing.sizingStartedMs = clock.now();
    let best: B;
    const sizingPhase = async () => options.size(context);
    try {
      best = options.withSizingPhase
        ? await options.withSizingPhase(sizingPhase)
        : await sizingPhase();
    } finally { timing.sizingCompletedMs = clock.now(); }
    timing.postSizingLifecycleStartedMs = clock.now();
    const later = await trackLifecycle(() => options.quote(context), options.profit, options.recordSample, clock,
      { discoveredAtMs: options.discoveredAtMs, offsets: lifecycleOffsets.slice(1) });
    return { best, samples: [...first, ...later], timing: timingReport(timing) };
  } finally { options.recordTiming(timingReport(timing)); }
}
