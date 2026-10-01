import {
  createPublicClient,
  getAddress,
  http,
  parseUnits,
  toFunctionSelector,
  toHex,
} from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { prepareLaunchEconomicCandidates, quotePreparedEconomicCandidate } from '../dist/economic/engine.js';
import { quoteClosedCycle } from '../dist/economic/v4Truth.js';
import {
  ATOMIC_EXECUTOR_ADDRESS,
  ATOMIC_EXECUTOR_CALLER,
  atomicExecutorArtifact,
  encodeAtomicExecutorCall,
} from '../dist/economic/atomicExecutor.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(30,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 30)));
const top=Math.min(60,Math.max(1,Number(process.env.ATOMIC_SMOKE_TOP ?? 30)));
const sizes=(process.env.ATOMIC_SMOKE_SIZES ?? '0.001,0.003,0.01,0.03,0.10,0.30,1')
  .split(',').map(Number).filter(x=>Number.isFinite(x)&&x>0);

const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:350,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);
const noProfitSelector=toFunctionSelector('NoProfit(uint256,uint256)').toLowerCase();

function collectStrings(value,seen=new Set()){
  const out=[];
  if(value===null||value===undefined)return out;
  if(typeof value==='string')return [value];
  if(typeof value!=='object')return [String(value)];
  if(seen.has(value))return out;
  seen.add(value);
  if(Array.isArray(value)){
    for(const item of value)out.push(...collectStrings(item,seen));
    return out;
  }
  for(const item of Object.values(value))out.push(...collectStrings(item,seen));
  return out;
}

function rawInput(candidate,inputUsd){
  const human=inputUsd/candidate.baseUsdPrice;
  const precision=Math.min(candidate.baseDecimals,18);
  return parseUnits(human.toFixed(precision),candidate.baseDecimals);
}

async function ethUsd(){
  const response=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if(!response.ok)throw new Error('ETH/USD unavailable: '+response.status);
  const body=await response.json();
  const value=Number(body?.data?.amount);
  if(!Number.isFinite(value)||value<=0)throw new Error('Invalid ETH/USD');
  return value;
}

async function probeOverrideEstimateGas(blockNumber){
  const probeAddress='0x000000000000000000000000000000000000A708';
  const tx={from:ATOMIC_EXECUTOR_CALLER,to:probeAddress,data:'0x'};
  // PUSH1 0 / PUSH1 0 / RETURN
  const override={[probeAddress]:{code:'0x60006000f3'}};
  try{
    const result=await client.request({
      method:'eth_estimateGas',
      params:[tx,toHex(blockNumber),override],
    });
    return {
      supported:typeof result==='string'&&/^0x[0-9a-f]+$/i.test(result),
      gas:typeof result==='string'&&/^0x[0-9a-f]+$/i.test(result)?BigInt(result).toString():null,
      error:null,
    };
  }catch(error){
    return {supported:false,gas:null,error:String(error)};
  }
}

const valuation=await ethUsd();
const blockNumber=await client.getBlockNumber({cacheTime:0});
const launches=await discovery.latest(limit);
const candidates=[];
const scanFailures=[];

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi')continue;
    const prepared=await prepareLaunchEconomicCandidates(client,launch,snapshot,valuation,{
      paperCapitalUsd:100,maxTradeUsd:100,minTradeUsd:.001,blockNumber,
    });
    candidates.push(...prepared);
  }catch(error){
    scanFailures.push({token:snapshot.token,error:String(error)});
  }
}
candidates.sort((a,b)=>b.truth.infinitesimalEdgeBps-a.truth.infinitesimalEdgeBps);
const selected=candidates.slice(0,top);

const attempts=[];
let firstNegative=null;

