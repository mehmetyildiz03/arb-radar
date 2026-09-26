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
    const now=1_800_000_000_000;
    const snapshot=buildDashboardSnapshot(join(dir,'missing.sqlite'),100,now,60_000);
    assert.equal(snapshot.paperOnly,true);
    assert.equal(snapshot.database.exists,false);
    assert.equal(snapshot.database.freshness,'empty');
    assert.equal(snapshot.window.durationMs,60_000);
    assert.equal(snapshot.counts.executableQuotes,0);
    assert.equal(snapshot.radar.quoteBackedCandidates,0);
    assert.deepEqual(snapshot.opportunities,[]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('dashboard uses the time window for quality metrics and keeps display limit separate', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-dashboard-'));
  const dbPath=join(dir,'radar.sqlite');
  const store=new ResearchStore(dbPath);
  const at=1_800_000_000_000;
  const now=at+10_000;
  try {
    store.record('launches','0xtoken',{token:'0xtoken',symbol:'T'},{timestampMs:at,blockNumber:null,source:'fixture'});
    store.record('market_snapshots','0xtoken:0',{index:0},{timestampMs:at,blockNumber:null,source:'fixture'});

    store.record('route_screens','old-route',{route:{token:'0xold'},screen:{passesFeeFloor:true,grossSpreadPct:99}},{timestampMs:at-61_000,blockNumber:null,source:'fixture'});
    store.record('route_screens','route',{route:{token:'0xtoken'},screen:{passesFeeFloor:true,grossSpreadPct:8.5}},{timestampMs:at+1,blockNumber:null,source:'fixture'});

    store.record('executable_quotes','old-positive',{
      route:{token:'0xold',buy:{quoteSymbol:'X'},sell:{quoteSymbol:'Y'}},
      screen:{grossSpreadPct:99},quote:{inputUsd:1,outputUsd:10,gasUsd:0,blockNumber:'1'},netProfitUsd:9
    },{timestampMs:at-61_000,blockNumber:1n,source:'fixture'});

    store.record('executable_quotes','opp-1',{
      route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:8.5},
      quote:{inputUsd:10,outputUsd:11,gasUsd:.1,extraCostsUsd:.05,safetyMarginUsd:.1,blockNumber:'123'},
      netProfitUsd:.75
    },{timestampMs:at+2,blockNumber:123n,source:'fixture'});
    store.record('executable_quotes','opp-2',{status:'unavailable',reason:'fixture failure',route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'C'}}},{timestampMs:at+3,blockNumber:null,source:'fixture'});
    store.record('executable_quotes','opp-3',{
      route:{token:'0xtoken',buy:{quoteSymbol:'C'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:6.2},
      quote:{inputUsd:5,outputUsd:4.8,gasUsd:.1,blockNumber:'124'},
      netProfitUsd:-.3
    },{timestampMs:at+4,blockNumber:124n,source:'fixture'});
    store.record('executable_quotes','opp-1',{
      route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:8.1},
      quote:{inputUsd:1,outputUsd:.95,gasUsd:.02,blockNumber:'125'},
      netProfitUsd:-.07
    },{timestampMs:at+5,blockNumber:125n,source:'fixture'});

    store.record('opportunity_lifecycle','opp-1',{measurementTiming:{
      discoveryToFirstQuoteStartedMs:20,discoveryToFirstQuoteCompletedMs:45,sizingDurationMs:140,
      discoveryToPostSizingLifecycleMs:200,firstExecutableQuoteSucceeded:true,captureCapability:'unproven'
    }},{timestampMs:at+6,blockNumber:null,source:'fixture'});
    store.record('opportunity_lifecycle','opp-1',{targetMs:0,deadlineMissedByMs:0,netProfitUsd:.75},{timestampMs:at+7,blockNumber:123n,source:'fixture'});
    store.record('opportunity_lifecycle','opp-1',{targetMs:100,deadlineMissedByMs:120,netProfitUsd:.2},{timestampMs:at+8,blockNumber:125n,source:'fixture'});

    for (const [i,d] of [10,20,30,40,100].entries()) {
      store.record('rpc_latency_samples','eth_call',{durationMs:d,status:'200'},{timestampMs:at+10+i,blockNumber:null,source:'fixture'});
    }
    store.db.prepare("INSERT INTO executable_quotes(timestamp_ms,block_number,source,observation_key,payload) VALUES (?,?,?,?,?)")
      .run(at+20,null,'fixture','bad','{not-json');
    const before=store.db.prepare('SELECT COUNT(*) AS c FROM executable_quotes').get().c;
    store.close();

    const snapshot=buildDashboardSnapshot(dbPath,1,now,60_000);
    assert.equal(snapshot.database.exists,true);
    assert.equal(snapshot.database.freshness,'live');
    assert.equal(snapshot.radar.qualifyingScreens,1);
    assert.equal(snapshot.radar.quoteBackedCandidates,2);
    assert.equal(snapshot.radar.positiveExecutableQuotes,1);
    assert.equal(snapshot.radar.nonpositiveExecutableQuotes,1);
    assert.equal(snapshot.radar.unavailableQuotes,1);
    assert.equal(snapshot.radar.positiveRatePct,50);
    assert.equal(snapshot.radar.uniqueTokens,1);
    assert.equal(snapshot.radar.medianRpcLatencyMs,30);
    assert.equal(snapshot.radar.p95RpcLatencyMs,100);
    assert.equal(snapshot.radar.medianFirstQuoteMs,45);
    assert.equal(snapshot.radar.p95FirstQuoteMs,45);
    assert.equal(snapshot.radar.medianSizingMs,140);
    assert.equal(snapshot.radar.lifecycleDeadlineSamples,2);
    assert.equal(snapshot.radar.missedLifecycleDeadlines,1);
    assert.equal(snapshot.radar.missedDeadlineRatePct,50);
    assert.equal(snapshot.radar.p95DeadlineMissMs,120);
    assert.equal(snapshot.radar.latestPositiveOpportunity.key,'opp-1');
    assert.equal(snapshot.radar.latestPositiveOpportunity.latestNetProfitUsd,.75);

    assert.equal(snapshot.opportunities.length,1);
    assert.equal(snapshot.opportunities[0].key,'opp-1');
    assert.equal(snapshot.opportunities[0].status,'positive');
    assert.equal(snapshot.opportunities[0].latestNetProfitUsd,-.07);
    assert.equal(snapshot.opportunities[0].bestObservedNetProfitUsd,.75);
    assert.equal(snapshot.opportunities[0].quoteCount,2);
    assert.equal(snapshot.paperPnl.some(x=>x.key==='old-positive'),false);

    const reopened=new ResearchStore(dbPath);
    const after=reopened.db.prepare('SELECT COUNT(*) AS c FROM executable_quotes').get().c;
    reopened.close();
    assert.equal(after,before);
  } finally {
    try { store.close(); } catch {}
    rmSync(dir,{recursive:true,force:true});
  }
});

test('dashboard clamps analysis window to a safe local range', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-dashboard-'));
  try {
    const missing=join(dir,'missing.sqlite');
    assert.equal(buildDashboardSnapshot(missing,100,100_000,1).window.durationMs,10_000);
    assert.equal(buildDashboardSnapshot(missing,100,100_000,9_999_999).window.durationMs,900_000);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
