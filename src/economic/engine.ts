import {
  formatUnits,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  erc20Abi,
  getAddresses,
  getReference,
  poolIdOf,
  quotePricerAbi,
  type TradableLaunch,
} from 'par-sdk';
import type { DirectedRoute, ExecutionQuote, LaunchSnapshot, RouteScreen } from '../domain.js';
import { quoteCostBreakdown, type QuoteCostBreakdown } from '../research/costs.js';
import {
  bestStructuralCycle,
  cycleSpotMultiplier,
  cycleTruthFromStates,
  directionalProtocolFee,
  enumerateClosedCycles,
  quoteClosedCycle,
  rawSpotRate,
  readV4States,
  totalSwapFeePips,
  type ClosedCycle,
  type CycleTruth,
  type DirectedPoolHop,
  type V4PoolState,
} from './v4Truth.js';
import { optimalBaseInputConstantProduct, seedValidationAmounts } from './seed.js';
import { calibrateResearchCost, type NitroFeeComponents, type ResearchCostMode, type ExecutionGasSource } from './nitroFees.js';
import { simulateAtomicExecutor, type AtomicExecutorSimulation } from './atomicExecutor.js';

export interface EconomicScreen extends RouteScreen {
  source: 'same-block-v4-state';
  blockNumber: bigint;
  infinitesimalEdgeBps: number;
  base: Address;
  baseSymbol: string;
  hopCount: number;
  truthLevel: 'same-block-v4-spot';
}

export interface PreparedEconomicCandidate {
  launch: TradableLaunch;
  snapshot: LaunchSnapshot;
  route: DirectedRoute;
  cycle: ClosedCycle;
  truth: CycleTruth;
  screen: EconomicScreen;
  baseDecimals: number;
  baseUsdPrice: number;
  ethUsdPrice: number;
  seedUsd: number | null;
  seedTrusted: boolean;
  sizingAmountsUsd: number[];
}

