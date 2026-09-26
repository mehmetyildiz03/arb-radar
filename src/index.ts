import { createPar, robinhoodChain } from 'par-sdk';
import { createPublicClient, http } from 'viem';
import { loadConfig } from './config.js';
import { Discovery } from './adapters/discovery.js';
import { resilientFetch, sleep } from './adapters/network.js';
import { simulateRoute, netProfit, type Valuation } from './adapters/simulation.js';
import { enumerateDirectedRoutes, screenRoute } from './arbitrage/routes.js';
import { optimizeRoute } from './arbitrage/optimizer.js';
import { ResearchStore, json } from './research/store.js';
import { monotonicClock, summarizeLifecycle } from './research/lifecycle.js';
import { measureCandidate } from './research/measurement.js';
import { quoteCostBreakdown } from './research/costs.js';
import {
  runStagedCandidates,
  sharedAsyncResource,
  StaleCandidateError,
  type StageSchedulerMetrics,
} from './research/scheduler.js';
import type { DirectedRoute, LaunchSnapshot, RouteScreen } from './domain.js';

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

interface ScreenedCandidate {
  launch: LaunchSnapshot;
  route: DirectedRoute;
  screen: RouteScreen;
  discoveredAtMs: number;
  key: string;
}

function candidateKey(candidate: Omit<ScreenedCandidate,'key'>): string {
  return `${candidate.launch.token}:${candidate.route.buy.index}:${candidate.route.sell.index}:${Math.floor(candidate.discoveredAtMs)}`;
}

