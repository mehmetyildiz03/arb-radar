import { createPublicClient, http } from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import {
  prepareLaunchEconomicCandidates,
  quotePreparedEconomicCandidate,
} from '../dist/economic/engine.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const launchLimit=Math.min(30,Math.max(1,Number(process.env.TRUTH_LAUNCH_LIMIT ?? 30)));
const scans=Math.min(20,Math.max(1,Number(process.env.SWEEP_SCANS ?? 8)));
const candidateLimit=Math.min(20,Math.max(1,Number(process.env.SWEEP_CANDIDATE_LIMIT ?? 6)));
const sizes=(process.env.SWEEP_SIZES_USD ?? '0.01,0.03,0.1,0.3,1,3,10')
  .split(',').map(Number).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
const minNet=Number(process.env.MIN_NET_PROFIT_USD ?? 0.05);

const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:300,timeout:15_000}),
});
const discovery=new Discovery(createPar({client}),api);

async function ethUsd(){
  const response=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if(!response.ok) throw new Error('ETH/USD unavailable '+response.status);
  const body=await response.json();
  const value=Number(body?.data?.amount);
  if(!Number.isFinite(value)||value<=0) throw new Error('Invalid ETH/USD');
  return value;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

let candidateObservations=0;
let exactQuotes=0;
let quoteFailures=0;
let verifiedPositive=0;
let best=null;
const structuralSeen=new Set();

for(let scan=0;scan<scans;scan++){
  const snapshots=await discovery.latest(launchLimit);
  const blockNumber=await client.getBlockNumber({cacheTime:0});
  const usdPerEth=await ethUsd();
  const candidates=[];

  for(const snapshot of snapshots){
    try{
      const launch=await discovery.metadata(snapshot.token);
      if(!launch||launch.kind!=='multi') continue;
      const prepared=await prepareLaunchEconomicCandidates(client,launch,snapshot,usdPerEth,{
        paperCapitalUsd:100,
        maxTradeUsd:100,
        minTradeUsd:0.01,
        blockNumber,
      });
      candidates.push(...prepared);
    }catch(error){
      console.error(JSON.stringify({kind:'prepare-error',scan,token:snapshot.token,error:String(error)}));
    }
  }

  candidates.sort((a,b)=>b.truth.infinitesimalEdgeBps-a.truth.infinitesimalEdgeBps);
  const selected=candidates.slice(0,candidateLimit);
  console.log(JSON.stringify({
    kind:'scan-summary',
    scan,
    blockNumber:blockNumber.toString(),
    launches:snapshots.length,
    truthCandidates:candidates.length,
    selected:selected.length,
  }));

  for(const prepared of selected){
    candidateObservations++;
    const structuralKey=[
      prepared.launch.token,
      prepared.cycle.buyMarket,
      prepared.cycle.sellMarket,
      prepared.cycle.base.toLowerCase(),
    ].join(':');
    structuralSeen.add(structuralKey);
    const quoteBlock=await client.getBlockNumber({cacheTime:0});
    const results=[];

    for(const inputUsd of sizes){
      try{
        const quote=await quotePreparedEconomicCandidate(client,prepared,inputUsd,{
          extraCostsUsd:0.05,
          safetyBps:100,
          gasBufferBps:2000,
          blockNumber:quoteBlock,
        });
        exactQuotes++;
        const result={
          inputUsd,
          outputUsd:quote.outputUsd,
          grossEdgeUsd:quote.costBreakdown.grossQuotedEdgeUsd,
          gasUsd:quote.gasUsd,
          extraCostsUsd:quote.extraCostsUsd,
          safetyMarginUsd:quote.safetyMarginUsd,
          netProfitUsd:quote.costBreakdown.netProfitUsd,
          netReturnPct:quote.costBreakdown.netReturnPct,
          reason:quote.costBreakdown.reason,
          green:quote.green&&quote.costBreakdown.netProfitUsd>=minNet,
        };
        results.push(result);
        if(result.green) verifiedPositive++;
        if(!best||result.netProfitUsd>best.result.netProfitUsd){
          best={
            token:prepared.launch.token,
            buyMarket:prepared.cycle.buyMarket,
            sellMarket:prepared.cycle.sellMarket,
            base:prepared.cycle.base,
            baseSymbol:prepared.cycle.baseSymbol,
            hopCount:prepared.cycle.hopCount,
            screenBlock:prepared.truth.blockNumber.toString(),
            quoteBlock:quote.blockNumber.toString(),
            infinitesimalEdgeBps:prepared.truth.infinitesimalEdgeBps,
            seedTrusted:prepared.seedTrusted,
            seedUsd:prepared.seedUsd,
            result,
          };
        }
      }catch(error){
        quoteFailures++;
        results.push({inputUsd,error:String(error)});
      }
    }

    console.log(JSON.stringify({
      kind:'candidate-sweep',
      scan,
      token:prepared.launch.token,
      buyMarket:prepared.cycle.buyMarket,
      sellMarket:prepared.cycle.sellMarket,
      base:prepared.cycle.base,
      baseSymbol:prepared.cycle.baseSymbol,
      hopCount:prepared.cycle.hopCount,
      infinitesimalEdgeBps:prepared.truth.infinitesimalEdgeBps,
      seedTrusted:prepared.seedTrusted,
      seedUsd:prepared.seedUsd,
      quoteBlock:quoteBlock.toString(),
      results,
    }));
  }

  if(scan+1<scans) await sleep(1000);
}

console.log(JSON.stringify({
  kind:'final-summary',
  paperOnly:true,
  purpose:'sub-$1 exact closed-cycle sizing audit',
  sizes,
  scans,
  candidateObservations,
  structuralCandidates:structuralSeen.size,
  exactQuotes,
  quoteFailures,
  verifiedPositive,
  minNetProfitUsd:minNet,
  best,
}));
