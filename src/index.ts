import { createPar, robinhoodChain } from 'par-sdk';
import { createPublicClient, http } from 'viem';
import { loadConfig } from './config.js';
import { Discovery } from './adapters/discovery.js';
import { resilientFetch, sleep } from './adapters/network.js';
import { simulateRoute, netProfit, type Valuation } from './adapters/simulation.js';
import { enumerateDirectedRoutes, screenRoute } from './arbitrage/routes.js';
import { optimizeRoute } from './arbitrage/optimizer.js';
import { ResearchStore, json } from './research/store.js';
import { trackLifecycle, summarizeLifecycle } from './research/lifecycle.js';

const config = loadConfig();
const store = new ResearchStore(process.env.RADAR_DB ?? 'data/radar.sqlite');
const source = config.robinhoodRpcUrl;
const readMethods = new Set(['eth_call', 'eth_estimateGas', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_chainId', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionReceipt']);
const rpcFetch: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body) || !readMethods.has(body.method)) throw new Error('Non-read RPC method blocked');
  const started = Date.now(); let status = 'error';
  const blockParam = ['eth_call', 'eth_estimateGas'].includes(body.method) ? body.params?.[1] : body.method === 'eth_getBlockByNumber' ? body.params?.[0] : undefined;
  const blockNumber = typeof blockParam === 'string' && /^0x[0-9a-f]+$/i.test(blockParam) ? BigInt(blockParam) : null;
  try {
    const response = await resilientFetch()(url, init);
    const result = await response.clone().json() as { error?: { code?: number } };
    status = result.error ? `rpc-error:${result.error.code}` : String(response.status); return response;
  }
  finally { store.record('rpc_latency_samples', body.method, { durationMs: Date.now() - started, status, params: body.params }, { timestampMs: started, blockNumber, source }); }
};
const client = createPublicClient({ chain: robinhoodChain, transport: http(source, { fetchFn: rpcFetch, retryCount: 0, timeout: 15_000 }) });
const discovery = new Discovery(createPar({ client }), config.parApiBase);
async function valuation(): Promise<Valuation> {
  const started = Date.now();
  const response = await resilientFetch()('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if (!response.ok) throw new Error(`ETH/USD unavailable: ${response.status}`);
  const body = await response.json() as { data?: { amount?: string; base?: string; currency?: string } };
  const usdPerEth = Number(body.data?.amount);
  if (!Number.isFinite(usdPerEth) || usdPerEth <= 0 || body.data?.base !== 'ETH' || body.data.currency !== 'USD') throw new Error('Invalid ETH/USD');
  return { usdPerEth, timestampMs: started, source: 'coinbase:ETH-USD/spot (retrieval time; valuation only)' };
}
async function tick(): Promise<void> {
  const launches = await discovery.latest();
  let candidates = 0, opportunities = 0;
  for (const launch of launches) {
    const provenance = { timestampMs: Date.now(), blockNumber: null, source: config.parApiBase };
    store.record('launches', launch.token, launch, provenance);
    for (const market of launch.markets) store.record('market_snapshots', `${launch.token}:${market.index}`, market, provenance);
    const screens = enumerateDirectedRoutes(launch).map(route => ({ route, screen: screenRoute(route, 0, { nowMs: Date.now(), maxAgeMs: config.recentWindowSeconds * 1000 }) }));
    for (const { route, screen } of screens) store.record('route_screens', `${launch.token}:${route.buy.index}:${route.sell.index}`, { route, screen, rejected: screen === null }, provenance);
    for (const { route, screen } of screens.filter(s => s.screen?.passesFeeFloor)) {
      candidates++;
      const key = `${launch.token}:${route.buy.index}:${route.sell.index}:${Date.now()}`;
      try {
        const meta = await discovery.metadata(launch.token);
        if (!meta) throw new Error('No RPC metadata');
        store.record('launches', launch.token, { metadata: meta, note: 'SDK metadata reads; not an atomic state snapshot' }, { timestampMs: Date.now(), blockNumber: null, source });
        const value = await valuation();
        const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
        const quote = async (amount: number, fixedBlock?: bigint) => {
          const q = await simulateRoute(client, meta, route, amount, value, { extraCostsUsd: 0.05, safetyBps: 100, source, blockNumber: fixedBlock });
          store.record('executable_quotes', key, { route, quote: q, netProfitUsd: netProfit(q), screen }, q);
          return q;
        };
        const best = await optimizeRoute(route, (_r, amount) => quote(amount, blockNumber), { capitalUsd: config.paperCapitalUsd, maxTradeUsd: config.maxCandidateTradeUsd, steps: 8, minNetProfitUsd: config.minNetProfitUsd });
        const trackedInput = best?.inputUsd ?? Math.min(1, config.paperCapitalUsd / 2, config.maxCandidateTradeUsd);
        const samples = await trackLifecycle(() => quote(trackedInput), netProfit, sample => {
          store.record('opportunity_lifecycle', key, sample, { timestampMs: sample.completedMs, blockNumber: sample.quote?.blockNumber ?? null, source });
        });
        const summary = summarizeLifecycle(samples);
        store.record('opportunity_lifecycle', key, { best, summary }, { timestampMs: Date.now(), blockNumber: null, source });
        const initial = samples[0];
        if (initial.quote && initial.netProfitUsd !== null && initial.netProfitUsd >= config.minNetProfitUsd &&
          initial.quote.inputUsd + initial.quote.gasUsd + (initial.quote.extraCostsUsd ?? 0) <= config.paperCapitalUsd) opportunities++;
        console.log(json({ paperOnly: true, key, best, summary }));
      } catch (error) {
        store.record('executable_quotes', key, { status: 'unavailable', reason: String(error), route }, { timestampMs: Date.now(), blockNumber: null, source });
        console.warn(json({ key, quoteUnavailable: String(error) }));
      }
    }
  }
  console.log(json({ paperOnly: true, launches: launches.length, candidates, opportunities }));
}
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  console.log('arb-radar v0.2 — PAPER RESEARCH ONLY');
  if (await client.getChainId() !== robinhoodChain.id) throw new Error('Wrong RPC chain');
  do {
    try { await tick(); } catch (error) { console.error(String(error)); if (!process.argv.includes('--watch')) process.exitCode = 1; }
    if (!process.argv.includes('--watch') || stopping) break;
    await sleep(config.pollMs);
  } while (!stopping);
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { store.close(); }
