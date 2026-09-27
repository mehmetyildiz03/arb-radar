import { createPar, robinhoodChain } from 'par-sdk';
import { createPublicClient, http } from 'viem';
import { loadConfig } from './config.js';
import { Discovery } from './adapters/discovery.js';
import { resilientFetch, sleep } from './adapters/network.js';
import { optimizeRoute } from './arbitrage/optimizer.js';
import { ResearchStore, json } from './research/store.js';
import { monotonicClock, summarizeLifecycle } from './research/lifecycle.js';
import { measureCandidate } from './research/measurement.js';
import { createRunContext, withRun } from './research/run.js';
import {
  runStagedCandidates,
  StaleCandidateError,
  type StageSchedulerMetrics,
} from './research/scheduler.js';
import {
  prepareLaunchEconomicCandidates,
  quotePreparedEconomicCandidate,
  type EconomicExecutionQuote,
  type PreparedEconomicCandidate,
} from './economic/engine.js';
import type { OptimizedOpportunity } from './domain.js';

const config = loadConfig();
const run = createRunContext();
const store = new ResearchStore(process.env.RADAR_DB ?? 'data/radar.sqlite');
store.record('radar_runs', run.runId, run, { timestampMs: run.runStartedAtMs, blockNumber: null, source: 'arb-radar:run' });

const source = config.robinhoodRpcUrl;
const readMethods = new Set([
  'eth_call','eth_estimateGas','eth_blockNumber','eth_getBlockByNumber','eth_gasPrice',
  'eth_chainId','eth_getCode','eth_getLogs','eth_getTransactionReceipt',
]);
const rpcFetch: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (Array.isArray(body) || !readMethods.has(body.method)) throw new Error('Non-read RPC method blocked');
  const started = Date.now(); let status = 'error';
  const blockParam = ['eth_call','eth_estimateGas'].includes(body.method)
    ? body.params?.[1]
    : body.method === 'eth_getBlockByNumber' ? body.params?.[0] : undefined;
  const blockNumber = typeof blockParam === 'string' && /^0x[0-9a-f]+$/i.test(blockParam) ? BigInt(blockParam) : null;
  try {
    const response = await resilientFetch()(url, init);
    const result = await response.clone().json() as { error?: { code?: number } };
    status = result.error ? `rpc-error:${result.error.code}` : String(response.status);
    return response;
  } finally {
    store.record(
      'rpc_latency_samples',
      body.method,
      withRun(run, { durationMs: Date.now() - started, status, params: body.params }),
      { timestampMs: started, blockNumber, source },
    );
  }
};

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(source, { fetchFn: rpcFetch, retryCount: 0, timeout: 15_000 }),
});
const discovery = new Discovery(createPar({ client }), config.parApiBase);

async function valuation(): Promise<{ usdPerEth:number; timestampMs:number; source:string }> {
  const started = Date.now();
  const response = await resilientFetch()('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if (!response.ok) throw new Error(`ETH/USD unavailable: ${response.status}`);
  const body = await response.json() as { data?: { amount?: string; base?: string; currency?: string } };
  const usdPerEth = Number(body.data?.amount);
  if (!Number.isFinite(usdPerEth) || usdPerEth <= 0 || body.data?.base !== 'ETH' || body.data.currency !== 'USD') {
    throw new Error('Invalid ETH/USD');
  }
  return { usdPerEth, timestampMs: started, source: 'coinbase:ETH-USD/spot (valuation only)' };
}

async function mapBounded<T,R>(items:readonly T[], concurrency:number, worker:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  const out=new Array<R>(items.length);
  let next=0;
  async function runner(){
    while(true){
      const index=next++;
      if(index>=items.length) return;
      out[index]=await worker(items[index]!,index);
    }
  }
  await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),items.length)},()=>runner()));
  return out;
}

interface TruthCandidate {
  prepared: PreparedEconomicCandidate;
  discoveredAtMs: number;
  key: string;
}

function candidateKey(prepared:PreparedEconomicCandidate, discoveredAtMs:number):string {
  return [
    prepared.launch.token,
    prepared.cycle.buyMarket,
    prepared.cycle.sellMarket,
    prepared.cycle.base,
    prepared.truth.blockNumber.toString(),
    Math.floor(discoveredAtMs),
  ].join(':');
}

