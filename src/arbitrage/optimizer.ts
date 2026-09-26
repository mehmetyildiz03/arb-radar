import type { DirectedRoute, ExecutionQuote, OptimizedOpportunity } from "../domain.js";

export type QuoteProvider = (route: DirectedRoute, inputUsd: number) => Promise<ExecutionQuote>;

export interface OptimizeOptions {
  capitalUsd: number;
  maxTradeUsd: number;
  minTradeUsd?: number;
  steps?: number;
  minNetProfitUsd?: number;
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

export async function optimizeRoute(
  route: DirectedRoute,
  quoteProvider: QuoteProvider,
  options: OptimizeOptions,
): Promise<OptimizedOpportunity | null> {
  let best: OptimizedOpportunity | null = null;

  for (const inputUsd of candidateSizes(options)) {
    const quote = await quoteProvider(route, inputUsd);
    if (![quote.inputUsd, quote.outputUsd, quote.gasUsd, quote.extraCostsUsd ?? 0, quote.safetyMarginUsd ?? 0].every(n => Number.isFinite(n) && n >= 0) || Math.abs(quote.inputUsd - inputUsd) > 1e-7) continue;

    const gasUsd = Math.max(0, quote.gasUsd || 0);
    const extraCostsUsd = (quote.extraCostsUsd ?? 0) + (quote.safetyMarginUsd ?? 0);
    if (quote.inputUsd + gasUsd + (quote.extraCostsUsd ?? 0) > options.capitalUsd) continue;
    const netProfitUsd = quote.outputUsd - quote.inputUsd - gasUsd - extraCostsUsd;
    const netReturnPct = quote.inputUsd > 0 ? (netProfitUsd / quote.inputUsd) * 100 : -Infinity;

    const current: OptimizedOpportunity = {
      route,
      inputUsd: quote.inputUsd,
      outputUsd: quote.outputUsd,
      gasUsd,
      extraCostsUsd,
      netProfitUsd,
      netReturnPct,
    };

    if (best === null || current.netProfitUsd > best.netProfitUsd) best = current;
  }

  if (best === null || best.netProfitUsd <= 0 || best.netProfitUsd < (options.minNetProfitUsd ?? 0)) return null;
  return best;
}
