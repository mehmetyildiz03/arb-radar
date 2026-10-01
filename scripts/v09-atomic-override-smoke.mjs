import {
  createPublicClient,
  getAddress,
  http,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from 'viem';
import { createPar, getReference, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles, quoteClosedCycle } from '../dist/economic/v4Truth.js';
import {
  ATOMIC_EXECUTOR_ADDRESS,
  ATOMIC_EXECUTOR_CALLER,
  atomicExecutorArtifact,
  encodeAtomicExecutorCall,
  simulateAtomicExecutor,
} from '../dist/economic/atomicExecutor.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(30,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 16)));
const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:400,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);
const ref=getReference(robinhoodChain.id);
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

function baseDecimals(launch,base){
  if(base.toLowerCase()===zeroAddress.toLowerCase()||base.toLowerCase()===ref.wrapped.toLowerCase())return 18;
  return launch.markets.find(m=>m.pairToken.toLowerCase()===base.toLowerCase())?.quoteDecimals ?? 18;
}

const launches=await discovery.latest(limit);
const failures=[];

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi')continue;
    for(const buy of launch.markets){
      for(const sell of launch.markets){
        if(buy.index===sell.index)continue;
        const cycles=enumerateClosedCycles(launch,buy.index,sell.index)
          .filter(c=>c.allV4&&c.hooklessV4);
        for(const cycle of cycles){
          const decimals=baseDecimals(launch,cycle.base);
          const amountIn=10n**BigInt(Math.max(0,decimals-4));
          const blockNumber=await client.getBlockNumber({cacheTime:0});
          try{
            const quoted=await quoteClosedCycle(client,cycle,amountIn,blockNumber);
            if(quoted.amountOut>amountIn){
              const atomic=await simulateAtomicExecutor(client,cycle,amountIn,blockNumber,1n);
              if(atomic.amountOut!==quoted.amountOut)throw new Error('Atomic output differs from canonical V4Quoter');
              console.log(JSON.stringify({
                ok:true,paperOnly:true,
                purpose:'v0.9 live state-override atomic executor smoke',
                executionOutcome:'gross-positive-success',
                atomicOverrideSupported:true,
                token:launch.token,buyMarket:buy.index,sellMarket:sell.index,
                base:getAddress(cycle.base),baseSymbol:cycle.baseSymbol,hopCount:cycle.hopCount,
                blockNumber:blockNumber.toString(),amountIn:amountIn.toString(),
                quoterAmountOut:quoted.amountOut.toString(),
                atomicAmountOut:atomic.amountOut.toString(),
                atomicProfit:atomic.profit.toString(),
                executorGasEstimate:atomic.gasEstimate?.toString() ?? null,
                executorGasEstimateSource:atomic.gasEstimateSource,
                executorGasEstimateError:atomic.gasEstimateError,
                runtimeBytes:atomic.runtimeBytes,
                runtimeHexSha256:atomic.runtimeHexSha256,
                profitableClaim:false,
                note:'Integration smoke only; no transaction was sent.',
              }));
              process.exit(0);
            }

            const calldata=encodeAtomicExecutorCall(cycle,amountIn,1n);
            const artifact=atomicExecutorArtifact();
            const tx={from:ATOMIC_EXECUTOR_CALLER,to:ATOMIC_EXECUTOR_ADDRESS,data:calldata};
            const override={[ATOMIC_EXECUTOR_ADDRESS]:{code:artifact.runtimeBytecode}};
            try{
              await client.request({
                method:'eth_call',
                params:[tx,toHex(blockNumber),override],
              });
              throw new Error('Gross-negative atomic call unexpectedly succeeded');
            }catch(error){
              const strings=[String(error),...collectStrings(error)].map(x=>x.toLowerCase());
              if(!strings.some(x=>x.includes(noProfitSelector))){
                throw new Error('State override did not produce expected NoProfit executor revert: '+String(error));
              }
              console.log(JSON.stringify({
                ok:true,paperOnly:true,
                purpose:'v0.9 live state-override atomic executor smoke',
                executionOutcome:'expected-no-profit-revert',
                atomicOverrideSupported:true,
                token:launch.token,buyMarket:buy.index,sellMarket:sell.index,
                base:getAddress(cycle.base),baseSymbol:cycle.baseSymbol,hopCount:cycle.hopCount,
                blockNumber:blockNumber.toString(),amountIn:amountIn.toString(),
                quoterAmountOut:quoted.amountOut.toString(),
                expectedExecutorError:'NoProfit(uint256,uint256)',
                expectedExecutorErrorSelector:noProfitSelector,
                runtimeBytes:artifact.runtimeBytes,
                runtimeHexSha256:artifact.runtimeHexSha256,
                profitableClaim:false,
                note:'Integration smoke only; no transaction was sent.',
              }));
              process.exit(0);
            }
          }catch(error){
            failures.push({
              token:launch.token,buy:buy.index,sell:sell.index,base:cycle.base,error:String(error),
            });
          }
        }
      }
    }
  }catch(error){
    failures.push({token:snapshot.token,error:String(error)});
  }
}

console.error(JSON.stringify({
  ok:false,paperOnly:true,
  message:'No live cycle produced a verifiable state-override executor outcome',
  launchesExamined:launches.length,
  failures:failures.slice(0,30),
}));
process.exit(1);
