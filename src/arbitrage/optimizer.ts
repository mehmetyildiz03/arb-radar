import type { DirectedRoute, ExecutionQuote, OptimizedOpportunity } from "../domain.js";

export type QuoteProvider = (route: DirectedRoute, inputUsd: number) => Promise<ExecutionQuote>;

export interface OptimizeOptions {
  capitalUsd: number;
  maxTradeUsd: number;
  minTradeUsd?: number;
  steps?: number;
  minNetProfitUsd?: number;
  quoteConcurrency?: number;
}

function candidateSizes(options: OptimizeOptions): number[] {
  const max = Math.min(options.capitalUsd, options.maxTradeUsd);
  const min = Math.min(options.minTradeUsd ?? Math.min(1, max), max);
  const steps = Math.max(2, Math.floor(options.steps ?? 16));
  if (![max, min, steps].every(Number.isFinite) || min <= 0 || steps > 1000) return [];
  if (!(max > 0)) return [];
  if (Math.abs(max - min) < 1e-9) return [max];

  const values = new Set<number>();
  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const value = min * Math.pow(max / min, t);
    values.add(Number(value.toFixed(8)));
  }
  values.add(max);
  return [...values].sort((a, b) => a - b);
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(8, Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1)));
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown = null;

  async function runner(): Promise<void> {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        if (failure === null) failure = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  if (failure !== null) throw failure;
  return results;
}

function opportunityFromQuote(
  route: DirectedRoute,
  inputUsd: number,
  quote: ExecutionQuote,
  options: OptimizeOptions,
): OptimizedOpportunity | null {
  if (![quote.inputUsd, quote.outputUsd, quote.gasUsd, quote.extraCostsUsd ?? 0, quote.safetyMarginUsd ?? 0].every(n => Number.isFinite(n) && n >= 0) ||
      Math.abs(quote.inputUsd - inputUsd) > 1e-7) return null;

  const gasUsd = Math.max(0, quote.gasUsd || 0);
  const extraCostsUsd = (quote.extraCostsUsd ?? 0) + (quote.safetyMarginUsd ?? 0);
  if (quote.inputUsd + gasUsd + (quote.extraCostsUsd ?? 0) > options.capitalUsd) return null;
  const netProfitUsd = quote.outputUsd - quote.inputUsd - gasUsd - extraCostsUsd;
  const netReturnPct = quote.inputUsd > 0 ? (netProfitUsd / quote.inputUsd) * 100 : -Infinity;

  return {
    route,
    inputUsd: quote.inputUsd,
    outputUsd: quote.outputUsd,
    gasUsd,
    extraCostsUsd,
    netProfitUsd,
    netReturnPct,
  };
}

export async function optimizeRoute(
  route: DirectedRoute,
  quoteProvider: QuoteProvider,
  options: OptimizeOptions,
): Promise<OptimizedOpportunity | null> {
  const sizes = candidateSizes(options);
  const quotes = await mapBounded(
    sizes,
    options.quoteConcurrency ?? 1,
    inputUsd => quoteProvider(route, inputUsd),
  );

  let best: OptimizedOpportunity | null = null;
  for (let index = 0; index < sizes.length; index++) {
    const current = opportunityFromQuote(route, sizes[index]!, quotes[index]!, options);
    if (current && (best === null || current.netProfitUsd > best.netProfitUsd)) best = current;
  }

  if (best === null || best.netProfitUsd <= 0 || best.netProfitUsd < (options.minNetProfitUsd ?? 0)) return null;
  return best;
}
