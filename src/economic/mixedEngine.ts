import {
  formatEther,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { getReference, robinhoodChain, type TradableLaunch } from 'par-sdk';
import type { DirectedRoute, ExecutionQuote, LaunchSnapshot, RouteScreen } from '../domain.js';
import { quoteCostBreakdown, type QuoteCostBreakdown } from '../research/costs.js';
import { calibrateResearchCost, type ExecutionGasSource, type NitroFeeComponents, type ResearchCostMode } from './nitroFees.js';
import { enumerateClosedCycles, type ClosedCycle } from './v4Truth.js';
import { quoteMixedCycle, type MixedCycleQuote } from './mixedQuote.js';
import {
  ROBINHOOD_UNIVERSAL_ROUTER,
  simulateUniversalMixedParity,
  type UniversalMixedAtomicSimulation,
} from './universalMixed.js';

export interface MixedEconomicScreen extends RouteScreen {
  source: 'same-block-mixed-exact-probe';
  blockNumber: bigint;
  base: Address;
  baseSymbol: string;
  hopCount: number;
  v3HopCount: number;
  v4HopCount: number;
  exactProbeInputRaw: bigint;
  exactProbeOutputRaw: bigint;
  exactProbeEdgeBps: number;
  truthLevel: 'same-block-mixed-segment-quote';
}

export interface PreparedMixedCandidate {
  launch: TradableLaunch;
  snapshot: LaunchSnapshot;
  route: DirectedRoute;
  cycle: ClosedCycle;
  screen: MixedEconomicScreen;
  screenQuote: MixedCycleQuote;
  screenBlock: bigint;
  baseDecimals: 18;
  baseUsdPrice: number;
  ethUsdPrice: number;
  priorityBps: number;
}

export interface MixedExecutionQuote extends ExecutionQuote {
  kind: 'mixed-v3-v4-universal-router-atomic-paper';
  engine: 'v0.10-mixed-route-coverage';
  truthLevel: 'universal-router-state-override';
  verifiedClosedCycle: true;
  atomicVerified: true;
  exactOutputParity: true;
  blockNumber: bigint;
  base: Address;
  baseSymbol: string;
  baseDecimals: 18;
  hopCount: number;
  v3HopCount: number;
  v4HopCount: number;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  segmentedGasEstimateProxy: bigint;
  universalRouter: UniversalMixedAtomicSimulation;
  gasUnitsResearch: bigint;
  gasPriceWei: bigint;
  costModel: ResearchCostMode;
  executionGasSource: ExecutionGasSource;
  nitroFee: NitroFeeComponents | null;
  costFallbackReason: string | null;
  screenEdgeBps: number;
  costBreakdown: QuoteCostBreakdown;
  green: boolean;
  assumptions: string[];
}

export interface MixedPreparationResult {
  candidates: PreparedMixedCandidate[];
  pairsConsidered: number;
  pairsQuoted: number;
  failures: Array<{buyMarket:number;sellMarket:number;error:string}>;
}

function same(a:Address,b:Address):boolean {
  return a.toLowerCase()===b.toLowerCase();
}

function marketSnapshot(snapshot:LaunchSnapshot,index:number) {
  return snapshot.markets.find(m=>m.index===index) ?? snapshot.markets[index];
}

function directedRoute(snapshot:LaunchSnapshot,buyIndex:number,sellIndex:number):DirectedRoute {
  const buy=marketSnapshot(snapshot,buyIndex);
  const sell=marketSnapshot(snapshot,sellIndex);
  if(!buy||!sell) throw new Error('Missing discovery market');
  return {token:snapshot.token,buy,sell,poolFeeUnits:snapshot.poolFeeUnits};
}

function indexerPriority(snapshot:LaunchSnapshot,buyIndex:number,sellIndex:number):number {
  const buy=marketSnapshot(snapshot,buyIndex)?.tokenPriceEth;
  const sell=marketSnapshot(snapshot,sellIndex)?.tokenPriceEth;
  if(typeof buy!=='number'||typeof sell!=='number'||!Number.isFinite(buy)||!Number.isFinite(sell)||buy<=0||sell<=0) return -1e12;
  return ((sell/buy)-1)*10_000;
}

function rawWethForUsd(inputUsd:number,ethUsdPrice:number):bigint {
  if(!Number.isFinite(inputUsd)||inputUsd<=0||!Number.isFinite(ethUsdPrice)||ethUsdPrice<=0) throw new Error('Invalid mixed paper input');
  const human=inputUsd/ethUsdPrice;
  const raw=parseUnits(human.toFixed(18),18);
  if(raw<=0n) throw new Error('Mixed paper input rounds to zero');
  return raw;
}

function ratio(amountOut:bigint,amountIn:bigint):number {
  const scaled=Number(amountOut*1_000_000_000n/amountIn)/1_000_000_000;
  if(!Number.isFinite(scaled)||scaled<=0) throw new Error('Invalid mixed quote ratio');
  return scaled;
}

function isSupportedMixed(cycle:ClosedCycle,weth:Address):boolean {
  return same(cycle.base,weth) &&
    cycle.hops.some(h=>h.v3) &&
    cycle.hops.some(h=>!h.v3) &&
    cycle.hops.every(h=>h.v3||same(h.key.hooks,zeroAddress));
}

async function mapBounded<T,R>(
  items:readonly T[],
  concurrency:number,
  worker:(item:T,index:number)=>Promise<R>,
):Promise<R[]> {
  if(items.length===0)return [];
  const out=new Array<R>(items.length);
  let next=0;
  async function runner(){
    while(true){
      const index=next++;
      if(index>=items.length)return;
      out[index]=await worker(items[index]!,index);
    }
  }
  await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,concurrency))},()=>runner()));
  return out;
}

