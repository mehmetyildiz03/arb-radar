import { createPublicClient, http } from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles } from '../dist/economic/v4Truth.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const limit=Math.min(50,Math.max(1,Number(process.env.ROUTE_COVERAGE_LAUNCH_LIMIT ?? 30)));

const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:350,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);

function category(cycle){
  if(cycle.hooklessV4) return 'hookless-all-v4';
  if(cycle.hops.some(h=>h.v3)) return 'mixed-v3-v4';
  if(cycle.allV4 && cycle.hops.some(h=>String(h.key.hooks).toLowerCase()!=='0x0000000000000000000000000000000000000000')) {
    return 'hooked-v4';
  }
  return 'unsupported';
}

function cycleRank(cycle){
  const cat=category(cycle);
  const rank=cat==='hookless-all-v4'?0:cat==='mixed-v3-v4'?1:cat==='hooked-v4'?2:3;
  return [rank,cycle.hopCount,cycle.base.toLowerCase()];
}

function compareCycles(a,b){
  const ra=cycleRank(a),rb=cycleRank(b);
  if(ra[0]!==rb[0]) return ra[0]-rb[0];
  if(ra[1]!==rb[1]) return ra[1]-rb[1];
  return String(ra[2]).localeCompare(String(rb[2]));
}

const launches=await discovery.latest(limit);
const rows=[];
const scanFailures=[];
const totals={
  launchesExamined:launches.length,
  multiLaunches:0,
  directedPairs:0,
  pairsWithAnyCycle:0,
  pairsWithHooklessAllV4:0,
  pairsOnlyMixedV3V4:0,
  pairsOnlyHookedV4:0,
  pairsUnsupported:0,
  shortestCycleHooklessAllV4:0,
  shortestCycleMixedV3V4:0,
  shortestCycleHookedV4:0,
  shortestCycleUnsupported:0,
  compressedBelowEthRoot:0,
};

for(const snapshot of launches){
  try{
    const launch=await discovery.metadata(snapshot.token);
    if(!launch||launch.kind!=='multi') continue;
    totals.multiLaunches++;
    for(const buy of launch.markets){
      for(const sell of launch.markets){
        if(buy.index===sell.index) continue;
        totals.directedPairs++;
        let cycles=[];
        try{
          cycles=enumerateClosedCycles(launch,buy.index,sell.index);
        }catch(error){
          rows.push({
            token:launch.token,buyMarket:buy.index,sellMarket:sell.index,
            status:'enumeration-error',error:String(error),
          });
          continue;
        }
        if(!cycles.length){
          totals.pairsUnsupported++;
          rows.push({
            token:launch.token,buyMarket:buy.index,sellMarket:sell.index,
            status:'no-cycle',
          });
          continue;
        }

        totals.pairsWithAnyCycle++;
        const cats=new Set(cycles.map(category));
        if(cats.has('hookless-all-v4')) totals.pairsWithHooklessAllV4++;
        else if(cats.has('mixed-v3-v4')) totals.pairsOnlyMixedV3V4++;
        else if(cats.has('hooked-v4')) totals.pairsOnlyHookedV4++;
        else totals.pairsUnsupported++;

        const shortest=[...cycles].sort(compareCycles)[0];
        const shortestCategory=category(shortest);
        if(shortestCategory==='hookless-all-v4') totals.shortestCycleHooklessAllV4++;
        else if(shortestCategory==='mixed-v3-v4') totals.shortestCycleMixedV3V4++;
        else if(shortestCategory==='hooked-v4') totals.shortestCycleHookedV4++;
        else totals.shortestCycleUnsupported++;

        // A compressed cycle with fewer hops than an ETH-rooted candidate means
        // common-prefix cancellation found a nearer base. This is structural only.
        const ethRoot=cycles.find(c=>c.baseSymbol==='ETH');
        if(ethRoot && shortest.hopCount<ethRoot.hopCount) totals.compressedBelowEthRoot++;

        rows.push({
          token:launch.token,
          buyMarket:buy.index,
          sellMarket:sell.index,
          buyQuote:buy.quoteSymbol,
          sellQuote:sell.quoteSymbol,
          cycleCount:cycles.length,
          categories:[...cats].sort(),
          shortest:{
            category:shortestCategory,
            base:shortest.base,
            baseSymbol:shortest.baseSymbol,
            hopCount:shortest.hopCount,
            v3HopCount:shortest.hops.filter(h=>h.v3).length,
            hookedHopCount:shortest.hops.filter(h=>!h.v3&&String(h.key.hooks).toLowerCase()!=='0x0000000000000000000000000000000000000000').length,
            roles:shortest.hops.map(h=>h.role),
          },
        });
      }
    }
  }catch(error){
    scanFailures.push({token:snapshot.token,error:String(error)});
  }
}

const materialMixedShare=totals.directedPairs>0
  ? totals.pairsOnlyMixedV3V4/totals.directedPairs
  : 0;
const currentlyVerifiedShare=totals.directedPairs>0
  ? totals.pairsWithHooklessAllV4/totals.directedPairs
  : 0;

console.log(JSON.stringify({
  ok:scanFailures.length===0,
  paperOnly:true,
  purpose:'v0.10 structural route coverage audit; no profitability claim',
  totals,
  shares:{
    currentlyVerifiedShare,
    mixedOnlyShare:materialMixedShare,
    hookedOnlyShare:totals.directedPairs?totals.pairsOnlyHookedV4/totals.directedPairs:0,
  },
  decisionHint:materialMixedShare>=0.05
    ? 'mixed-v3-v4 coverage is material enough to justify implementation research'
    : 'mixed-v3-v4 coverage is small in this sample; prioritize other bottlenecks first',
  scanFailures,
  rows,
},null,2));

if(scanFailures.length) process.exitCode=1;
