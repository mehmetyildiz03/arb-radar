export interface RadarConfig {
  parApiBase: string;
  robinhoodRpcUrl: string;
  robinhoodFeedUrl: string;
  pollMs: number;
  paperCapitalUsd: number;
  minNetProfitUsd: number;
  maxCandidateTradeUsd: number;
  probeConcurrency: number;
  sizingConcurrency: number;
  sizingQuoteConcurrency: number;
  candidateMaxQueueMs: number;
  truthLaunchLimit: number;
  truthScanConcurrency: number;
  screenProbeUsd: number;
  minCandidateTradeUsd: number;
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
    probeConcurrency: Math.min(8, Math.max(1, Math.floor(positiveNumber(env.PROBE_CONCURRENCY, 2)))),
    sizingConcurrency: Math.min(4, Math.max(1, Math.floor(positiveNumber(env.SIZING_CONCURRENCY, 1)))),
    sizingQuoteConcurrency: Math.min(4, Math.max(1, Math.floor(positiveNumber(env.SIZING_QUOTE_CONCURRENCY, 2)))),
    candidateMaxQueueMs: Math.min(30_000, Math.max(100, positiveNumber(env.CANDIDATE_MAX_QUEUE_MS, 2500))),
    truthLaunchLimit: Math.min(30, Math.max(1, Math.floor(positiveNumber(env.TRUTH_LAUNCH_LIMIT, 8)))),
    truthScanConcurrency: Math.min(4, Math.max(1, Math.floor(positiveNumber(env.TRUTH_SCAN_CONCURRENCY, 2)))),
    screenProbeUsd: Math.min(1, positiveNumber(env.SCREEN_PROBE_USD, 0.01)),
    minCandidateTradeUsd: Math.min(10, positiveNumber(env.MIN_CANDIDATE_TRADE_USD, 0.01)),
  };
}
