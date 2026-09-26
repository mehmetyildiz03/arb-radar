/**
 * Uniswap v4 dynamic/static pool fee units are millionths: 10_000 = 1%.
 */
export function poolFeeFraction(poolFeeUnits: number): number {
  if (!Number.isFinite(poolFeeUnits) || poolFeeUnits < 0 || poolFeeUnits >= 1_000_000) {
    throw new RangeError(`invalid pool fee units: ${poolFeeUnits}`);
  }
  return poolFeeUnits / 1_000_000;
}

export function twoLegFeeMultiplier(buyFeeUnits: number, sellFeeUnits: number): number {
  const buy = 1 - poolFeeFraction(buyFeeUnits);
  const sell = 1 - poolFeeFraction(sellFeeUnits);
  return buy * sell;
}

export function minimumGrossPriceRatioForFees(
  buyFeeUnits: number,
  sellFeeUnits: number,
  extraCostBps = 0,
): number {
  if (!Number.isFinite(extraCostBps) || extraCostBps < 0 || extraCostBps >= 10_000) {
    throw new RangeError(`invalid extra cost bps: ${extraCostBps}`);
  }

  const feeMultiplier = twoLegFeeMultiplier(buyFeeUnits, sellFeeUnits);
  const extraMultiplier = 1 - extraCostBps / 10_000;
  return 1 / (feeMultiplier * extraMultiplier);
}
