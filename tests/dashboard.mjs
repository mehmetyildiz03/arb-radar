import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchStore } from '../dist/research/store.js';
import { buildDashboardSnapshot } from '../dist/dashboard/data.js';

test('dashboard returns a valid empty state when database is missing', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-dashboard-'));
  try {
    const snapshot=buildDashboardSnapshot(join(dir,'missing.sqlite'));
    assert.equal(snapshot.paperOnly,true);
    assert.equal(snapshot.database.exists,false);
    assert.equal(snapshot.counts.executableQuotes,0);
    assert.deepEqual(snapshot.opportunities,[]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('dashboard aggregates paper quotes, timings and RPC latency without mutating data', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-dashboard-'));
  const dbPath=join(dir,'radar.sqlite');
  const store=new ResearchStore(dbPath);
  try {
    const at=1_800_000_000_000;
    store.record('launches','0xtoken',{token:'0xtoken',symbol:'T'},{timestampMs:at,blockNumber:null,source:'fixture'});
    store.record('market_snapshots','0xtoken:0',{index:0},{timestampMs:at,blockNumber:null,source:'fixture'});
    store.record('route_screens','route',{screen:{passesFeeFloor:true,grossSpreadPct:8.5}},{timestampMs:at+1,blockNumber:null,source:'fixture'});
    store.record('executable_quotes','opp-1',{
      route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:8.5},
      quote:{inputUsd:10,outputUsd:11,gasUsd:.1,extraCostsUsd:.05,safetyMarginUsd:.1,blockNumber:'123'},
      netProfitUsd:.75
    },{timestampMs:at+2,blockNumber:123n,source:'fixture'});
    store.record('executable_quotes','opp-2',{status:'unavailable',reason:'fixture failure',route:{}},{timestampMs:at+3,blockNumber:null,source:'fixture'});
    store.record('opportunity_lifecycle','opp-1',{measurementTiming:{
      discoveryToFirstQuoteStartedMs:20,discoveryToFirstQuoteCompletedMs:45,sizingDurationMs:140,
      discoveryToPostSizingLifecycleMs:200,firstExecutableQuoteSucceeded:true,captureCapability:'unproven'
    }},{timestampMs:at+4,blockNumber:null,source:'fixture'});
    for (const [i,d] of [10,20,30,40,100].entries()) {
      store.record('rpc_latency_samples','eth_call',{durationMs:d,status:'200'},{timestampMs:at+10+i,blockNumber:null,source:'fixture'});
    }
    store.db.prepare("INSERT INTO executable_quotes(timestamp_ms,block_number,source,observation_key,payload) VALUES (?,?,?,?,?)")
      .run(at+20,null,'fixture','bad','{not-json');
    const before=store.db.prepare('SELECT COUNT(*) AS c FROM executable_quotes').get().c;
    store.close();

    const snapshot=buildDashboardSnapshot(dbPath,100);
    assert.equal(snapshot.database.exists,true);
    assert.equal(snapshot.radar.qualifyingScreens,1);
    assert.equal(snapshot.radar.positiveExecutableQuotes,1);
    assert.equal(snapshot.radar.unavailableQuotes,1);
    assert.equal(snapshot.radar.medianRpcLatencyMs,30);
    assert.equal(snapshot.radar.p95RpcLatencyMs,100);
    assert.equal(snapshot.opportunities.length,2);
    assert.equal(snapshot.timings.length,1);
    assert.equal(snapshot.timings[0].discoveryToFirstQuoteCompletedMs,45);

    const reopened=new ResearchStore(dbPath);
    const after=reopened.db.prepare('SELECT COUNT(*) AS c FROM executable_quotes').get().c;
    reopened.close();
    assert.equal(after,before);
  } finally {
    try { store.close(); } catch {}
    rmSync(dir,{recursive:true,force:true});
  }
});
