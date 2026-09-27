import { lifecycleOffsets, monotonicClock, trackLifecycle, type LifecycleSample } from './lifecycle.js';

export interface CaptureTiming {
  discoveredAtMs: number;
  preparationStartedMs: number | null;
  preparationCompletedMs: number | null;
  firstExecutableQuoteStartedMs: number | null;
  firstExecutableQuoteCompletedMs: number | null;
  firstExecutableQuoteSucceeded: boolean;
  sizingBarrierWaitStartedMs: number | null;
  sizingBarrierPassedMs: number | null;
  sizingSlotRequestedMs: number | null;
  sizingStartedMs: number | null;
  sizingCompletedMs: number | null;
  postSizingLifecycleStartedMs: number | null;
  sizingSkipped: boolean;
  sizingSkipReason: string | null;
}
export function timingReport(t: CaptureTiming) {
  return {
    ...t,
    queueDelayMs: t.preparationStartedMs === null ? null : t.preparationStartedMs - t.discoveredAtMs,
    preparationDurationMs: t.preparationStartedMs === null || t.preparationCompletedMs === null ? null : t.preparationCompletedMs - t.preparationStartedMs,
    discoveryToFirstQuoteStartedMs: t.firstExecutableQuoteStartedMs === null ? null : t.firstExecutableQuoteStartedMs - t.discoveredAtMs,
    discoveryToFirstQuoteCompletedMs: t.firstExecutableQuoteCompletedMs === null ? null : t.firstExecutableQuoteCompletedMs - t.discoveredAtMs,
    firstQuoteDurationMs: t.firstExecutableQuoteStartedMs === null || t.firstExecutableQuoteCompletedMs === null ? null : t.firstExecutableQuoteCompletedMs - t.firstExecutableQuoteStartedMs,
    sizingBarrierWaitMs: t.sizingBarrierWaitStartedMs === null || t.sizingBarrierPassedMs === null ? null : t.sizingBarrierPassedMs - t.sizingBarrierWaitStartedMs,
    sizingQueueWaitMs: t.sizingSlotRequestedMs === null || t.sizingStartedMs === null ? null : t.sizingStartedMs - t.sizingSlotRequestedMs,
    sizingDurationMs: t.sizingStartedMs === null || t.sizingCompletedMs === null ? null : t.sizingCompletedMs - t.sizingStartedMs,
    sizingTotalPhaseMs: t.sizingSlotRequestedMs === null || t.sizingCompletedMs === null ? null : t.sizingCompletedMs - t.sizingSlotRequestedMs,
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
  shouldSize?: (quote: Q) => boolean;
  sizingSkipReason?: string;
}, clock = monotonicClock) {
  const timing: CaptureTiming = {
    discoveredAtMs: options.discoveredAtMs,
    preparationStartedMs: null,
    preparationCompletedMs: null,
    firstExecutableQuoteStartedMs: null,
    firstExecutableQuoteCompletedMs: null,
    firstExecutableQuoteSucceeded: false,
    sizingBarrierWaitStartedMs: null,
    sizingBarrierPassedMs: null,
    sizingSlotRequestedMs: null,
    sizingStartedMs: null,
    sizingCompletedMs: null,
    postSizingLifecycleStartedMs: null,
    sizingSkipped: false,
    sizingSkipReason: null,
  };
  try {
    const probePhase = async () => {
      timing.preparationStartedMs = clock.now();
      let context: C;
      try {
        context = await options.prepare();
      } finally {
        timing.preparationCompletedMs = clock.now();
      }
      const first = await trackLifecycle(async () => {
        timing.firstExecutableQuoteStartedMs = clock.now();
        try {
          const q = await options.quote(context);
          timing.firstExecutableQuoteSucceeded = true;
          return q;
        } finally {
          timing.firstExecutableQuoteCompletedMs = clock.now();
        }
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

    const firstQuote=first[0].quote;
    if (options.shouldSize && firstQuote !== undefined && !options.shouldSize(firstQuote)) {
      timing.sizingSkipped = true;
      timing.sizingSkipReason = options.sizingSkipReason ?? 'first-probe-did-not-qualify';
      return { best: null, samples: first, timing: timingReport(timing) };
    }

    timing.sizingBarrierWaitStartedMs = clock.now();
    if (options.beforeSizing) await options.beforeSizing();
    timing.sizingBarrierPassedMs = clock.now();

    timing.sizingSlotRequestedMs = clock.now();
    let best: B;
    const sizingPhase = async () => {
      timing.sizingStartedMs = clock.now();
      try {
        return await options.size(context);
      } finally {
        timing.sizingCompletedMs = clock.now();
      }
    };
    best = options.withSizingPhase
      ? await options.withSizingPhase(sizingPhase)
      : await sizingPhase();

    timing.postSizingLifecycleStartedMs = clock.now();
    const later = await trackLifecycle(() => options.quote(context), options.profit, options.recordSample, clock,
      { discoveredAtMs: options.discoveredAtMs, offsets: lifecycleOffsets.slice(1) });
    return { best, samples: [...first, ...later], timing: timingReport(timing) };
  } finally {
    options.recordTiming(timingReport(timing));
  }
}
