import { createPublicClient, http } from 'viem';
import { createPar, poolIdOf, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { prepareLaunchEconomicCandidates, quotePreparedEconomicCandidate } from '../dist/economic/engine.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(20,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 8)));
const top=Math.min(16,Math.max(1,Number(process.env.TRUTH_DIAGNOSTIC_TOP ?? 8)));
const sizes=(process.env.TRUTH_DIAGNOSTIC_SIZES ?? '0.01,0.03,0.10,0.30,1,3,10')
  .split(',').map(Number).filter(x=>Number.isFinite(x)&&x>0);

const client=createPublicClient({chain:robinhoodChain,transport:http(rpc,{retryCount:2,retryDelay:400,timeout:20_000})});
const discovery=new Discovery(createPar({client}),api);

function classifyQuoteError(error){
  let current=error;
  let nested=null;
  while(current){
    const data=current?.data;
    if(data?.errorName==='UnexpectedRevertBytes' && Array.isArray(data.args) && typeof data.args[0]==='string'){
      nested=data.args[0];
      break;
    }
    current=current?.cause;
  }
  const selector=typeof nested==='string'&&nested.startsWith('0x')&&nested.length>=10?nested.slice(0,10):null;
  let innerError=null;
  let poolId=null;
  if(selector==='0x7a5ed734'){
    innerError='NotEnoughLiquidity';
    if(nested.length>=74) poolId='0x'+nested.slice(10,74);
  }
  return {
    outerError:'UnexpectedRevertBytes',
    innerSelector:selector,
    innerError,
    poolId,
    message:String(error),
  };
}

const ethResponse=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
if(!ethResponse.ok) throw new Error('ETH/USD unavailable: '+ethResponse.status);
const ethBody=await ethResponse.json();
const ethUsd=Number(ethBody?.data?.amount);
if(!Number.isFinite(ethUsd)||ethUsd<=0) throw new Error('Invalid ETH/USD');

const blockNumber=await client.getBlockNumber({cacheTime:0});
const launches=await discovery.latest(limit);
const candidates=[];
const failures=[];

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi') continue;
    const prepared=await prepareLaunchEconomicCandidates(client,launch,snapshot,ethUsd,{
      paperCapitalUsd:100,maxTradeUsd:100,minTradeUsd:0.01,blockNumber,
    });
    candidates.push(...prepared);
  }catch(error){
    failures.push({token:snapshot.token,error:String(error)});
  }
}

candidates.sort((a,b)=>b.truth.infinitesimalEdgeBps-a.truth.infinitesimalEdgeBps);
const selected=candidates.slice(0,top);
const output=[];

for(const candidate of selected){
  const hopStates=candidate.cycle.hops.map((hop,index)=>{
    const id=poolIdOf(hop.key).toLowerCase();
    const state=candidate.truth.states[id];
    return {
      index,
      role:hop.role,
      input:hop.input,
      output:hop.output,
      poolId:id,
      fee:hop.key.fee,
      tickSpacing:hop.key.tickSpacing,
      tick:state?.tick ?? null,
      lpFee:state?.lpFee ?? null,
      protocolFee:state?.protocolFee ?? null,
      liquidity:state?.liquidity?.toString() ?? null,
      sqrtPriceX96:state?.sqrtPriceX96?.toString() ?? null,
    };
  });
  const quotes=[];
  for(const inputUsd of sizes){
    try{
      const quote=await quotePreparedEconomicCandidate(client,candidate,inputUsd,{
        extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber,
      });
      quotes.push({
        inputUsd,
        outputUsd:quote.outputUsd,
        grossQuotedEdgeUsd:quote.costBreakdown.grossQuotedEdgeUsd,
        gasUsd:quote.gasUsd,
        extraCostsUsd:quote.extraCostsUsd,
        safetyMarginUsd:quote.safetyMarginUsd,
        netProfitUsd:quote.costBreakdown.netProfitUsd,
        netReturnPct:quote.costBreakdown.netReturnPct,
        amountInRaw:quote.amountInRaw.toString(),
        amountOutRaw:quote.amountOutRaw.toString(),
        quoterGasEstimate:quote.quoterGasEstimate.toString(),
      });
    }catch(error){
      quotes.push({inputUsd,error:classifyQuoteError(error)});
    }
  }
  output.push({
    token:candidate.launch.token,
    buyMarket:candidate.cycle.buyMarket,
    sellMarket:candidate.cycle.sellMarket,
    base:candidate.cycle.base,
    baseSymbol:candidate.cycle.baseSymbol,
    hopCount:candidate.cycle.hopCount,
    blockNumber:blockNumber.toString(),
    infinitesimalMultiplier:candidate.truth.infinitesimalMultiplier,
    infinitesimalEdgeBps:candidate.truth.infinitesimalEdgeBps,
    grossSpreadPct:candidate.screen.grossSpreadPct,
    baseUsdPrice:candidate.baseUsdPrice,
    seedTrusted:candidate.seedTrusted,
    seedUsd:candidate.seedUsd,
    minActiveLiquidity:hopStates.reduce((min,h)=>{
      if(h.liquidity===null) return min;
      const n=BigInt(h.liquidity);
      return min===null||n<min?n:min;
    },null)?.toString() ?? null,
    hopStates,
    quotes,
  });
}

const bySize=Object.fromEntries(sizes.map(size=>{
  const rows=output.flatMap(candidate=>candidate.quotes.filter(q=>q.inputUsd===size));
  const quoted=rows.filter(q=>!q.error);
  const grossPositive=quoted.filter(q=>q.grossQuotedEdgeUsd>0);
  const paperPositive=quoted.filter(q=>q.netProfitUsd>0);
  const bestNet=quoted.length?Math.max(...quoted.map(q=>q.netProfitUsd)):null;
  const bestGross=quoted.length?Math.max(...quoted.map(q=>q.grossQuotedEdgeUsd)):null;
  return [String(size),{
    attempts:rows.length,
    quoted:quoted.length,
    failures:rows.length-quoted.length,
    grossPositive:grossPositive.length,
    paperPositive:paperPositive.length,
    bestNetProfitUsd:bestNet,
    bestGrossQuotedEdgeUsd:bestGross,
  }];
}));
const allQuotes=output.flatMap(candidate=>candidate.quotes);
const quoted=allQuotes.filter(q=>!q.error);
const summary={
  exactAttempts:allQuotes.length,
  exactQuoted:quoted.length,
  exactFailures:allQuotes.length-quoted.length,
  grossPositive:quoted.filter(q=>q.grossQuotedEdgeUsd>0).length,
  paperPositive:quoted.filter(q=>q.netProfitUsd>0).length,
  bestPaperNetUsd:quoted.length?Math.max(...quoted.map(q=>q.netProfitUsd)):null,
  bestGrossEdgeUsd:quoted.length?Math.max(...quoted.map(q=>q.grossQuotedEdgeUsd)):null,
  bySize,
};

console.log(JSON.stringify({
  ok:true,
  paperOnly:true,
  purpose:'v0.8.2 full marginal-vs-executable-depth audit',
  blockNumber:blockNumber.toString(),
  launchesExamined:launches.length,
  candidateCount:candidates.length,
  selectedCount:selected.length,
  sizes,
  failures,
  summary,
  candidates:output,
},(_,value)=>typeof value==='bigint'?value.toString():value));
