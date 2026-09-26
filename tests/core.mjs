import test from 'node:test';
import assert from 'node:assert/strict';
import {
  minimumGrossPriceRatioForFees,
  poolFeeFraction,
  twoLegFeeMultiplier,
} from '../dist/pricing/fees.js';
import { enumerateDirectedRoutes, screenRoute } from '../dist/arbitrage/routes.js';
import { optimizeRoute } from '../dist/arbitrage/optimizer.js';
import { normalizeLaunch } from '../dist/adapters/parIndexer.js';

test('3% pool fee is represented correctly', () => {
  assert.equal(poolFeeFraction(30_000), 0.03);
  assert.ok(Math.abs(twoLegFeeMultiplier(30_000, 30_000) - 0.9409) < 1e-12);
  assert.ok(Math.abs(minimumGrossPriceRatioForFees(30_000, 30_000) - 1.0628122) < 1e-6);
});

test('five markets produce 20 directed routes', () => {
  const launch = {
    token: '0x1111111111111111111111111111111111111111',
    symbol: 'T', kind: 'multi', poolFeeUnits: 30_000, marketCount: 5,
    markets: Array.from({length: 5}, (_, i) => ({
      index: i,
      pairToken: '0x0000000000000000000000000000000000000000',
      quoteSymbol: `Q${i}`,
      tokenPriceEth: 1 + i * 0.01,
    })),
  };
  assert.equal(enumerateDirectedRoutes(launch).length, 20);
});

test('fee floor rejects spread below two-leg fees and accepts larger spread', () => {
  const base = {
    token: '0x1111111111111111111111111111111111111111',
    poolFeeUnits: 30_000,
  };
  const small = screenRoute({
    ...base,
    buy: { index: 0, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'A', tokenPriceEth: 1 },
    sell: { index: 1, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'B', tokenPriceEth: 1.05 },
  });
  const large = screenRoute({
    ...base,
    buy: { index: 0, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'A', tokenPriceEth: 1 },
    sell: { index: 1, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'B', tokenPriceEth: 1.10 },
  });
  assert.equal(small?.passesFeeFloor, false);
  assert.equal(large?.passesFeeFloor, true);
});

test('optimizer can prefer a smaller trade when slippage increases', async () => {
  const route = {
    token: '0x1111111111111111111111111111111111111111',
    poolFeeUnits: 30_000,
    buy: { index: 0, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'A', tokenPriceEth: 1 },
    sell: { index: 1, pairToken: '0x0000000000000000000000000000000000000000', quoteSymbol: 'B', tokenPriceEth: 1.2 },
  };

  const best = await optimizeRoute(route, async (_route, inputUsd) => ({
    inputUsd,
    outputUsd: inputUsd * 1.14 - 0.0015 * inputUsd * inputUsd,
    gasUsd: 0.05,
  }), { capitalUsd: 100, maxTradeUsd: 100, minTradeUsd: 1, steps: 40 });

  assert.ok(best);
  assert.ok(best.inputUsd < 100);
  assert.ok(best.netProfitUsd > 0);
});

test('indexer normalizer keeps multi-market ETH-normalized prices', () => {
  const launch = normalizeLaunch({
    token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    symbol: 'XYZ', kind: 'multi', poolFee: 30000, marketCount: 2,
    markets: [
      { index: 0, pairToken: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', quoteSymbol: 'AI', lastPriceEth: 0.00001 },
      { index: 1, pairToken: '0xcccccccccccccccccccccccccccccccccccccccc', quoteSymbol: 'MEME', lastPriceEth: 0.000011 },
    ],
  });
  assert.ok(launch);
  assert.equal(launch.kind, 'multi');
  assert.equal(launch.markets.length, 2);
  assert.equal(launch.poolFeeUnits, 30000);
});
