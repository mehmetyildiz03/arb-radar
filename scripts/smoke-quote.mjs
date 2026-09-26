import {createPar,createParClient} from 'par-sdk';
import {normalizeLaunch} from '../dist/adapters/parIndexer.js';
import {enumerateDirectedRoutes} from '../dist/arbitrage/routes.js';
import {selectMarkets,simulateRoute} from '../dist/adapters/simulation.js';
import {readFileSync,writeFileSync} from 'node:fs';
const raw=JSON.parse(readFileSync('tests/fixtures/long5-launches.json','utf8')).find(x=>x.token==='0xc8ae1ae44c79af0a529a8acfffa425654771c812');
const client=createParClient();const par=createPar({client});const started=Date.now();
try {
 const meta=await par.getTradable(raw.token);
 const routes=enumerateDirectedRoutes(normalizeLaunch(raw));
 let chosen;
 for(const route of routes){try{selectMarkets(meta,route);chosen=route;break}catch{}}
 if(!chosen)throw Error('All routes require shared-pool stateful simulation');
 const response=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
 const body=await response.json();
 const quote=await simulateRoute(client,meta,chosen,1,{usdPerEth:Number(body.data.amount),timestampMs:Date.now(),source:'coinbase:ETH-USD/spot'},{extraCostsUsd:0.05,safetyBps:100,source:'public Robinhood RPC'});
 const report={paperOnly:true,at:new Date().toISOString(),durationMs:Date.now()-started,route:chosen,quote};
 writeFileSync('docs/LIVE_SMOKE.json',JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
 console.log('Quote smoke succeeded',report.durationMs);
}catch(e){writeFileSync('docs/LIVE_SMOKE.json',JSON.stringify({paperOnly:true,at:new Date().toISOString(),durationMs:Date.now()-started,error:String(e)},null,2)+'\n');console.error(String(e));process.exitCode=1;}
