export type HexAddress = `0x${string}`;

export interface MarketSnapshot {
  poolFeeUnits?: number;
  priceAtMs?: number;
  stale?: boolean;
  index: number;
  pairToken: HexAddress | "0x0000000000000000000000000000000000000000";
  quoteSymbol: string;
  poolId?: `0x${string}`;
  tokenPriceEth: number;
  recentVolumeEth?: number;
}

export interface LaunchSnapshot {
  token: HexAddress;
  symbol: string;
  name?: string;
  kind: "single" | "multi";
  poolFeeUnits: number;
  creatorTaxBps?: number;
  marketCount: number;
  markets: MarketSnapshot[];
  createdAt?: number;
  lastTradeAt?: number;
}

export interface DirectedRoute {
  token: HexAddress;
  buy: MarketSnapshot;
  sell: MarketSnapshot;
  poolFeeUnits: number;
}

export interface RouteScreen {
  route: DirectedRoute;
  grossPriceRatio: number;
  grossSpreadPct: number;
  feeAdjustedReturnPct: number;
  passesFeeFloor: boolean;
}

export interface ExecutionQuote {
  inputUsd: number;
  outputUsd: number;
  gasUsd: number;
  extraCostsUsd?: number;
  safetyMarginUsd?: number;
}

export interface OptimizedOpportunity {
  route: DirectedRoute;
  inputUsd: number;
  outputUsd: number;
  gasUsd: number;
  extraCostsUsd: number;
  netProfitUsd: number;
  netReturnPct: number;
}
