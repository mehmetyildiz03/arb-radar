import type { ExecutionQuote } from '../domain.js';

export type NegativePaperReason =
  | 'positive-after-explicit-costs'
  | 'quoted-route-negative-before-explicit-costs'
  | 'gas-erased-quoted-edge'
  | 'extra-cost-erased-remaining-edge'
  | 'safety-margin-erased-remaining-edge'
  | 'negative-after-explicit-costs';

export interface QuoteCostBreakdown {
  inputUsd: number;
  outputUsd: number;
  grossQuotedEdgeUsd: number;
  gasUsd: number;
  extraCostsUsd: number;
  safetyMarginUsd: number;
  explicitCostsUsd: number;
  netProfitUsd: number;
  netReturnPct: number;
  afterGasUsd: number;
  afterExtraCostsUsd: number;
  embeddedRoutingMarketEffect: 'included-in-router-output-not-separately-observable';
  reason: NegativePaperReason;
}

function finiteNonnegative(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function quoteCostBreakdown(quote: ExecutionQuote): QuoteCostBreakdown {
  const inputUsd = finiteNonnegative(quote.inputUsd);
  const outputUsd = finiteNonnegative(quote.outputUsd);
  const gasUsd = finiteNonnegative(quote.gasUsd);
  const extraCostsUsd = finiteNonnegative(quote.extraCostsUsd ?? 0);
  const safetyMarginUsd = finiteNonnegative(quote.safetyMarginUsd ?? 0);
  if (inputUsd === null || inputUsd <= 0 || outputUsd === null || gasUsd === null || extraCostsUsd === null || safetyMarginUsd === null) {
    throw new Error('Invalid quote for cost breakdown');
  }

  const grossQuotedEdgeUsd = outputUsd - inputUsd;
  const afterGasUsd = grossQuotedEdgeUsd - gasUsd;
  const afterExtraCostsUsd = afterGasUsd - extraCostsUsd;
  const explicitCostsUsd = gasUsd + extraCostsUsd + safetyMarginUsd;
  const netProfitUsd = grossQuotedEdgeUsd - explicitCostsUsd;
  const netReturnPct = (netProfitUsd / inputUsd) * 100;

  let reason: NegativePaperReason;
  if (netProfitUsd >= 0) reason = 'positive-after-explicit-costs';
  else if (grossQuotedEdgeUsd <= 0) reason = 'quoted-route-negative-before-explicit-costs';
  else if (afterGasUsd <= 0) reason = 'gas-erased-quoted-edge';
  else if (afterExtraCostsUsd <= 0) reason = 'extra-cost-erased-remaining-edge';
  else if (afterExtraCostsUsd - safetyMarginUsd <= 0) reason = 'safety-margin-erased-remaining-edge';
  else reason = 'negative-after-explicit-costs';

  return {
    inputUsd,
    outputUsd,
    grossQuotedEdgeUsd,
    gasUsd,
    extraCostsUsd,
    safetyMarginUsd,
    explicitCostsUsd,
    netProfitUsd,
    netReturnPct,
    afterGasUsd,
    afterExtraCostsUsd,
    embeddedRoutingMarketEffect: 'included-in-router-output-not-separately-observable',
    reason,
  };
}
