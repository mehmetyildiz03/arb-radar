import { createPublicClient, http, zeroAddress } from 'viem';
import { createPar, getReference, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles, quoteClosedCycle, readCycleTruth } from '../dist/economic/v4Truth.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(30,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 12)));
const client=createPublicClient({chain:robinhoodChain,transport:http(rpc,{retryCount:2,retryDelay:400,timeout:15_000})});
const discovery=new Discovery(createPar({client}),api);
const ref=getReference(robinhoodChain.id);
const launches=await discovery.latest(limit);
const failures=[];

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi') continue;
    for(const buy of launch.markets){
      for(const sell of launch.markets){
        if(buy.index===sell.index) continue;
        const cycles=enumerateClosedCycles(launch,buy.index,sell.index)
          .filter(c=>c.allV4&&c.hooklessV4);
        for(const cycle of cycles){
          try{
            const blockNumber=await client.getBlockNumber({cacheTime:0});
            const truth=await readCycleTruth(client,cycle,blockNumber);
            const market=launch.markets.find(m=>m.pairToken.toLowerCase()===cycle.base.toLowerCase());
            const decimals=cycle.base.toLowerCase()===zeroAddress.toLowerCase() ||
              cycle.base.toLowerCase()===ref.wrapped.toLowerCase()
              ? 18
              : market?.quoteDecimals ?? 18;
            const amountIn=10n**BigInt(Math.max(0,decimals-4));
            const quote=await quoteClosedCycle(client,cycle,amountIn,blockNumber);
            if(quote.amountOut<=0n) throw new Error('quoter returned zero output');
            console.log(JSON.stringify({
              ok:true,
              paperOnly:true,
              purpose:'v0.8 canonical closed-cycle integration smoke; not profitability evidence',
              token:launch.token,
              buyMarket:buy.index,
              sellMarket:sell.index,
              base:cycle.base,
              baseSymbol:cycle.baseSymbol,
              hopCount:cycle.hopCount,
              blockNumber:blockNumber.toString(),
              amountIn:amountIn.toString(),
              amountOut:quote.amountOut.toString(),
              quoterGasEstimate:quote.gasEstimate.toString(),
              infinitesimalEdgeBps:truth.infinitesimalEdgeBps,
              profitableClaim:false,
            }));
            process.exit(0);
          }catch(error){
            failures.push({token:launch.token,buy:buy.index,sell:sell.index,base:cycle.base,error:String(error)});
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
  message:'No supported live closed cycle could be quoted',
  launchesExamined:launches.length,
  failures:failures.slice(0,20),
}));
process.exit(1);
