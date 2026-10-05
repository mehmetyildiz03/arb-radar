import { createPublicClient, http, zeroAddress } from 'viem';
import { createPar, getReference, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles } from '../dist/economic/v4Truth.js';
import { quoteMixedCycle } from '../dist/economic/mixedQuote.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(50,Math.max(1,Number(process.env.MIXED_SMOKE_LAUNCH_LIMIT ?? 30)));

const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:350,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);
const ref=getReference(robinhoodChain.id);
const launches=await discovery.latest(limit);
const failures=[];

function isZero(address){
  return String(address).toLowerCase()===zeroAddress.toLowerCase();
}

function baseDecimals(launch,cycle){
  if(isZero(cycle.base)||cycle.base.toLowerCase()===ref.wrapped.toLowerCase()) return 18;
  return launch.markets.find(m=>m.pairToken.toLowerCase()===cycle.base.toLowerCase())?.quoteDecimals ?? 18;
}

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi') continue;
    for(const buy of launch.markets){
      for(const sell of launch.markets){
        if(buy.index===sell.index) continue;
        const cycles=enumerateClosedCycles(launch,buy.index,sell.index)
          .filter(cycle=>
            cycle.hops.some(h=>h.v3) &&
            cycle.hops.every(h=>h.v3||String(h.key.hooks).toLowerCase()===zeroAddress.toLowerCase())
          )
          .sort((a,b)=>a.hopCount-b.hopCount);
        for(const cycle of cycles){
          try{
            const decimals=baseDecimals(launch,cycle);
            const amountIn=10n**BigInt(Math.max(0,decimals-4));
            if(amountIn<=0n) continue;
            const blockNumber=await client.getBlockNumber({cacheTime:0});
            const quoted=await quoteMixedCycle(client,cycle,amountIn,blockNumber);
            console.log(JSON.stringify({
              ok:true,
              paperOnly:true,
              purpose:'v0.10 canonical mixed V3/V4 quote integration smoke; not atomic evidence',
              token:launch.token,
              buyMarket:buy.index,
              sellMarket:sell.index,
              buyQuote:buy.quoteSymbol,
              sellQuote:sell.quoteSymbol,
              base:cycle.base,
              baseSymbol:cycle.baseSymbol,
              hopCount:cycle.hopCount,
              v3HopCount:cycle.hops.filter(h=>h.v3).length,
              v4HopCount:cycle.hops.filter(h=>!h.v3).length,
              blockNumber:blockNumber.toString(),
              amountIn:amountIn.toString(),
              amountOut:quoted.amountOut.toString(),
              gasEstimateProxy:quoted.gasEstimateProxy.toString(),
              grossPositive:quoted.amountOut>amountIn,
              atomicVerified:quoted.atomicVerified,
              profitableClaim:false,
              steps:quoted.steps.map(step=>({
                protocol:step.protocol,
                hopStart:step.hopStart,
                hopEnd:step.hopEnd,
                amountIn:step.amountIn.toString(),
                amountOut:step.amountOut.toString(),
                gasEstimate:step.gasEstimate.toString(),
              })),
            }));
            process.exit(0);
          }catch(error){
            failures.push({
              token:launch.token,buyMarket:buy.index,sellMarket:sell.index,
              base:cycle.base,hopCount:cycle.hopCount,error:String(error),
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
  ok:false,
  paperOnly:true,
  message:'No mixed V3/V4 closed cycle could be quoted',
  launchesExamined:launches.length,
  failures:failures.slice(0,40),
}));
process.exit(1);
