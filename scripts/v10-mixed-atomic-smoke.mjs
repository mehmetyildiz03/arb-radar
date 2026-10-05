import { createPublicClient, http, zeroAddress } from 'viem';
import { createPar, getReference, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles } from '../dist/economic/v4Truth.js';
import { quoteMixedCycle } from '../dist/economic/mixedQuote.js';
import { simulateUniversalMixedParity, simulateUniversalMixedAtomic } from '../dist/economic/universalMixed.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(50,Math.max(1,Number(process.env.MIXED_ATOMIC_SMOKE_LAUNCH_LIMIT ?? 30)));
const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:350,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);
const ref=getReference(robinhoodChain.id);
const launches=await discovery.latest(limit);
const failures=[];

function same(a,b){return String(a).toLowerCase()===String(b).toLowerCase()}
function supported(cycle){
  return same(cycle.base,ref.wrapped) &&
    cycle.hops.some(h=>h.v3) &&
    cycle.hops.some(h=>!h.v3) &&
    cycle.hops.every(h=>h.v3||same(h.key.hooks,zeroAddress));
}

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi')continue;
    for(const buy of launch.markets){
      for(const sell of launch.markets){
        if(buy.index===sell.index)continue;
        const cycles=enumerateClosedCycles(launch,buy.index,sell.index)
          .filter(supported)
          .sort((a,b)=>a.hopCount-b.hopCount);
        for(const cycle of cycles){
          try{
            const blockNumber=await client.getBlockNumber({cacheTime:0});
            const amountIn=10n**14n;
            const quote=await quoteMixedCycle(client,cycle,amountIn,blockNumber);
            const parity=await simulateUniversalMixedParity(client,quote);
            if(!parity.atomicVerified||!parity.exactOutputParity)throw Error('mixed parity not verified');
            if(parity.expectedAmountOut!==quote.amountOut)throw Error('atomic parity amount mismatch');

            let profitabilityGatePassed=false;
            if(quote.amountOut>quote.amountIn){
              const atomic=await simulateUniversalMixedAtomic(client,quote);
              profitabilityGatePassed=atomic.atomicVerified&&atomic.exactOutputParity;
            }

            console.log(JSON.stringify({
              ok:true,
              paperOnly:true,
              purpose:'v0.10 Universal Router mixed V3/V4 atomic parity smoke; not realized-profit evidence',
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
              amountIn:quote.amountIn.toString(),
              sequentialAmountOut:quote.amountOut.toString(),
              atomicExpectedAmountOut:parity.expectedAmountOut.toString(),
              grossProfit:parity.grossProfit.toString(),
              grossPositive:quote.amountOut>quote.amountIn,
              atomicVerified:parity.atomicVerified,
              exactOutputParity:parity.exactOutputParity,
              profitabilityGatePassed,
              gasEstimate:parity.gasEstimate?.toString() ?? null,
              gasEstimateSource:parity.gasEstimateSource,
              gasEstimateError:parity.gasEstimateError,
              calldataBytes:parity.calldataBytes,
              routerWethDust:parity.routerWethDust.toString(),
              profitableClaim:false,
              note:'Paper integration proof only; no transaction was sent.',
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
  message:'No supported mixed cycle produced Universal Router atomic parity',
  launchesExamined:launches.length,
  failures:failures.slice(0,50),
}));
process.exit(1);
