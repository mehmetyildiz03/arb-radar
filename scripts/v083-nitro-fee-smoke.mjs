import { createPublicClient, http } from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles } from '../dist/economic/v4Truth.js';
import { readNitroFeeComponents } from '../dist/economic/nitroFees.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(30,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 12)));
const client=createPublicClient({chain:robinhoodChain,transport:http(rpc,{retryCount:2,retryDelay:400,timeout:20_000})});
const discovery=new Discovery(createPar({client}),api);

const ethResponse=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
if(!ethResponse.ok) throw new Error('ETH/USD unavailable: '+ethResponse.status);
const ethBody=await ethResponse.json();
const ethUsd=Number(ethBody?.data?.amount);
if(!Number.isFinite(ethUsd)||ethUsd<=0) throw new Error('Invalid ETH/USD');

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
          .filter(c=>c.allV4&&c.hooklessV4)
          .sort((a,b)=>a.hopCount-b.hopCount);
        for(const cycle of cycles){
          try{
            // Calldata-size / poster-fee smoke only. The input is deliberately
            // tiny and is never submitted; NodeInterface estimates a
            // representative executor transaction envelope.
            const amountIn=10n**12n;
            const blockNumber=await client.getBlockNumber({cacheTime:0});
            const fee=await readNitroFeeComponents(client,cycle,amountIn,ethUsd,blockNumber);
            console.log(JSON.stringify({
              ok:true,
              paperOnly:true,
              purpose:'v0.8.3 Nitro transaction-fee calibration smoke; no transaction is submitted',
              token:launch.token,
              base:cycle.base,
              baseSymbol:cycle.baseSymbol,
              hopCount:cycle.hopCount,
              blockNumber:blockNumber.toString(),
              gasEstimate:fee.gasEstimate.toString(),
              gasEstimateForL1:fee.gasEstimateForL1.toString(),
              childGasEstimate:fee.childGasEstimate.toString(),
              baseFeeWei:fee.baseFeeWei.toString(),
              l1BaseFeeEstimateWei:fee.l1BaseFeeEstimateWei.toString(),
              parentDataCostWei:fee.parentDataCostWei.toString(),
              parentDataCostUsd:fee.parentDataCostUsd,
              calldataBytes:fee.calldataBytes,
              legacyAllowanceUsd:.05,
              calibrationBelowLegacyAllowance:fee.parentDataCostUsd<.05,
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
  message:'No supported cycle produced Nitro gas components',
  launchesExamined:launches.length,
  failures:failures.slice(0,20),
}));
process.exit(1);
