import { readFileSync, writeFileSync } from 'node:fs';
const launches = JSON.parse(readFileSync('tests/fixtures/long5-launches.json','utf8'));
// Bounded research cohort, explicitly not an exhaustive symbol history.
const cohort = launches.filter(x => x.symbol.toUpperCase() === 'LONG5' && x.tradeCount > 0).sort((a,b)=>b.tradeCount-a.tradeCount).slice(0,5);
const captures=[];
for (const launch of cohort) {
 const url=`https://api.par.family/trades?token=${launch.token}&limit=2000`;
 const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
 captures.push({token:launch.token,url,status:r.status,capturedAt:new Date().toISOString(),trades:r.ok?await r.json():[]});
}
writeFileSync('tests/fixtures/long5-trades.json',JSON.stringify(captures,null,2)+'\n');
