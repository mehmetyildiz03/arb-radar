import { replayTrades } from '../dist/research/replay.js';
export const originalLong5 = '0x9bbd4d06ac29d8900b34998a56e96a33c16220f0';
export function originalReport(capture) {
  if (capture.token !== originalLong5) throw new Error('Original LONG5 target mismatch');
  const resolved = capture.launch.status === 200 && capture.launch.body?.token?.toLowerCase() === originalLong5;
  const tradesAvailable = capture.trades.status === 200 && Array.isArray(capture.trades.body) && capture.trades.body.length > 0;
  if (tradesAvailable && capture.trades.body.some(t => t.token.toLowerCase() !== originalLong5)) throw new Error('Original LONG5 trade mismatch');
  const replay = resolved && tradesAvailable ? replayTrades(capture.launch.body, capture.trades.body) : null;
  return { role: 'original-research-target', token: originalLong5,
    status: !resolved ? 'launch-unavailable' : !tradesAvailable ? 'historical-trades-unavailable' : 'partial-indexer-history',
    launchSource: { ...capture.launch, body: undefined }, tradeSource: { ...capture.trades, body: undefined },
    indexedSymbol: resolved ? capture.launch.body.symbol : null,
    indexedTradeCount: resolved ? capture.launch.body.tradeCount : null,
    historyCoverage: 'Latest at most 2000 trades; not a complete launch-era replay. Missing earlier state is not backfilled.',
    bestExecutableSizeUsd: null, grossPnlUsd: null, netPnlUsd: null, halfLifeMs: null, captureWith100Usd: 'unknown', replay };
}
