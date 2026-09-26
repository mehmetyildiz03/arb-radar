export interface RadarConfig {
  parApiBase: string;
  robinhoodRpcUrl: string;
  robinhoodFeedUrl: string;
  pollMs: number;
  paperCapitalUsd: number;
  minNetProfitUsd: number;
  maxCandidateTradeUsd: number;
  recentWindowSeconds: number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function loadConfig(env = process.env): RadarConfig {
  return {
    parApiBase: env.PAR_API_BASE ?? "https://api.par.family",
    robinhoodRpcUrl: env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    robinhoodFeedUrl: env.ROBINHOOD_FEED_URL ?? "wss://feed.mainnet.chain.robinhood.com",
    pollMs: positiveNumber(env.POLL_MS, 1000),
    paperCapitalUsd: positiveNumber(env.PAPER_CAPITAL_USD, 100),
    minNetProfitUsd: positiveNumber(env.MIN_NET_PROFIT_USD, 0.05),
    maxCandidateTradeUsd: positiveNumber(env.MAX_CANDIDATE_TRADE_USD, 100),
    recentWindowSeconds: positiveNumber(env.RECENT_WINDOW_SECONDS, 60),
  };
}