export interface EconomicExecutionQuote extends ExecutionQuote {
  kind: 'v4-closed-cycle-atomic-paper';
  engine: 'v0.9-economic-truth-atomic-override';
  truthLevel: 'same-block-v4-closed-cycle-quoter' | 'state-override-atomic-executor';
  verifiedClosedCycle: true;
  blockNumber: bigint;
  base: Address;
  baseSymbol: string;
  baseDecimals: number;
  hopCount: number;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  quoterGasEstimate: bigint;
  gasUnitsResearch: bigint;
  gasPriceWei: bigint;
  costModel: ResearchCostMode;
  executionGasSource: ExecutionGasSource;
  atomicExecutor: AtomicExecutorSimulation | null;
  nitroFee: NitroFeeComponents | null;
  costFallbackReason: string | null;
  infinitesimalEdgeBps: number;
  costBreakdown: QuoteCostBreakdown;
  green: boolean;
  assumptions: string[];
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

async function baseDecimalsAtBlock(
  client:PublicClient,
  launch:TradableLaunch,
  base:Address,
  blockNumber:bigint,
):Promise<number> {
  const ref=getReference(4663);
  if(same(base,zeroAddress)||same(base,ref.wrapped)) return 18;
  const market=launch.markets.find(m=>same(m.pairToken,base));
  if(market) return market.quoteDecimals;
  const decimals=await client.readContract({address:base,abi:erc20Abi,functionName:'decimals',blockNumber});
  const value=Number(decimals);
  if(!Number.isInteger(value)||value<0||value>36) throw new Error('Invalid base decimals');
  return value;
}

async function baseUsdAtBlock(
  client:PublicClient,
  base:Address,
  baseDecimals:number,
  ethUsdPrice:number,
  blockNumber:bigint,
):Promise<number> {
  if(!Number.isFinite(ethUsdPrice)||ethUsdPrice<=0) throw new Error('Invalid ETH/USD valuation');
  const ref=getReference(4663);
  if(same(base,zeroAddress)||same(base,ref.wrapped)) return ethUsdPrice;
  const rawPerEth=await client.readContract({
    address:getAddresses(4663).quotePricer,
    abi:quotePricerAbi,
    functionName:'priceEthAmountInQuote',
    args:[base,10n**18n],
    blockNumber,
  });
  if(rawPerEth<=0n) throw new Error('Base asset is not priceable in ETH');
  const basePerEth=Number(formatUnits(rawPerEth,baseDecimals));
  if(!Number.isFinite(basePerEth)||basePerEth<=0) throw new Error('Invalid same-block base valuation');
  return ethUsdPrice/basePerEth;
}

function hopFeeMultiplier(hop:DirectedPoolHop,state:V4PoolState):number {
  const zeroForOne=same(hop.input,hop.key.currency0);
  const protocol=directionalProtocolFee(state.protocolFee,zeroForOne);
  const fee=totalSwapFeePips(protocol,state.lpFee);
  return 1-fee/1_000_000;
}

function pathRate(hops:readonly DirectedPoolHop[],states:Record<string,V4PoolState>):number {
  let rate=1;
  for(const hop of hops){
    if(hop.v3) return NaN;
    const state=states[poolIdOf(hop.key).toLowerCase()];
    if(!state) return NaN;
    rate*=rawSpotRate(hop,state,true);
  }
  return rate;
}

function parseRaw(value:string|undefined):number|null {
  if(!value||!/^[0-9]+$/.test(value)) return null;
  const n=Number(BigInt(value));
  return Number.isFinite(n)&&n>0?n:null;
}

function analyticSeedUsd(
  candidate: {
    launch:TradableLaunch;
    snapshot:LaunchSnapshot;
    cycle:ClosedCycle;
    truth:CycleTruth;
    baseDecimals:number;
    baseUsdPrice:number;
  },
):{seedUsd:number|null;trusted:boolean} {
  const {launch,snapshot,cycle,truth,baseDecimals,baseUsdPrice}=candidate;
  const buyMeta=launch.markets[cycle.buyMarket],sellMeta=launch.markets[cycle.sellMarket];
  const buySnap=marketSnapshot(snapshot,cycle.buyMarket),sellSnap=marketSnapshot(snapshot,cycle.sellMarket);
  if(!buyMeta||!sellMeta||!buySnap||!sellSnap) return {seedUsd:null,trusted:false};

  const buyState=truth.states[buyMeta.poolId.toLowerCase()];
  const sellState=truth.states[sellMeta.poolId.toLowerCase()];
  if(!buyState||!sellState) return {seedUsd:null,trusted:false};
  // Exact active-liquidity equality is deliberately conservative. If another
  // active LP is present, the Par one-sided CP curve is not the whole pool.
  const trusted=buyState.liquidity===buyMeta.liquidity && sellState.liquidity===sellMeta.liquidity;
  if(!trusted) return {seedUsd:null,trusted:false};

  const buyPhantom=parseRaw(buySnap.phantomQuoteRaw);
  const buyRaised=buySnap.quoteRaisedRaw && /^[0-9]+$/.test(buySnap.quoteRaisedRaw) ? Number(BigInt(buySnap.quoteRaisedRaw)) : 0;
  const buyTokens=parseRaw(buySnap.tokensOnCurveRaw);
  const sellPhantom=parseRaw(sellSnap.phantomQuoteRaw);
  const sellRaised=sellSnap.quoteRaisedRaw && /^[0-9]+$/.test(sellSnap.quoteRaisedRaw) ? Number(BigInt(sellSnap.quoteRaisedRaw)) : 0;
  const sellTokens=parseRaw(sellSnap.tokensOnCurveRaw);
  if(buyPhantom===null||buyTokens===null||sellPhantom===null||sellTokens===null) return {seedUsd:null,trusted:false};

  const buyHopIndex=cycle.hops.findIndex(h=>h.role==='par-buy');
  const sellHopIndex=cycle.hops.findIndex(h=>h.role==='par-sell');
  if(buyHopIndex<0||sellHopIndex<0||sellHopIndex<=buyHopIndex) return {seedUsd:null,trusted:false};
  const beforeBuy=cycle.hops.slice(0,buyHopIndex);
  const afterSell=cycle.hops.slice(sellHopIndex+1);
  const baseToBuy=pathRate(beforeBuy,truth.states);
  const sellToBase=pathRate(afterSell,truth.states);
  if(!Number.isFinite(baseToBuy)||!Number.isFinite(sellToBase)||baseToBuy<=0||sellToBase<=0) return {seedUsd:null,trusted:false};

  const buyHop=cycle.hops[buyHopIndex]!,sellHop=cycle.hops[sellHopIndex]!;
  const rawBase=optimalBaseInputConstantProduct({
    buyQuoteReserve:buyPhantom+buyRaised,
    buyTokenReserve:buyTokens,
    sellTokenReserve:sellTokens,
    sellQuoteReserve:sellPhantom+sellRaised,
    buyFeeMultiplier:hopFeeMultiplier(buyHop,buyState),
    sellFeeMultiplier:hopFeeMultiplier(sellHop,sellState),
    baseToBuyQuoteRate:baseToBuy,
    sellQuoteToBaseRate:sellToBase,
  });
  if(rawBase===null) return {seedUsd:null,trusted:true};
  const humanBase=rawBase/10**baseDecimals;
  const seedUsd=humanBase*baseUsdPrice;
  return {seedUsd:Number.isFinite(seedUsd)&&seedUsd>0?seedUsd:null,trusted:true};
}

export async function prepareLaunchEconomicCandidates(
  client:PublicClient,
  launch:TradableLaunch,
  snapshot:LaunchSnapshot,
  ethUsdPrice:number,
  options:{paperCapitalUsd:number;maxTradeUsd:number;minTradeUsd?:number;blockNumber?:bigint},
):Promise<PreparedEconomicCandidate[]> {
  if(launch.kind!=='multi'||launch.markets.length<2) return [];
  const blockNumber=options.blockNumber ?? await client.getBlockNumber({cacheTime:0});

  const pairCycles:Array<{buy:number;sell:number;cycles:ClosedCycle[]}>= [];
  const allCycles:ClosedCycle[]=[];
  for(const buy of launch.markets){
    for(const sell of launch.markets){
      if(buy.index===sell.index) continue;
      const cycles=enumerateClosedCycles(launch,buy.index,sell.index).filter(c=>c.allV4&&c.hooklessV4);
      if(cycles.length){
        pairCycles.push({buy:buy.index,sell:sell.index,cycles});
        allCycles.push(...cycles);
      }
    }
  }
  if(!allCycles.length) return [];
  const states=await readV4States(client,allCycles,blockNumber);
  const out:PreparedEconomicCandidate[]=[];
  const baseMetaCache=new Map<string,{decimals:number;usd:number}>();

  for(const pair of pairCycles){
    const truths=pair.cycles
      .map(cycle=>cycleTruthFromStates(cycle,states,blockNumber))
      .filter(truth=>truth.passesInfinitesimalEdge);
    truths.sort((a,b)=>
      a.cycle.hopCount-b.cycle.hopCount ||
      b.infinitesimalMultiplier-a.infinitesimalMultiplier ||
      a.cycle.base.toLowerCase().localeCompare(b.cycle.base.toLowerCase()));
    const truth=truths[0];
    if(!truth) continue;

    const cycle=truth.cycle;
    const baseKey=cycle.base.toLowerCase();
    let baseMeta=baseMetaCache.get(baseKey);
    if(!baseMeta){
      const decimals=await baseDecimalsAtBlock(client,launch,cycle.base,blockNumber);
      const usd=await baseUsdAtBlock(client,cycle.base,decimals,ethUsdPrice,blockNumber);
      baseMeta={decimals,usd};
      baseMetaCache.set(baseKey,baseMeta);
    }
    const baseDecimals=baseMeta.decimals;
    const baseUsdPrice=baseMeta.usd;
    const route=directedRoute(snapshot,pair.buy,pair.sell);
    const grossMultiplier=cycleSpotMultiplier(cycle,states,false);
    const screen:EconomicScreen={
      route,
      grossPriceRatio:grossMultiplier,
      grossSpreadPct:(grossMultiplier-1)*100,
      feeAdjustedReturnPct:truth.infinitesimalEdgeBps/100,
      passesFeeFloor:true,
      source:'same-block-v4-state',
      blockNumber,
      infinitesimalEdgeBps:truth.infinitesimalEdgeBps,
      base:cycle.base,
      baseSymbol:cycle.baseSymbol,
      hopCount:cycle.hopCount,
      truthLevel:'same-block-v4-spot',
    };
    const seed=analyticSeedUsd({launch,snapshot,cycle,truth,baseDecimals,baseUsdPrice});
    const maxUsd=Math.min(options.paperCapitalUsd,options.maxTradeUsd);
    const minUsd=Math.min(options.minTradeUsd ?? 1,maxUsd);
    const sizingAmountsUsd=seed.trusted&&seed.seedUsd!==null
      ? seedValidationAmounts(seed.seedUsd,minUsd,maxUsd)
      : [];

    out.push({
      launch,snapshot,route,cycle,truth,screen,baseDecimals,baseUsdPrice,ethUsdPrice,
      seedUsd:seed.seedUsd,seedTrusted:seed.trusted,sizingAmountsUsd,
    });
  }
  return out.sort((a,b)=>b.truth.infinitesimalEdgeBps-a.truth.infinitesimalEdgeBps);
}

function inputRawForUsd(inputUsd:number,baseUsdPrice:number,baseDecimals:number):bigint {
  if(!Number.isFinite(inputUsd)||inputUsd<=0||!Number.isFinite(baseUsdPrice)||baseUsdPrice<=0) throw new Error('Invalid paper input');
  const human=inputUsd/baseUsdPrice;
  const precision=Math.min(baseDecimals,18);
  const text=human.toFixed(precision);
  const raw=parseUnits(text,baseDecimals);
  if(raw<=0n) throw new Error('Paper input rounds to zero');
  return raw;
}

export async function quotePreparedEconomicCandidate(
  client:PublicClient,
  prepared:PreparedEconomicCandidate,
  inputUsd:number,
  options:{extraCostsUsd:number;safetyBps:number;gasBufferBps?:number;blockNumber?:bigint},
):Promise<EconomicExecutionQuote> {
  const quoteBlock=options.blockNumber ?? await client.getBlockNumber({cacheTime:0});
  const baseUsdPrice=quoteBlock===prepared.truth.blockNumber
    ? prepared.baseUsdPrice
    : await baseUsdAtBlock(client,prepared.cycle.base,prepared.baseDecimals,prepared.ethUsdPrice,quoteBlock);
  const amountInRaw=inputRawForUsd(inputUsd,baseUsdPrice,prepared.baseDecimals);
  const closed=await quoteClosedCycle(client,prepared.cycle,amountInRaw,quoteBlock);
  const grossPositive=closed.amountOut>amountInRaw;
  const atomicExecutor=grossPositive
    ? await simulateAtomicExecutor(client,prepared.cycle,amountInRaw,quoteBlock,1n)
    : null;
  if(atomicExecutor && atomicExecutor.amountOut!==closed.amountOut){
    throw new Error('Atomic executor amountOut differs from canonical V4Quoter');
  }

  const gasBufferBps=options.gasBufferBps ?? 2000;
  const calibrated=await calibrateResearchCost({
    client,
    cycle:prepared.cycle,
    amountIn:amountInRaw,
    quoterGasEstimate:closed.gasEstimate,
    ethUsdPrice:prepared.ethUsdPrice,
    gasBufferBps,
    fallbackExtraCostsUsd:options.extraCostsUsd,
    blockNumber:quoteBlock,
    executorGasEstimate:atomicExecutor?.gasEstimate,
    executorTarget:atomicExecutor?.executorAddress,
    executorCalldata:atomicExecutor?.calldata,
  });
  const outputHuman=Number(formatUnits(closed.amountOut,prepared.baseDecimals));
  const outputUsd=outputHuman*baseUsdPrice;
  const quote:ExecutionQuote={
    inputUsd,
    outputUsd,
    gasUsd:calibrated.gasUsd,
    extraCostsUsd:calibrated.extraCostsUsd,
    safetyMarginUsd:outputUsd*options.safetyBps/10_000,
  };
  const costBreakdown=quoteCostBreakdown(quote);
  return {
    ...quote,
    kind:'v4-closed-cycle-atomic-paper',
    engine:'v0.9-economic-truth-atomic-override',
    truthLevel:atomicExecutor?'state-override-atomic-executor':'same-block-v4-closed-cycle-quoter',
    verifiedClosedCycle:true,
    blockNumber:closed.blockNumber,
    base:prepared.cycle.base,
    baseSymbol:prepared.cycle.baseSymbol,
    baseDecimals:prepared.baseDecimals,
    hopCount:prepared.cycle.hopCount,
    amountInRaw,
    amountOutRaw:closed.amountOut,
    quoterGasEstimate:closed.gasEstimate,
    gasUnitsResearch:calibrated.gasUnitsResearch,
    gasPriceWei:calibrated.gasPriceWei,
    costModel:calibrated.mode,
    executionGasSource:calibrated.executionGasSource,
    atomicExecutor,
    nitroFee:calibrated.nitro,
    costFallbackReason:calibrated.fallbackReason,
    infinitesimalEdgeBps:prepared.truth.infinitesimalEdgeBps,
    costBreakdown,
    green:atomicExecutor!==null && costBreakdown.netProfitUsd>0,
    assumptions:[
      'Closed cycle starts and ends in the same base asset',
      'All cycle hops are amount-quoted statefully by canonical Robinhood V4Quoter at one block',
      atomicExecutor
        ? 'Gross-positive cycle amount/profit re-executed by injected minimal atomic executor bytecode with eth_call state override'
        : 'Gross-nonpositive cycle skips atomic executor simulation because profit-or-revert would intentionally revert',
      calibrated.executionGasSource==='state-override-estimateGas'
        ? `Executor transaction gas comes from eth_estimateGas with the identical state override; gas buffer ${gasBufferBps/100}%`
        : `State-override gas estimate unavailable/not applicable; conservative V4Quoter-based gas fallback retained; gas buffer ${gasBufferBps/100}%`,
      calibrated.nitro
        ? 'Nitro NodeInterface measures parent/data fee for transaction calldata'
        : 'Nitro parent/data measurement unavailable; conservative explicit fallback retained',
      '1% output safety margin remains unchanged in v0.9',
      'Paper result only; no deployment, transaction submission, inclusion or realized profit',
    ],
  };
}

export function sizingPlanUsd(
  prepared:PreparedEconomicCandidate,
  fallback:number[],
):{mode:'analytic-seed-exact'|'exact-grid-fallback';amounts:number[]} {
  if(prepared.seedTrusted&&prepared.sizingAmountsUsd.length>0){
    return {mode:'analytic-seed-exact',amounts:prepared.sizingAmountsUsd};
  }
  return {mode:'exact-grid-fallback',amounts:fallback};
}

export { bestStructuralCycle };
