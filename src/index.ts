import { createPar, robinhoodChain } from 'par-sdk';
import { createPublicClient, http } from 'viem';
import { loadConfig } from './config.js';
import { Discovery } from './adapters/discovery.js';
import { resilientFetch, sleep } from './adapters/network.js';
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
import {
  prepareLaunchMixedCandidates,
  quotePreparedMixedCandidate,
  type MixedExecutionQuote,
  type PreparedMixedCandidate,
} from './economic/mixedEngine.js';
import { runDepthAwareSizing } from './economic/depth.js';
import { classifyV4QuoteError } from './economic/v4Truth.js';
import type { DirectedRoute, OptimizedOpportunity } from './domain.js';

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
  if(items.length===0) return [];
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

type TruthCandidate =
  | {
      kind:'v4';
      prepared:PreparedEconomicCandidate;
      discoveredAtMs:number;
      key:string;
      priorityBps:number;
      screenBlock:bigint;
    }
  | {
      kind:'mixed';
      prepared:PreparedMixedCandidate;
      discoveredAtMs:number;
      key:string;
      priorityBps:number;
      screenBlock:bigint;
    };

type RadarQuote = EconomicExecutionQuote | MixedExecutionQuote;

function candidateKey(kind:'v4'|'mixed', prepared:PreparedEconomicCandidate|PreparedMixedCandidate, screenBlock:bigint, discoveredAtMs:number):string {
  return [
    kind,
    prepared.launch.token,
    prepared.cycle.buyMarket,
    prepared.cycle.sellMarket,
    prepared.cycle.base,
    screenBlock.toString(),
    Math.floor(discoveredAtMs),
  ].join(':');
}