export async function prepareLaunchMixedCandidates(
  client:PublicClient,
  launch:TradableLaunch,
  snapshot:LaunchSnapshot,
  ethUsdPrice:number,
  options:{minTradeUsd:number;blockNumber:bigint;pairLimit:number;probeConcurrency:number},
):Promise<MixedPreparationResult> {
  if(launch.kind!=='multi'||launch.markets.length<2) {
    return {candidates:[],pairsConsidered:0,pairsQuoted:0,failures:[]};
  }
  const weth=getReference(robinhoodChain.id).wrapped;
  const pairs:Array<{buy:number;sell:number;cycle:ClosedCycle;priority:number}>=[];
  let pairsConsidered=0;

  for(const buy of launch.markets){
    for(const sell of launch.markets){
      if(buy.index===sell.index)continue;
      const all=enumerateClosedCycles(launch,buy.index,sell.index);
      if(all.some(c=>c.allV4&&c.hooklessV4))continue;
      const mixed=all.filter(c=>isSupportedMixed(c,weth))
        .sort((a,b)=>a.hopCount-b.hopCount||a.base.toLowerCase().localeCompare(b.base.toLowerCase()));
      if(!mixed.length)continue;
      pairsConsidered++;
      pairs.push({
        buy:buy.index,
        sell:sell.index,
        cycle:mixed[0]!,
        priority:indexerPriority(snapshot,buy.index,sell.index),
      });
    }
  }

  pairs.sort((a,b)=>
    b.priority-a.priority ||
    a.cycle.hopCount-b.cycle.hopCount ||
    a.buy-b.buy ||
    a.sell-b.sell);
  const selected=pairs.slice(0,Math.max(1,options.pairLimit));
  const amountIn=rawWethForUsd(options.minTradeUsd,ethUsdPrice);
  const failures:Array<{buyMarket:number;sellMarket:number;error:string}>=[];

  const quoted=await mapBounded(selected,options.probeConcurrency,async pair=>{
    try{
      const screenQuote=await quoteMixedCycle(client,pair.cycle,amountIn,options.blockNumber);
      if(screenQuote.amountOut<=screenQuote.amountIn)return null;
      const r=ratio(screenQuote.amountOut,screenQuote.amountIn);
      const edgeBps=(r-1)*10_000;
      const route=directedRoute(snapshot,pair.buy,pair.sell);
      const screen:MixedEconomicScreen={
        route,
        grossPriceRatio:r,
        grossSpreadPct:(r-1)*100,
        feeAdjustedReturnPct:(r-1)*100,
        passesFeeFloor:true,
        source:'same-block-mixed-exact-probe',
        blockNumber:options.blockNumber,
        base:pair.cycle.base,
        baseSymbol:pair.cycle.baseSymbol,
        hopCount:pair.cycle.hopCount,
        v3HopCount:pair.cycle.hops.filter(h=>h.v3).length,
        v4HopCount:pair.cycle.hops.filter(h=>!h.v3).length,
        exactProbeInputRaw:screenQuote.amountIn,
        exactProbeOutputRaw:screenQuote.amountOut,
        exactProbeEdgeBps:edgeBps,
        truthLevel:'same-block-mixed-segment-quote',
      };
      return {
        launch,
        snapshot,
        route,
        cycle:pair.cycle,
        screen,
        screenQuote,
        screenBlock:options.blockNumber,
        baseDecimals:18 as const,
        baseUsdPrice:ethUsdPrice,
        ethUsdPrice,
        priorityBps:edgeBps,
      } satisfies PreparedMixedCandidate;
    }catch(error){
      failures.push({buyMarket:pair.buy,sellMarket:pair.sell,error:String(error)});
      return null;
    }
  });

  return {
    candidates:quoted.filter((x):x is PreparedMixedCandidate=>x!==null),
    pairsConsidered,
    pairsQuoted:selected.length,
    failures,
  };
}