function optimizedFromQuote(prepared:PreparedEconomicCandidate, quote:EconomicExecutionQuote):OptimizedOpportunity|null {
  const net=quote.costBreakdown.netProfitUsd;
  if(net<config.minNetProfitUsd || net<=0) return null;
  if(quote.inputUsd+quote.gasUsd+(quote.extraCostsUsd??0)>config.paperCapitalUsd) return null;
  return {
    route:prepared.route,
    inputUsd:quote.inputUsd,
    outputUsd:quote.outputUsd,
    gasUsd:quote.gasUsd,
    extraCostsUsd:(quote.extraCostsUsd??0)+(quote.safetyMarginUsd??0),
    netProfitUsd:net,
    netReturnPct:quote.costBreakdown.netReturnPct,
  };
}

async function tick(): Promise<void> {
  const tickStartedMs = monotonicClock.now();
  const snapshots = await discovery.latest(config.truthLaunchLimit);
  const screenBlock = await client.getBlockNumber({ cacheTime: 0 });
  const ethValuation = snapshots.length ? await valuation() : null;

  let metadataLoaded=0;
  let truthPairsPotential=0;
  let truthScanFailures=0;

  const perLaunch = await mapBounded(
    snapshots,
    config.truthScanConcurrency,
    async snapshot => {
      try {
        const meta=await discovery.metadata(snapshot.token);
        if(!meta || meta.kind!=='multi') return [] as TruthCandidate[];
        metadataLoaded++;
        truthPairsPotential += meta.markets.length*(meta.markets.length-1);

        store.record('launches', snapshot.token, withRun(run, {
          snapshot,
          metadata:meta,
          note:'Indexer is discovery/seed metadata only; executable direction comes from same-block onchain state',
        }), {timestampMs:Date.now(),blockNumber:screenBlock,source:'arb-radar:economic-truth'});
        for(const market of snapshot.markets){
          store.record('market_snapshots', `${snapshot.token}:${market.index}`, withRun(run,{market}), {
            timestampMs:Date.now(),blockNumber:screenBlock,source:config.parApiBase,
          });
        }

        const prepared=await prepareLaunchEconomicCandidates(client,meta,snapshot,ethValuation!.usdPerEth,{
          paperCapitalUsd:config.paperCapitalUsd,
          maxTradeUsd:config.maxCandidateTradeUsd,
          minTradeUsd:1,
          blockNumber:screenBlock,
        });
        return prepared.map(item=>{
          const discoveredAtMs=monotonicClock.now();
          const key=candidateKey(item,discoveredAtMs);
          store.record('route_screens',key,withRun(run,{
            route:item.route,
            screen:item.screen,
            discoveredAtMs,
            economicTruth:{
              truthLevel:item.screen.truthLevel,
              screenBlock:item.truth.blockNumber,
              base:item.cycle.base,
              baseSymbol:item.cycle.baseSymbol,
              hopCount:item.cycle.hopCount,
              infinitesimalEdgeBps:item.truth.infinitesimalEdgeBps,
              seedTrusted:item.seedTrusted,
              seedUsd:item.seedUsd,
            },
          }),{timestampMs:discoveredAtMs,blockNumber:item.truth.blockNumber,source:'stateview:same-block-v4'});
          return {prepared:item,discoveredAtMs,key};
        });
      } catch(error){
        truthScanFailures++;
        console.warn(json({paperOnly:true,truthScanUnavailable:snapshot.token,error:String(error),screenBlock}));
        return [] as TruthCandidate[];
      }
    },
  );
  const candidates=perLaunch.flat();

  let runtimeMetrics: StageSchedulerMetrics = {
    queued:candidates.length,droppedStale:0,probesStarted:0,probesCompleted:0,
    sizingStarted:0,sizingCompleted:0,maxActiveProbes:0,maxActiveSizing:0,
  };

  const results=await runStagedCandidates(
    candidates.map(candidate=>({
      key:candidate.key,
      discoveredAtMs:candidate.discoveredAtMs,
      priority:candidate.prepared.truth.infinitesimalEdgeBps,
      value:candidate,
    })),
    {
      probeConcurrency:config.probeConcurrency,
      sizingConcurrency:config.sizingConcurrency,
      maxQueueAgeMs:config.candidateMaxQueueMs,
      now:monotonicClock.now,
      onMetrics:metrics=>{runtimeMetrics=metrics;},
    },
    async(queued,controls)=>{
      const {prepared,discoveredAtMs,key}=queued.value;
      const trackedInput=Math.min(1,config.paperCapitalUsd/2,config.maxCandidateTradeUsd);

      const persistQuote=(quote:EconomicExecutionQuote,phase:string)=>{
        store.record('executable_quotes',key,withRun(run,{
          discoveredAtMs,
          route:prepared.route,
          screen:prepared.screen,
          quote,
          netProfitUsd:quote.costBreakdown.netProfitUsd,
          costBreakdown:quote.costBreakdown,
          verifiedClosedCycle:true,
          engine:quote.engine,
          truthLevel:quote.truthLevel,
          phase,
          base:quote.base,
          baseSymbol:quote.baseSymbol,
          hopCount:quote.hopCount,
        }),{timestampMs:Date.now(),blockNumber:quote.blockNumber,source:'uniswap:v4-quoter'});
      };

      const {best,samples,timing}=await measureCandidate({
        discoveredAtMs,
        withProbePhase:controls.withProbePhase,
        beforeSizing:controls.waitForProbeStage,
        withSizingPhase:controls.withSizingPhase,
        prepare:async()=>prepared,
        quote:async context=>{
          const quote=await quotePreparedEconomicCandidate(client,context,trackedInput,{
            extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,
          });
          persistQuote(quote,'probe-or-lifecycle');
          return quote;
        },
        size:async context=>{
          const sizingBlock=await client.getBlockNumber({cacheTime:0});
          const completed:EconomicExecutionQuote[]=[];
          let sizingMode:'analytic-seed-exact'|'exact-grid-fallback'='exact-grid-fallback';

          if(context.seedTrusted&&context.sizingAmountsUsd.length){
            const seeded=await mapBounded(
              context.sizingAmountsUsd,
              Math.min(config.sizingQuoteConcurrency,context.sizingAmountsUsd.length),
              amount=>quotePreparedEconomicCandidate(client,context,amount,{
                extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber:sizingBlock,
              }),
            );
            completed.push(...seeded);
            const bestSeed=[...seeded].sort((a,b)=>b.costBreakdown.netProfitUsd-a.costBreakdown.netProfitUsd)[0];
            if(bestSeed && optimizedFromQuote(context,bestSeed)){
              for(const quote of seeded) persistQuote(quote,'sizing-seed');
              sizingMode='analytic-seed-exact';
              return {...optimizedFromQuote(context,bestSeed)!,sizingMode,screenBlock:context.truth.blockNumber,quoteBlock:sizingBlock};
            }
          }

          const gridQuotes:EconomicExecutionQuote[]=[];
          const bestGrid=await optimizeRoute(context.route,async(_route,amount)=>{
            const quote=await quotePreparedEconomicCandidate(client,context,amount,{
              extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber:sizingBlock,
            });
            gridQuotes.push(quote);
            return quote;
          },{
            capitalUsd:config.paperCapitalUsd,
            maxTradeUsd:config.maxCandidateTradeUsd,
            steps:8,
            minNetProfitUsd:config.minNetProfitUsd,
            quoteConcurrency:config.sizingQuoteConcurrency,
          });
          completed.push(...gridQuotes);
          completed.sort((a,b)=>a.inputUsd-b.inputUsd);
          for(const quote of completed) persistQuote(quote,'sizing-grid');
          return bestGrid?{...bestGrid,sizingMode,screenBlock:context.truth.blockNumber,quoteBlock:sizingBlock}:null;
        },
        profit:q=>q.costBreakdown.netProfitUsd,
        recordSample:sample=>store.record('opportunity_lifecycle',key,withRun(run,{
          ...sample,trackedInputUsd:trackedInput,verifiedClosedCycle:true,engine:'v0.8-economic-truth',
        }),{timestampMs:sample.completedMs,blockNumber:sample.quote?.blockNumber??null,source:'arb-radar:economic-truth'}),
        recordTiming:timing=>store.record('opportunity_lifecycle',key,withRun(run,{
          measurementTiming:timing,verifiedClosedCycle:true,engine:'v0.8-economic-truth',
        }),{timestampMs:monotonicClock.now(),blockNumber:null,source:'arb-radar:economic-truth'}),
      });

      const summary=summarizeLifecycle(samples);
      store.record('opportunity_lifecycle',key,withRun(run,{
        best,summary,timing,trackedInputUsd:trackedInput,verifiedClosedCycle:true,engine:'v0.8-economic-truth',
      }),{timestampMs:Date.now(),blockNumber:null,source:'arb-radar:economic-truth'});

      const initial=samples[0];
      const positive=!!(initial.quote && initial.netProfitUsd!==null &&
        initial.netProfitUsd>=config.minNetProfitUsd && initial.quote.green===true);
      console.log(json({
        paperOnly:true,verifiedClosedCycle:true,key,best,summary,timing,
        base:prepared.cycle.baseSymbol,hopCount:prepared.cycle.hopCount,
        infinitesimalEdgeBps:prepared.truth.infinitesimalEdgeBps,
      }));
      return {positive};
    },
  );

  let opportunities=0;
  let unavailable=0;
  for(const result of results){
    if(result.status==='fulfilled'){
      if(result.value.positive) opportunities++;
      continue;
    }
    if(result.reason instanceof StaleCandidateError){
      store.record('opportunity_lifecycle',result.candidate.key,withRun(run,{
        status:'dropped-stale-before-probe',
        ageMs:result.reason.ageMs,
        maxAgeMs:result.reason.maxAgeMs,
        verifiedClosedCycle:false,
      }),{timestampMs:monotonicClock.now(),blockNumber:null,source:'arb-radar:economic-truth'});
      continue;
    }
    unavailable++;
    const {prepared,discoveredAtMs}=result.candidate.value;
    store.record('executable_quotes',result.candidate.key,withRun(run,{
      status:'unavailable',
      reason:String(result.reason),
      route:prepared.route,
      screen:prepared.screen,
      discoveredAtMs,
      verifiedClosedCycle:false,
      engine:'v0.8-economic-truth',
    }),{timestampMs:Date.now(),blockNumber:null,source:'arb-radar:economic-truth'});
    console.warn(json({key:result.candidate.key,truthQuoteUnavailable:String(result.reason)}));
  }

  const tickCompletedMs=monotonicClock.now();
  store.record('radar_runtime',`tick:${Math.floor(tickStartedMs)}`,withRun(run,{
    tickStartedMs,tickCompletedMs,durationMs:tickCompletedMs-tickStartedMs,
    engine:'v0.8-economic-truth',
    screenBlock,
    launchesRequested:snapshots.length,
    metadataLoaded,
    truthPairsPotential,
    truthCandidates:candidates.length,
    truthScanFailures,
    opportunities,
    unavailable,
    valuationFetches:snapshots.length?1:0,
    probeConcurrency:config.probeConcurrency,
    sizingConcurrency:config.sizingConcurrency,
    sizingQuoteConcurrency:config.sizingQuoteConcurrency,
    truthScanConcurrency:config.truthScanConcurrency,
    truthLaunchLimit:config.truthLaunchLimit,
    candidateMaxQueueMs:config.candidateMaxQueueMs,
    scheduler:runtimeMetrics,
  }),{timestampMs:tickCompletedMs,blockNumber:screenBlock,source:'arb-radar:economic-truth'});

  console.log(json({
    paperOnly:true,
    engine:'v0.8-economic-truth',
    runId:run.runId,
    screenBlock,
    launches:snapshots.length,
    metadataLoaded,
    truthPairsPotential,
    truthCandidates:candidates.length,
    truthScanFailures,
    opportunities,
    unavailable,
    scheduler:runtimeMetrics,
    tickDurationMs:tickCompletedMs-tickStartedMs,
  }));
}

let stopping=false;
process.on('SIGINT',()=>{stopping=true;});
process.on('SIGTERM',()=>{stopping=true;});
try{
  console.log(`arb-radar ${run.engineVersion} — PAPER RESEARCH ONLY — run ${run.runId}`);
  if(await client.getChainId()!==robinhoodChain.id) throw new Error('Wrong RPC chain');
  do{
    try{await tick();}
    catch(error){
      console.error(String(error));
      if(!process.argv.includes('--watch')) process.exitCode=1;
    }
    if(!process.argv.includes('--watch')||stopping) break;
    await sleep(config.pollMs);
  }while(!stopping);
}catch(error){
  console.error(String(error));
  process.exitCode=1;
}finally{
  store.close();
}