for(const candidate of selected){
  for(const inputUsd of sizes){
    let amountIn;
    try{
      amountIn=rawInput(candidate,inputUsd);
      if(amountIn<=0n)continue;
      const quoted=await quoteClosedCycle(client,candidate.cycle,amountIn,blockNumber);
      const grossProfitRaw=quoted.amountOut-amountIn;
      attempts.push({
        token:candidate.launch.token,
        buyMarket:candidate.cycle.buyMarket,
        sellMarket:candidate.cycle.sellMarket,
        base:candidate.cycle.base,
        inputUsd,
        amountIn:amountIn.toString(),
        amountOut:quoted.amountOut.toString(),
        grossPositive:grossProfitRaw>0n,
      });

      if(quoted.amountOut>amountIn){
        const paper=await quotePreparedEconomicCandidate(client,candidate,inputUsd,{
          extraCostsUsd:.05,safetyBps:100,gasBufferBps:2000,blockNumber,
        });
        if(!paper.atomicExecutor)throw new Error('Gross-positive quote did not produce atomic executor evidence');
        if(paper.atomicExecutor.amountOut!==quoted.amountOut)throw new Error('Atomic output differs from canonical V4Quoter');

        const overrideProbe=await probeOverrideEstimateGas(blockNumber);
        console.log(JSON.stringify({
          ok:true,paperOnly:true,
          purpose:'v0.9 gross-positive state-override atomic executor validation',
          executionOutcome:'gross-positive-success',
          profitableClaim:paper.green===true,
          token:candidate.launch.token,
          buyMarket:candidate.cycle.buyMarket,
          sellMarket:candidate.cycle.sellMarket,
          base:getAddress(candidate.cycle.base),
          baseSymbol:candidate.cycle.baseSymbol,
          hopCount:candidate.cycle.hopCount,
          blockNumber:blockNumber.toString(),
          inputUsd,
          amountIn:amountIn.toString(),
          quoterAmountOut:quoted.amountOut.toString(),
          quoterGasEstimate:quoted.gasEstimate.toString(),
          atomicAmountOut:paper.atomicExecutor.amountOut.toString(),
          atomicProfitRaw:paper.atomicExecutor.profit.toString(),
          executorGasEstimate:paper.atomicExecutor.gasEstimate?.toString() ?? null,
          executorGasEstimateSource:paper.atomicExecutor.gasEstimateSource,
          executorGasEstimateError:paper.atomicExecutor.gasEstimateError,
          genericOverrideEstimateGasProbe:overrideProbe,
          costModel:paper.costModel,
          executionGasSource:paper.executionGasSource,
          gasUnitsResearch:paper.gasUnitsResearch.toString(),
          gasUsd:paper.gasUsd,
          parentDataCostUsd:paper.nitroFee?.parentDataCostUsd ?? null,
          safetyMarginUsd:paper.safetyMarginUsd,
          grossEdgeUsd:paper.costBreakdown.grossQuotedEdgeUsd,
          netPaperUsd:paper.costBreakdown.netProfitUsd,
          green:paper.green,
          runtimeBytes:paper.atomicExecutor.runtimeBytes,
          runtimeHexSha256:paper.atomicExecutor.runtimeHexSha256,
          candidatesScanned:selected.length,
          quoteAttempts:attempts.length,
          scanFailures,
          note:'Paper validation only; no transaction was sent.',
        },(_,value)=>typeof value==='bigint'?value.toString():value));
        process.exit(0);
      }

      if(!firstNegative){
        firstNegative={candidate,inputUsd,amountIn,quoted};
      }
    }catch(error){
      attempts.push({
        token:candidate.launch.token,
        buyMarket:candidate.cycle.buyMarket,
        sellMarket:candidate.cycle.sellMarket,
        base:candidate.cycle.base,
        inputUsd,
        error:String(error),
      });
    }
  }
}

if(firstNegative){
  const {candidate,inputUsd,amountIn,quoted}=firstNegative;
  const calldata=encodeAtomicExecutorCall(candidate.cycle,amountIn,1n);
  const artifact=atomicExecutorArtifact();
  const tx={from:ATOMIC_EXECUTOR_CALLER,to:ATOMIC_EXECUTOR_ADDRESS,data:calldata};
  const override={[ATOMIC_EXECUTOR_ADDRESS]:{code:artifact.runtimeBytecode}};
  let expectedNoProfit=false;
  let negativeError=null;
  try{
    await client.request({method:'eth_call',params:[tx,toHex(blockNumber),override]});
  }catch(error){
    negativeError=String(error);
    const strings=[String(error),...collectStrings(error)].map(x=>x.toLowerCase());
    expectedNoProfit=strings.some(x=>x.includes(noProfitSelector));
  }
  if(!expectedNoProfit){
    throw new Error('State override did not produce expected NoProfit executor revert: '+negativeError);
  }
  const overrideProbe=await probeOverrideEstimateGas(blockNumber);
  console.log(JSON.stringify({
    ok:true,paperOnly:true,
    purpose:'v0.9 state-override atomic executor smoke',
    executionOutcome:'no-live-gross-positive-found',
    atomicOverrideSupported:true,
    grossPositiveFound:false,
    token:candidate.launch.token,
    buyMarket:candidate.cycle.buyMarket,
    sellMarket:candidate.cycle.sellMarket,
    base:getAddress(candidate.cycle.base),
    baseSymbol:candidate.cycle.baseSymbol,
    hopCount:candidate.cycle.hopCount,
    blockNumber:blockNumber.toString(),
    inputUsd,
    amountIn:amountIn.toString(),
    quoterAmountOut:quoted.amountOut.toString(),
    expectedExecutorError:'NoProfit(uint256,uint256)',
    expectedExecutorErrorSelector:noProfitSelector,
    genericOverrideEstimateGasProbe:overrideProbe,
    runtimeBytes:artifact.runtimeBytes,
    runtimeHexSha256:artifact.runtimeHexSha256,
    launchesExamined:launches.length,
    marginalCandidates:selected.length,
    quoteAttempts:attempts.length,
    scanFailures,
    profitableClaim:false,
    note:'All selected marginal candidates/sizes were searched before falling back to the negative-path integration proof. No transaction was sent.',
  }));
  process.exit(0);
}

console.error(JSON.stringify({
  ok:false,paperOnly:true,
  message:'No supported cycle produced a verifiable state-override executor outcome',
  launchesExamined:launches.length,
  marginalCandidates:selected.length,
  quoteAttempts:attempts.length,
  scanFailures,
  attempts:attempts.slice(0,50),
}));
process.exit(1);