export async function quotePreparedMixedCandidate(
  client:PublicClient,
  prepared:PreparedMixedCandidate,
  inputUsd:number,
  options:{fallbackExtraCostsUsd:number;safetyBps:number;gasBufferBps?:number;blockNumber?:bigint},
):Promise<MixedExecutionQuote> {
  const blockNumber=options.blockNumber ?? await client.getBlockNumber({cacheTime:0});
  const amountInRaw=rawWethForUsd(inputUsd,prepared.ethUsdPrice);
  const segmented=await quoteMixedCycle(client,prepared.cycle,amountInRaw,blockNumber);
  const universalRouter=await simulateUniversalMixedParity(client,segmented);
  if(!universalRouter.atomicVerified||!universalRouter.exactOutputParity) throw new Error('Mixed Universal Router atomic parity is not verified');
  if(universalRouter.expectedAmountOut!==segmented.amountOut) throw new Error('Mixed Universal Router amountOut differs from segmented canonical quote');

  const gasBufferBps=options.gasBufferBps ?? 2000;
  const calibrated=await calibrateResearchCost({
    client,
    cycle:prepared.cycle,
    amountIn:amountInRaw,
    quoterGasEstimate:segmented.gasEstimateProxy,
    ethUsdPrice:prepared.ethUsdPrice,
    gasBufferBps,
    fallbackExtraCostsUsd:options.fallbackExtraCostsUsd,
    blockNumber,
    executorGasEstimate:universalRouter.gasEstimate,
    executorTarget:ROBINHOOD_UNIVERSAL_ROUTER,
    executorCalldata:universalRouter.calldata,
  });
  const outputUsd=Number(formatEther(segmented.amountOut))*prepared.ethUsdPrice;
  if(!Number.isFinite(outputUsd)||outputUsd<0) throw new Error('Invalid mixed output USD');
  const quote:ExecutionQuote={
    inputUsd,
    outputUsd,
    gasUsd:calibrated.gasUsd,
    extraCostsUsd:calibrated.extraCostsUsd,
    safetyMarginUsd:outputUsd*options.safetyBps/10_000,
  };
  const costBreakdown=quoteCostBreakdown(quote);
  const grossPositive=segmented.amountOut>amountInRaw;
  return {
    ...quote,
    kind:'mixed-v3-v4-universal-router-atomic-paper',
    engine:'v0.10-mixed-route-coverage',
    truthLevel:'universal-router-state-override',
    verifiedClosedCycle:true,
    atomicVerified:true,
    exactOutputParity:true,
    blockNumber,
    base:prepared.cycle.base,
    baseSymbol:prepared.cycle.baseSymbol,
    baseDecimals:18,
    hopCount:prepared.cycle.hopCount,
    v3HopCount:prepared.cycle.hops.filter(h=>h.v3).length,
    v4HopCount:prepared.cycle.hops.filter(h=>!h.v3).length,
    amountInRaw,
    amountOutRaw:segmented.amountOut,
    segmentedGasEstimateProxy:segmented.gasEstimateProxy,
    universalRouter,
    gasUnitsResearch:calibrated.gasUnitsResearch,
    gasPriceWei:calibrated.gasPriceWei,
    costModel:calibrated.mode,
    executionGasSource:calibrated.executionGasSource,
    nitroFee:calibrated.nitro,
    costFallbackReason:calibrated.fallbackReason,
    screenEdgeBps:prepared.screen.exactProbeEdgeBps,
    costBreakdown,
    green:grossPositive&&costBreakdown.netProfitUsd>0,
    assumptions:[
      'Mixed cycle starts and ends in WETH; native wrapping is performed by the canonical Universal Router plan',
      'V3 legs use canonical QuoterV2 and contiguous hookless V4 legs use canonical V4Quoter at one block',
      'The same mixed route is re-executed atomically by Universal Router through eth_call and exact-output parity is required',
      calibrated.executionGasSource==='state-override-estimateGas'
        ? `Universal Router transaction gas comes from state-override eth_estimateGas; gas buffer ${gasBufferBps/100}%`
        : `Universal Router gas estimate unavailable; segmented quote/Nitro fallback retained; gas buffer ${gasBufferBps/100}%`,
      calibrated.nitro
        ? 'Nitro NodeInterface measures parent/data fee from actual Universal Router calldata'
        : 'Nitro parent/data measurement unavailable; explicit fallback retained',
      `Safety margin ${options.safetyBps/100}% of output remains applied`,
      'Paper result only; no transaction submission, inclusion or realized profit',
    ],
  };
}
