import type { IndexedLaunch, IndexedTrade } from 'par-sdk';
import { normalizeLaunch } from '../adapters/parIndexer.js';
import { enumerateDirectedRoutes, screenRoute } from '../arbitrage/routes.js';

export function replayTrades(raw: IndexedLaunch, trades: IndexedTrade[]) {
  const launch = normalizeLaunch(raw);
  if (!launch) throw new Error('Invalid launch fixture');
  // Start empty: current prices must never leak into historical frames.
  const prices = new Map<number, { price: number; at: number }>();
  const byBlock = new Map<number, IndexedTrade[]>();
  const unique = new Map(trades.map(t => [t.id, t]));
  for (const trade of [...unique.values()].sort((a,b) => a.blockNumber - b.blockNumber || Number(a.id.split('-').at(-1)) - Number(b.id.split('-').at(-1)))) {
    if (trade.token.toLowerCase() !== launch.token) throw new Error('Replay token mismatch');
    const group = byBlock.get(trade.blockNumber) ?? []; group.push(trade); byBlock.set(trade.blockNumber, group);
  }
  const frames = [];
  for (const [blockNumber, group] of byBlock) {
    const timestampMs = Math.max(...group.map(t => t.timestamp)) * 1000;
    for (const trade of group) {
      if (trade.market === null) continue;
      if (trade.priceEth !== null && Number.isFinite(trade.priceEth) && trade.priceEth > 0) prices.set(trade.market, { price: trade.priceEth, at: trade.timestamp * 1000 });
      else prices.delete(trade.market);
    }
    const markets = (raw.markets ?? []).flatMap(m => {
      const p = prices.get(m.index);
      return p ? [{ index: m.index, pairToken: m.pairToken, quoteSymbol: m.quoteSymbol, poolId: m.poolId, tokenPriceEth: p.price, priceAtMs: p.at }] : [];
    });
    const routes = enumerateDirectedRoutes({ ...launch, markets });
    const screens = routes.map(r => screenRoute(r, 0, { nowMs: timestampMs, maxAgeMs: 60_000 })).filter(s => s?.passesFeeFloor);
    frames.push({ timestampMs, blockNumber, marketsObserved: markets.length, dislocations: screens.map(s => ({ buy: s!.route.buy.index, sell: s!.route.sell.index, spreadPct: s!.grossSpreadPct, feeAdjustedReturnPct: s!.feeAdjustedReturnPct })),
      bestExecutableSizeUsd: null, grossPnlUsd: null, netPnlUsd: null, halfLifeMs: null, captureWith100Usd: 'unknown' });
  }
  return { token: launch.token, symbol: launch.symbol, trades: unique.size, frames,
    limitation: 'Indexed transaction prices only; no historical amount-sensitive quotes or subsecond observations. Executability, P&L and capture remain unknown.' };
}