async function tick(): Promise<void> {
  const tickStartedMs = monotonicClock.now();
  const launches = await discovery.latest();
  const screened = launches.map(launch => ({
    launch,
    screens: enumerateDirectedRoutes(launch).map(route => {
      const discoveredAtMs = monotonicClock.now();
      return { route, discoveredAtMs, screen: screenRoute(route, 0, { nowMs: discoveredAtMs, maxAgeMs: config.recentWindowSeconds * 1000 }) };
    }),
  }));

  const candidates: ScreenedCandidate[] = [];
  for (const { launch, screens } of screened) {
    const provenance = { timestampMs: Date.now(), blockNumber: null, source: config.parApiBase };
    store.record('launches', launch.token, launch, provenance);
    for (const market of launch.markets) store.record('market_snapshots', `${launch.token}:${market.index}`, market, provenance);
    for (const { route, screen, discoveredAtMs } of screens) {
      store.record('route_screens', `${launch.token}:${route.buy.index}:${route.sell.index}`, { route, screen, discoveredAtMs, rejected: screen === null }, { ...provenance, timestampMs: discoveredAtMs });
      if (screen?.passesFeeFloor) {
        const base = { launch, route, screen, discoveredAtMs };
        candidates.push({ ...base, key: candidateKey(base) });
      }
    }
  }

  let runtimeMetrics: StageSchedulerMetrics = {
    queued: candidates.length,
    droppedStale: 0,
    probesStarted: 0,
    probesCompleted: 0,
    sizingStarted: 0,
    sizingCompleted: 0,
    maxActiveProbes: 0,
    maxActiveSizing: 0,
  };
  let valuationFetches = 0;
  const getValuation = sharedAsyncResource(async () => {
    valuationFetches++;
    return valuation();
  });

  const results = await runStagedCandidates(
    candidates.map(candidate => ({
      key: candidate.key,
      discoveredAtMs: candidate.discoveredAtMs,
      priority: candidate.screen.feeAdjustedReturnPct,
      value: candidate,
    })),
    {
      probeConcurrency: config.probeConcurrency,
      sizingConcurrency: config.sizingConcurrency,
      maxQueueAgeMs: config.candidateMaxQueueMs,
      now: monotonicClock.now,
      onMetrics: metrics => { runtimeMetrics = metrics; },
    },
    async (queued, controls) => {
      const candidate = queued.value;
      const { launch, route, screen, discoveredAtMs, key } = candidate;
      const trackedInput = Math.min(1, config.paperCapitalUsd / 2, config.maxCandidateTradeUsd);

      const { best, samples, timing } = await measureCandidate({
        discoveredAtMs,
        withProbePhase: controls.withProbePhase,
        beforeSizing: controls.waitForProbeStage,
        withSizingPhase: controls.withSizingPhase,
        prepare: async () => {
          const [meta, value] = await Promise.all([
            discovery.metadata(launch.token),
            getValuation(),
          ]);
          if (!meta) throw new Error('No RPC metadata');
          store.record('launches', launch.token, { metadata: meta, note: 'SDK metadata reads; not an atomic state snapshot' }, { timestampMs: Date.now(), blockNumber: null, source });
          return async (amount: number, fixedBlock?: bigint) => {
            const q = await simulateRoute(client, meta, route, amount, value, { extraCostsUsd: 0.05, safetyBps: 100, source, blockNumber: fixedBlock });
            const costBreakdown = quoteCostBreakdown(q);
            store.record('executable_quotes', key, { discoveredAtMs, route, quote: q, netProfitUsd: costBreakdown.netProfitUsd, costBreakdown, screen }, q);
            return q;
          };
        },
        quote: quote => quote(trackedInput),
        size: async quote => {
          const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
          return optimizeRoute(route, (_r, amount) => quote(amount, blockNumber), {
            capitalUsd: config.paperCapitalUsd,
            maxTradeUsd: config.maxCandidateTradeUsd,
            steps: 8,
            minNetProfitUsd: config.minNetProfitUsd,
            quoteConcurrency: config.sizingQuoteConcurrency,
          });
        },
        profit: netProfit,
        recordSample: sample => store.record('opportunity_lifecycle', key, { ...sample, trackedInputUsd: trackedInput }, { timestampMs: sample.completedMs, blockNumber: sample.quote?.blockNumber ?? null, source }),
        recordTiming: timing => store.record('opportunity_lifecycle', key, { measurementTiming: timing }, { timestampMs: monotonicClock.now(), blockNumber: null, source }),
      });

      const summary = summarizeLifecycle(samples);
      store.record('opportunity_lifecycle', key, { best, summary, timing, trackedInputUsd: trackedInput }, { timestampMs: Date.now(), blockNumber: null, source });
      const initial = samples[0];
      const positive = !!(initial.quote && initial.netProfitUsd !== null && initial.netProfitUsd >= config.minNetProfitUsd &&
        initial.quote.inputUsd + initial.quote.gasUsd + (initial.quote.extraCostsUsd ?? 0) <= config.paperCapitalUsd);
      console.log(json({ paperOnly: true, key, best, summary, timing, trackedInputUsd: trackedInput }));
      return { positive };
    },
  );

  let opportunities = 0;
  let unavailable = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.positive) opportunities++;
      continue;
    }
    if (result.reason instanceof StaleCandidateError) {
      store.record('opportunity_lifecycle', result.candidate.key, {
        status: 'dropped-stale-before-probe',
        ageMs: result.reason.ageMs,
        maxAgeMs: result.reason.maxAgeMs,
      }, { timestampMs: monotonicClock.now(), blockNumber: null, source });
      continue;
    }
    unavailable++;
    const route = result.candidate.value.route;
    store.record('executable_quotes', result.candidate.key, {
      status: 'unavailable',
      reason: String(result.reason),
      route,
      discoveredAtMs: result.candidate.discoveredAtMs,
    }, { timestampMs: Date.now(), blockNumber: null, source });
    console.warn(json({ key: result.candidate.key, quoteUnavailable: String(result.reason) }));
  }

  const tickCompletedMs = monotonicClock.now();
  store.record('radar_runtime', `tick:${Math.floor(tickStartedMs)}`, {
    tickStartedMs,
    tickCompletedMs,
    durationMs: tickCompletedMs - tickStartedMs,
    launches: launches.length,
    candidates: candidates.length,
    opportunities,
    unavailable,
    valuationFetches,
    probeConcurrency: config.probeConcurrency,
    sizingConcurrency: config.sizingConcurrency,
    sizingQuoteConcurrency: config.sizingQuoteConcurrency,
    candidateMaxQueueMs: config.candidateMaxQueueMs,
    scheduler: runtimeMetrics,
  }, { timestampMs: tickCompletedMs, blockNumber: null, source: 'arb-radar:scheduler' });

  console.log(json({
    paperOnly: true,
    launches: launches.length,
    candidates: candidates.length,
    opportunities,
    unavailable,
    scheduler: runtimeMetrics,
    tickDurationMs: tickCompletedMs - tickStartedMs,
  }));
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  console.log('arb-radar v0.5 — PAPER RESEARCH ONLY');
  if (await client.getChainId() !== robinhoodChain.id) throw new Error('Wrong RPC chain');
  do {
    try { await tick(); } catch (error) { console.error(String(error)); if (!process.argv.includes('--watch')) process.exitCode = 1; }
    if (!process.argv.includes('--watch') || stopping) break;
    await sleep(config.pollMs);
  } while (!stopping);
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { store.close(); }