function optimizedFromQuote(route:DirectedRoute, quote:RadarQuote):OptimizedOpportunity|null {
  const net=quote.costBreakdown.netProfitUsd;
  if(net<config.minNetProfitUsd || net<=0) return null;
  if(quote.inputUsd+quote.gasUsd+(quote.extraCostsUsd??0)>config.paperCapitalUsd) return null;
  return {
    route,
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
  let mixedPairsConsidered=0;
  let mixedPairsQuoted=0;
  let mixedScreenFailures=0;

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
          note:'Indexer is discovery/seed metadata only; v0.10 executable truth comes from all-V4 StateView/atomic simulation or mixed canonical segmented quote + Universal Router parity',
        }), {timestampMs:Date.now(),blockNumber:screenBlock,source:'arb-radar:economic-truth'});
        for(const market of snapshot.markets){
          store.record('market_snapshots', `${snapshot.token}:${market.index}`, withRun(run,{market}), {
            timestampMs:Date.now(),blockNumber:screenBlock,source:config.parApiBase,
          });
        }

        const [preparedV4,mixedPrepared] = await Promise.all([
          prepareLaunchEconomicCandidates(client,meta,snapshot,ethValuation!.usdPerEth,{
            paperCapitalUsd:config.paperCapitalUsd,
            maxTradeUsd:config.maxCandidateTradeUsd,
            minTradeUsd:config.minCandidateTradeUsd,
            blockNumber:screenBlock,
          }),
          prepareLaunchMixedCandidates(client,meta,snapshot,ethValuation!.usdPerEth,{
            minTradeUsd:config.minCandidateTradeUsd,
            blockNumber:screenBlock,
            pairLimit:config.mixedPairLimitPerLaunch,
            probeConcurrency:config.mixedProbeConcurrency,
          }),
        ]);

        mixedPairsConsidered += mixedPrepared.pairsConsidered;
        mixedPairsQuoted += mixedPrepared.pairsQuoted;
        mixedScreenFailures += mixedPrepared.failures.length;

        const out:TruthCandidate[]=[];

        for(const item of preparedV4){
          const discoveredAtMs=monotonicClock.now();
          const key=candidateKey('v4',item,item.truth.blockNumber,discoveredAtMs);
          store.record('route_screens',key,withRun(run,{
            route:item.route,
            screen:item.screen,
            discoveredAtMs,
            enginePath:'all-v4-atomic-override',
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
          out.push({
            kind:'v4',
            prepared:item,
            discoveredAtMs,
            key,
            priorityBps:item.truth.infinitesimalEdgeBps,
            screenBlock:item.truth.blockNumber,
          });
        }

        for(const item of mixedPrepared.candidates){
          const discoveredAtMs=monotonicClock.now();
          const key=candidateKey('mixed',item,item.screenBlock,discoveredAtMs);
          store.record('route_screens',key,withRun(run,{
            route:item.route,
            screen:item.screen,
            discoveredAtMs,
            enginePath:'mixed-v3-v4-universal-router',
            economicTruth:{
              truthLevel:item.screen.truthLevel,
              screenBlock:item.screenBlock,
              base:item.cycle.base,
              baseSymbol:item.cycle.baseSymbol,
              hopCount:item.cycle.hopCount,
              v3HopCount:item.screen.v3HopCount,
              v4HopCount:item.screen.v4HopCount,
              exactProbeEdgeBps:item.screen.exactProbeEdgeBps,
            },
          }),{timestampMs:discoveredAtMs,blockNumber:item.screenBlock,source:'mixed-quoter:same-block-probe'});
          out.push({
            kind:'mixed',
            prepared:item,
            discoveredAtMs,
            key,
            priorityBps:item.priorityBps,
            screenBlock:item.screenBlock,
          });
        }

        return out;
      } catch(error){
        truthScanFailures++;
        console.warn(json({paperOnly:true,truthScanUnavailable:snapshot.token,error:String(error),screenBlock}));
        return [] as TruthCandidate[];
      }
    },
  );
  const candidates=perLaunch.flat();
  const v4Candidates=candidates.filter(c=>c.kind==='v4').length;
  const mixedCandidates=candidates.filter(c=>c.kind==='mixed').length;

  let runtimeMetrics: StageSchedulerMetrics = {
    queued:candidates.length,droppedStale:0,probesStarted:0,probesCompleted:0,
    sizingStarted:0,sizingCompleted:0,maxActiveProbes:0,maxActiveSizing:0,
  };

  const results=await runStagedCandidates(
    candidates.map(candidate=>({
      key:candidate.key,
      discoveredAtMs:candidate.discoveredAtMs,
      priority:candidate.priorityBps,
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
      const candidate=queued.value;
      const {prepared,discoveredAtMs,key}=candidate;
      const trackedInput=Math.min(config.minCandidateTradeUsd,config.paperCapitalUsd/2,config.maxCandidateTradeUsd);

      if(candidate.kind==='mixed'){
        const persistQuote=(quote:MixedExecutionQuote,phase:string)=>{
          store.record('executable_quotes',key,withRun(run,{
            discoveredAtMs,
            route:prepared.route,
            screen:prepared.screen,
            quote,
            netProfitUsd:quote.costBreakdown.netProfitUsd,
            costBreakdown:quote.costBreakdown,
            verifiedClosedCycle:quote.verifiedClosedCycle,
            atomicVerified:quote.atomicVerified,
            exactOutputParity:quote.exactOutputParity,
            engine:quote.engine,
            truthLevel:quote.truthLevel,
            phase,
            base:quote.base,
            baseSymbol:quote.baseSymbol,
            hopCount:quote.hopCount,
            v3HopCount:quote.v3HopCount,
            v4HopCount:quote.v4HopCount,
          }),{timestampMs:Date.now(),blockNumber:quote.blockNumber,source:'arb-radar:v0.10-mixed-atomic-paper'});
        };

        const {best,samples,timing}=await measureCandidate({
          discoveredAtMs,
          withProbePhase:controls.withProbePhase,
          beforeSizing:controls.waitForProbeStage,
          withSizingPhase:controls.withSizingPhase,
          prepare:async()=>prepared,
          quote:async context=>{
            const quote=await quotePreparedMixedCandidate(client,context,trackedInput,{
              fallbackExtraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,
            });
            persistQuote(quote,'probe-or-lifecycle');
            return quote;
          },
          size:async context=>{
            const sizingBlock=await client.getBlockNumber({cacheTime:0});
            const maxUsd=Math.min(config.paperCapitalUsd,config.maxCandidateTradeUsd);
            const depth=await runDepthAwareSizing({
              minUsd:config.minCandidateTradeUsd,
              maxUsd,
              quote:amount=>quotePreparedMixedCandidate(client,context,amount,{
                fallbackExtraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber:sizingBlock,
              }),
              score:quote=>quote.costBreakdown.netProfitUsd,
              grossPositive:quote=>quote.outputUsd>quote.inputUsd,
              classifyFailure:classifyV4QuoteError,
              onQuote:quote=>persistQuote(quote,'sizing-depth'),
              onFailure:failure=>store.record('opportunity_lifecycle',key,withRun(run,{
                discoveredAtMs,
                depthFailure:{phase:'mixed-sizing-depth',inputUsd:failure.inputUsd,...failure.failure},
                verifiedClosedCycle:true,
                atomicVerified:true,
                engine:'v0.10-mixed-route-coverage',
              }),{timestampMs:Date.now(),blockNumber:sizingBlock,source:'arb-radar:v0.10-mixed-atomic-paper'}),
            });
            const bestQuote=depth.bestQuote;
            const optimized=bestQuote?optimizedFromQuote(context.route,bestQuote):null;
            store.record('opportunity_lifecycle',key,withRun(run,{
              depthSizing:{
                minUsd:config.minCandidateTradeUsd,
                maxUsd,
                successfulQuotes:depth.quotes.length,
                failures:depth.failures.length,
                firstLiquidityFailureUsd:depth.firstLiquidityFailureUsd,
                stoppedReason:depth.stoppedReason,
                bestInputUsd:bestQuote?.inputUsd??null,
                bestNetProfitUsd:bestQuote?.costBreakdown.netProfitUsd??null,
              },
              verifiedClosedCycle:true,
              atomicVerified:true,
              engine:'v0.10-mixed-route-coverage',
            }),{timestampMs:Date.now(),blockNumber:sizingBlock,source:'arb-radar:v0.10-mixed-atomic-paper'});
            return optimized?{
              ...optimized,
              sizingMode:'mixed-depth-aware-exact',
              screenBlock:context.screenBlock,
              quoteBlock:sizingBlock,
              firstLiquidityFailureUsd:depth.firstLiquidityFailureUsd,
            }:null;
          },
          profit:q=>q.costBreakdown.netProfitUsd,
          shouldSize:q=>q.outputUsd>q.inputUsd,
          sizingSkipReason:'mixed-exact-probe-gross-nonpositive',
          recordSample:sample=>store.record('opportunity_lifecycle',key,withRun(run,{
            ...sample,trackedInputUsd:trackedInput,verifiedClosedCycle:true,atomicVerified:true,engine:'v0.10-mixed-route-coverage',
          }),{timestampMs:sample.completedMs,blockNumber:sample.quote?.blockNumber??null,source:'arb-radar:v0.10-mixed-atomic-paper'}),
          recordTiming:timing=>store.record('opportunity_lifecycle',key,withRun(run,{
            measurementTiming:timing,verifiedClosedCycle:true,atomicVerified:true,engine:'v0.10-mixed-route-coverage',
          }),{timestampMs:monotonicClock.now(),blockNumber:null,source:'arb-radar:v0.10-mixed-atomic-paper'}),
        });

        const summary=summarizeLifecycle(samples);
        store.record('opportunity_lifecycle',key,withRun(run,{
          best,summary,timing,trackedInputUsd:trackedInput,verifiedClosedCycle:true,atomicVerified:true,engine:'v0.10-mixed-route-coverage',
        }),{timestampMs:Date.now(),blockNumber:null,source:'arb-radar:v0.10-mixed-atomic-paper'});

        const initial=samples[0];
        const positive=!!best || !!(initial.quote && initial.netProfitUsd!==null &&
          initial.netProfitUsd>=config.minNetProfitUsd && initial.quote.green===true);
        console.log(json({
          paperOnly:true,verifiedClosedCycle:true,atomicVerified:true,engine:'v0.10-mixed-route-coverage',
          key,best,summary,timing,
          base:prepared.cycle.baseSymbol,hopCount:prepared.cycle.hopCount,
          v3HopCount:prepared.cycle.hops.filter(h=>h.v3).length,
          v4HopCount:prepared.cycle.hops.filter(h=>!h.v3).length,
          screenEdgeBps:prepared.screen.exactProbeEdgeBps,
        }));
        return {positive};
      }

      const persistQuote=(quote:EconomicExecutionQuote,phase:string)=>{
        store.record('executable_quotes',key,withRun(run,{
          discoveredAtMs,
          route:prepared.route,
          screen:prepared.screen,
          quote,
          netProfitUsd:quote.costBreakdown.netProfitUsd,
          costBreakdown:quote.costBreakdown,
          verifiedClosedCycle:true,
          atomicVerified:quote.atomicExecutor!==null,
          engine:quote.engine,
          truthLevel:quote.truthLevel,
          phase,
          base:quote.base,
          baseSymbol:quote.baseSymbol,
          hopCount:quote.hopCount,
        }),{timestampMs:Date.now(),blockNumber:quote.blockNumber,source:'arb-radar:v0.9-atomic-paper'});
      };

      const {best,samples,timing}=await measureCandidate({
        discoveredAtMs,
        withProbePhase:controls.withProbePhase,
        beforeSizing:controls.waitForProbeStage,
        withSizingPhase:controls.withSizingPhase,
        prepare:async()=>prepared,
        quote:async context=>{
          try{
            const quote=await quotePreparedEconomicCandidate(client,context,trackedInput,{
              extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,
            });
            persistQuote(quote,'probe-or-lifecycle');
            return quote;
          }catch(error){
            const failure=classifyV4QuoteError(error);
            store.record('opportunity_lifecycle',key,withRun(run,{
              discoveredAtMs,
              depthFailure:{phase:'probe-or-lifecycle',inputUsd:trackedInput,...failure},
              verifiedClosedCycle:true,
              engine:'v0.9-economic-truth-atomic-override',
            }),{timestampMs:Date.now(),blockNumber:null,source:'arb-radar:v0.9-atomic-paper'});
            throw error;
          }
        },
        size:async context=>{
          const sizingBlock=await client.getBlockNumber({cacheTime:0});
          const maxUsd=Math.min(config.paperCapitalUsd,config.maxCandidateTradeUsd);
          const depth=await runDepthAwareSizing({
            minUsd:config.minCandidateTradeUsd,
            maxUsd,
            extraAmountsUsd:context.seedTrusted?context.sizingAmountsUsd:[],
            quote:amount=>quotePreparedEconomicCandidate(client,context,amount,{
              extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber:sizingBlock,
            }),
            score:quote=>quote.costBreakdown.netProfitUsd,
            grossPositive:quote=>quote.outputUsd>quote.inputUsd,
            classifyFailure:classifyV4QuoteError,
            onQuote:quote=>persistQuote(quote,'sizing-depth'),
            onFailure:failure=>store.record('opportunity_lifecycle',key,withRun(run,{
              discoveredAtMs,
              depthFailure:{
                phase:'sizing-depth',
                inputUsd:failure.inputUsd,
                ...failure.failure,
              },
              verifiedClosedCycle:true,
              engine:'v0.9-economic-truth-atomic-override',
            }),{timestampMs:Date.now(),blockNumber:sizingBlock,source:'arb-radar:v0.9-atomic-paper'}),
          });
          const bestQuote=depth.bestQuote;
          const optimized=bestQuote?optimizedFromQuote(context.route,bestQuote):null;
          store.record('opportunity_lifecycle',key,withRun(run,{
            depthSizing:{
              minUsd:config.minCandidateTradeUsd,
              maxUsd,
              successfulQuotes:depth.quotes.length,
              failures:depth.failures.length,
              firstLiquidityFailureUsd:depth.firstLiquidityFailureUsd,
              stoppedReason:depth.stoppedReason,
              bestInputUsd:bestQuote?.inputUsd??null,
              bestNetProfitUsd:bestQuote?.costBreakdown.netProfitUsd??null,
            },
            verifiedClosedCycle:true,
            engine:'v0.9-economic-truth-atomic-override',
          }),{timestampMs:Date.now(),blockNumber:sizingBlock,source:'arb-radar:economic-truth'});
          return optimized?{
            ...optimized,
            sizingMode:'depth-aware-exact',
            screenBlock:context.truth.blockNumber,
            quoteBlock:sizingBlock,
            firstLiquidityFailureUsd:depth.firstLiquidityFailureUsd,
          }:null;
        },
        profit:q=>q.costBreakdown.netProfitUsd,
        shouldSize:q=>q.outputUsd>q.inputUsd,
        sizingSkipReason:'exact-depth-probe-gross-nonpositive',
        recordSample:sample=>store.record('opportunity_lifecycle',key,withRun(run,{
          ...sample,trackedInputUsd:trackedInput,verifiedClosedCycle:true,engine:'v0.9-economic-truth-atomic-override',
        }),{timestampMs:sample.completedMs,blockNumber:sample.quote?.blockNumber??null,source:'arb-radar:economic-truth'}),
        recordTiming:timing=>store.record('opportunity_lifecycle',key,withRun(run,{
          measurementTiming:timing,verifiedClosedCycle:true,engine:'v0.9-economic-truth-atomic-override',
        }),{timestampMs:monotonicClock.now(),blockNumber:null,source:'arb-radar:economic-truth'}),
      });

      const summary=summarizeLifecycle(samples);
      store.record('opportunity_lifecycle',key,withRun(run,{
        best,summary,timing,trackedInputUsd:trackedInput,verifiedClosedCycle:true,engine:'v0.9-economic-truth-atomic-override',
      }),{timestampMs:Date.now(),blockNumber:null,source:'arb-radar:economic-truth'});

      const initial=samples[0];
      const positive=!!best || !!(initial.quote && initial.netProfitUsd!==null &&
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
        engine:result.candidate.value.kind==='mixed'?'v0.10-mixed-route-coverage':'v0.9-economic-truth-atomic-override',
      }),{timestampMs:monotonicClock.now(),blockNumber:null,source:'arb-radar:economic-truth'});
      continue;
    }
    unavailable++;
    const {prepared,discoveredAtMs}=result.candidate.value;
    const mixed=result.candidate.value.kind==='mixed';
    store.record('executable_quotes',result.candidate.key,withRun(run,{
      status:'unavailable',
      reason:String(result.reason),
      route:prepared.route,
      screen:prepared.screen,
      discoveredAtMs,
      verifiedClosedCycle:false,
      engine:mixed?'v0.10-mixed-route-coverage':'v0.9-economic-truth-atomic-override',
    }),{timestampMs:Date.now(),blockNumber:null,source:mixed?'arb-radar:v0.10-mixed-atomic-paper':'arb-radar:economic-truth'});
    console.warn(json({key:result.candidate.key,truthQuoteUnavailable:String(result.reason),engine:mixed?'v0.10-mixed-route-coverage':'v0.9-economic-truth-atomic-override'}));
  }

  const tickCompletedMs=monotonicClock.now();
  store.record('radar_runtime',`tick:${Math.floor(tickStartedMs)}`,withRun(run,{
    tickStartedMs,tickCompletedMs,durationMs:tickCompletedMs-tickStartedMs,
    engine:'v0.10-mixed-route-coverage',
    screenBlock,
    launchesRequested:snapshots.length,
    metadataLoaded,
    truthPairsPotential,
    truthCandidates:candidates.length,
    v4Candidates,
    mixedCandidates,
    mixedPairsConsidered,
    mixedPairsQuoted,
    mixedScreenFailures,
    truthScanFailures,
    opportunities,
    unavailable,
    valuationFetches:snapshots.length?1:0,
    probeConcurrency:config.probeConcurrency,
    sizingConcurrency:config.sizingConcurrency,
    sizingQuoteConcurrency:config.sizingQuoteConcurrency,
    minCandidateTradeUsd:config.minCandidateTradeUsd,
    truthScanConcurrency:config.truthScanConcurrency,
    truthLaunchLimit:config.truthLaunchLimit,
    mixedPairLimitPerLaunch:config.mixedPairLimitPerLaunch,
    mixedProbeConcurrency:config.mixedProbeConcurrency,
    candidateMaxQueueMs:config.candidateMaxQueueMs,
    scheduler:runtimeMetrics,
  }),{timestampMs:tickCompletedMs,blockNumber:screenBlock,source:'arb-radar:economic-truth'});

  console.log(json({
    paperOnly:true,
    engine:'v0.10-mixed-route-coverage',
    runId:run.runId,
    screenBlock,
    launches:snapshots.length,
    metadataLoaded,
    truthPairsPotential,
    truthCandidates:candidates.length,
    v4Candidates,
    mixedCandidates,
    mixedPairsConsidered,
    mixedPairsQuoted,
    mixedScreenFailures,
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
