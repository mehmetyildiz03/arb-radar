import { createPublicClient, http } from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { classifyLaunchCoverage, summarizeCoverage } from '../dist/economic/routeCoverage.js';

const limit=Math.min(100,Math.max(1,Number(process.env.COVERAGE_LAUNCH_LIMIT ?? 12)));
const delayMs=Math.min(5000,Math.max(0,Number(process.env.COVERAGE_DELAY_MS ?? 1200)));
const retryDelayMs=Math.min(10000,Math.max(0,Number(process.env.COVERAGE_RETRY_DELAY_MS ?? 2500)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function reason(error){
  const text=String(error);
  const match=text.match(/Status:\s*(\d{3})/);
  return match?'rpc-http-'+match[1]:text.slice(0,160);
}
async function metadataWithBoundedRetry(token){
  try {return await discovery.metadata(token);}
  catch(error){
    if(!/Status:\s*(403|429|503)/.test(String(error))) throw error;
    await sleep(retryDelayMs);
    return discovery.metadata(token);
  }
}
const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{timeout:20_000,retryCount:2}),
});
if(await client.getChainId()!==robinhoodChain.id) throw new Error('Wrong Robinhood chain');
const discovery=new Discovery(createPar({client}),api);
const snapshots=await discovery.latest(limit);
const perLaunch=[];
const pairs=[];
const failedLaunches=[];

for(const snap of snapshots){
  if(delayMs>0)await sleep(delayMs);
  try{
    const launch=await metadataWithBoundedRetry(snap.token);
    if(!launch||launch.kind!=='multi'){
      failedLaunches.push({token:snap.token,reason:'typed-multi-launch-unavailable'});
      continue;
    }
    const classified=classifyLaunchCoverage(launch);
    pairs.push(...classified);
    const summary=summarizeCoverage(classified,1);
    perLaunch.push({token:launch.token,marketCount:launch.markets.length,...summary});
  }catch(error){
    failedLaunches.push({token:snap.token,reason:reason(error)});
  }
}

const summary=summarizeCoverage(pairs,perLaunch.length);
const examples=pairs
  .filter(p=>p.category!=='hookless-all-v4')
  .slice(0,15)
  .map(p=>({
    token:p.token,buy:p.buyMarket,sell:p.sellMarket,
    category:p.category,base:p.base,baseSymbol:p.baseSymbol,
    hops:p.shortestHopCount,v3Hops:p.v3HopCount,hookedHops:p.hookedV4HopCount,
    savedReferenceHops:p.savedReferenceHops,error:p.error,
  }));

const report={
  paperOnly:true,
  purpose:'Structural route-coverage audit; no profit, liquidity or execution inference',
  version:'v0.10-phase-a',
  chainId:robinhoodChain.id,
  at:new Date().toISOString(),
  requestedLimit:limit,
  returnedLaunches:snapshots.length,
  classifiedLaunches:perLaunch.length,
  failedLaunches,
  summary,
  perLaunch,
  examples,
  completeness:failedLaunches.length===0 && summary.scanErrors===0 ? 'complete-for-returned-sample':'incomplete-do-not-extrapolate',
  nextStep:summary.excludedOnlyByV3>0
    ? 'Evaluate mixed V3/V4 canonical quote and atomic simulation design'
    : 'Mixed V3/V4 expansion is not justified by this bounded sample alone',
};
console.log(JSON.stringify(report,null,2));
if(snapshots.length===0 || perLaunch.length===0 || summary.directedPairs===0)process.exitCode=1;
if(failedLaunches.length>0 || summary.scanErrors>0)process.exitCode=2;
