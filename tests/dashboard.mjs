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
    store.record('route_screens','route-2',{route:{token:'0xtoken'},screen:{passesFeeFloor:true,grossSpreadPct:7.4}},{timestampMs:at+2,blockNumber:null,source:'fixture'});
    store.record('route_screens','route-3',{route:{token:'0xtoken'},screen:{passesFeeFloor:true,grossSpreadPct:6.2}},{timestampMs:at+3,blockNumber:null,source:'fixture'});

    store.record('executable_quotes','old-positive',{
      route:{token:'0xold',buy:{quoteSymbol:'X'},sell:{quoteSymbol:'Y'}},
      screen:{grossSpreadPct:99},quote:{inputUsd:1,outputUsd:10,gasUsd:0,blockNumber:'1'},netProfitUsd:9
    },{timestampMs:at-61_000,blockNumber:1n,source:'fixture'});

    store.record('executable_quotes','opp-1',{
      route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:8.5},
      quote:{inputUsd:10,outputUsd:11,gasUsd:.1,extraCostsUsd:.05,safetyMarginUsd:.1,blockNumber:'123',
        profile:{blockReadMs:10,buySimulationMs:20,sellSimulationMs:30,buyGasEstimateMs:40,sellGasEstimateMs:50,gasPriceMs:5,blockConfirmMs:10,totalMs:180}},
      netProfitUsd:.75,verifiedClosedCycle:true,engine:'v0.8-economic-truth'
    },{timestampMs:at+2,blockNumber:123n,source:'fixture'});
    store.record('executable_quotes','opp-2',{status:'unavailable',reason:'fixture failure',route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'C'}}},{timestampMs:at+3,blockNumber:null,source:'fixture'});
    store.record('executable_quotes','opp-3',{
      route:{token:'0xtoken',buy:{quoteSymbol:'C'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:6.2},
      quote:{inputUsd:5,outputUsd:4.8,gasUsd:.1,blockNumber:'124'},
      netProfitUsd:-.3,verifiedClosedCycle:true,engine:'v0.8-economic-truth'
    },{timestampMs:at+4,blockNumber:124n,source:'fixture'});
    store.record('executable_quotes','opp-1',{
      route:{token:'0xtoken',buy:{quoteSymbol:'A'},sell:{quoteSymbol:'B'}},
      screen:{grossSpreadPct:8.1},
      quote:{inputUsd:1,outputUsd:.95,gasUsd:.02,blockNumber:'125',
        profile:{blockReadMs:11,buySimulationMs:21,sellSimulationMs:31,buyGasEstimateMs:41,sellGasEstimateMs:51,gasPriceMs:6,blockConfirmMs:11,totalMs:185}},
      netProfitUsd:-.07,verifiedClosedCycle:true,engine:'v0.8-economic-truth'
    },{timestampMs:at+5,blockNumber:125n,source:'fixture'});

    // Quote is written inside the selected window, but the candidate was discovered before it.
    // The legacy key fallback must keep it out of the current funnel.
    const lateOldKey=`0xold:0:1:${at-61_000}`;
    store.record('executable_quotes',lateOldKey,{
      route:{token:'0xold',buy:{quoteSymbol:'X'},sell:{quoteSymbol:'Y'}},
      screen:{grossSpreadPct:80},
      quote:{inputUsd:1,outputUsd:5,gasUsd:0,blockNumber:'126'},
      netProfitUsd:4
    },{timestampMs:at+9,blockNumber:126n,source:'fixture'});

    store.record('opportunity_lifecycle','opp-1',{measurementTiming:{
      queueDelayMs:5,preparationDurationMs:10,
      discoveryToFirstQuoteStartedMs:20,discoveryToFirstQuoteCompletedMs:45,firstQuoteDurationMs:25,
      sizingBarrierWaitMs:30,sizingQueueWaitMs:15,sizingDurationMs:140,sizingTotalPhaseMs:155,
      discoveryToPostSizingLifecycleMs:200,firstExecutableQuoteSucceeded:true,captureCapability:'unproven'
    }},{timestampMs:at+6,blockNumber:null,source:'fixture'});
    store.record('opportunity_lifecycle','opp-1',{targetMs:0,deadlineMissedByMs:0,netProfitUsd:.75},{timestampMs:at+7,blockNumber:123n,source:'fixture'});
    store.record('opportunity_lifecycle','opp-1',{targetMs:100,deadlineMissedByMs:120,netProfitUsd:.2},{timestampMs:at+8,blockNumber:125n,source:'fixture'});
    store.record('opportunity_lifecycle','opp-depth',{discoveredAtMs:at+1,depthFailure:{phase:'probe-or-lifecycle',inputUsd:.01,kind:'not-enough-liquidity',poolId:'0x'+'11'.repeat(32)}},{timestampMs:at+8,blockNumber:125n,source:'fixture'});
    store.record('opportunity_lifecycle','opp-depth',{discoveredAtMs:at+1,depthFailure:{phase:'sizing-depth',inputUsd:.03,kind:'not-enough-liquidity',poolId:'0x'+'11'.repeat(32)}},{timestampMs:at+9,blockNumber:125n,source:'fixture'});
    store.record('opportunity_lifecycle','0xold:0:1:old-timing',{
      measurementTiming:{discoveredAtMs:at-61_000,queueDelayMs:99999,preparationDurationMs:99999,
        discoveryToFirstQuoteCompletedMs:99999,firstQuoteDurationMs:99999,sizingDurationMs:99999}
    },{timestampMs:at+9,blockNumber:null,source:'fixture'});

    for (const [i,d] of [10,20,30,40,100].entries()) {
      store.record('rpc_latency_samples','eth_call',{durationMs:d,status:'200'},{timestampMs:at+10+i,blockNumber:null,source:'fixture'});
    }
    store.record('radar_runtime','tick:fixture',{
      durationMs:320,valuationFetches:1,probeConcurrency:2,sizingConcurrency:1,sizingQuoteConcurrency:2,candidateMaxQueueMs:2500,
      scheduler:{queued:5,droppedStale:1,probesStarted:4,probesCompleted:4,sizingStarted:3,sizingCompleted:3,maxActiveProbes:2,maxActiveSizing:1}
    },{timestampMs:at+30,blockNumber:null,source:'arb-radar:scheduler'});
    store.db.prepare("INSERT INTO executable_quotes(timestamp_ms,block_number,source,observation_key,payload) VALUES (?,?,?,?,?)")
      .run(at+20,null,'fixture','bad','{not-json');
    const before=store.db.prepare('SELECT COUNT(*) AS c FROM executable_quotes').get().c;
    store.close();

    const snapshot=buildDashboardSnapshot(dbPath,1,now,60_000);
    assert.equal(snapshot.database.exists,true);
    assert.equal(snapshot.database.freshness,'live');
    assert.equal(snapshot.radar.qualifyingScreens,3);
    assert.equal(snapshot.radar.quoteBackedCandidates,2);
    assert.equal(snapshot.radar.positiveExecutableQuotes,1);
    assert.equal(snapshot.radar.nonpositiveExecutableQuotes,1);
    assert.equal(snapshot.radar.unavailableQuotes,1);
    assert.equal(snapshot.radar.depthRejectedCandidates,1);
    assert.equal(snapshot.radar.notEnoughLiquidityFailures,2);
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
    assert.equal(snapshot.pipeline.phases.queueDelay.medianMs,5);
    assert.equal(snapshot.pipeline.phases.preparation.medianMs,10);
    assert.equal(snapshot.pipeline.phases.firstQuote.medianMs,25);
    assert.equal(snapshot.pipeline.phases.sizingBarrierWait.medianMs,30);
    assert.equal(snapshot.pipeline.phases.sizingQueueWait.medianMs,15);
    assert.equal(snapshot.pipeline.phases.sizingExecution.medianMs,140);
    assert.equal(snapshot.pipeline.dominantPhase.key,'sizingExecution');
    assert.equal(snapshot.pipeline.simulation.buySimulation.medianMs,20);
    assert.equal(snapshot.pipeline.simulation.sellGasEstimate.medianMs,50);
    assert.equal(snapshot.pipeline.dominantSimulationStep.key,'sellGasEstimate');
    assert.equal(snapshot.runtime.queued,5);
    assert.equal(snapshot.runtime.droppedStale,1);
    assert.equal(snapshot.runtime.probesCompleted,4);
    assert.equal(snapshot.runtime.sizingCompleted,3);
    assert.equal(snapshot.runtime.probeConcurrency,2);
    assert.equal(snapshot.runtime.sizingConcurrency,1);
    assert.equal(snapshot.runtime.sizingQuoteConcurrency,2);
    assert.equal(snapshot.runtime.tickDurationMs,320);
    assert.equal(snapshot.runtime.valuationFetches,1);

    assert.equal(snapshot.opportunities.length,1);
    assert.equal(snapshot.opportunities[0].key,'opp-1');
    assert.equal(snapshot.opportunities[0].status,'positive');
    assert.equal(snapshot.opportunities[0].firstProbeNetProfitUsd,.75);
    assert.equal(snapshot.opportunities[0].latestNetProfitUsd,-.07);
    assert.equal(snapshot.opportunities[0].bestObservedNetProfitUsd,.75);
    assert.equal(snapshot.opportunities[0].firstProbeCostBreakdown.netProfitUsd,.75);
    assert.equal(snapshot.opportunities[0].bestObservedCostBreakdown.reason,'positive-after-explicit-costs');
    assert.equal(snapshot.opportunities[0].firstProbeProfile.buySimulationMs,20);
    assert.equal(snapshot.opportunities[0].quoteCount,2);
    assert.equal(snapshot.pnlTraces.firstProbe.find(x=>x.key==='opp-1').netProfitUsd,.75);
    assert.equal(snapshot.pnlTraces.bestObserved.find(x=>x.key==='opp-1').netProfitUsd,.75);
    assert.equal(snapshot.paperPnl.some(x=>x.key==='old-positive'),false);
    assert.equal(snapshot.opportunities.some(x=>x.key===lateOldKey),false);
    assert.equal(snapshot.pnlTraces.firstProbe.some(x=>x.key===lateOldKey),false);
    assert.ok(snapshot.radar.quoteBackedCandidates <= snapshot.radar.qualifyingScreens);

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


test('dashboard current-run mode isolates metrics across runs and exact funnel ignores row cap', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-run-isolation-'));
  const dbPath=join(dir,'radar.sqlite');
  const store=new ResearchStore(dbPath);
  const now=1_900_000_000_000;
  const oldRun={runId:'run-old',engineVersion:'0.7.0',runStartedAtMs:now-30_000};
  const newRun={runId:'run-new',engineVersion:'0.8.0-economic-truth',runStartedAtMs:now-10_000};
  try {
    store.record('radar_runs',oldRun.runId,oldRun,{timestampMs:oldRun.runStartedAtMs,blockNumber:null,source:'fixture'});
    store.record('radar_runs',newRun.runId,newRun,{timestampMs:newRun.runStartedAtMs,blockNumber:null,source:'fixture'});

    for(let i=0;i<5105;i++){
      store.record('route_screens',`new:${i}`,{
        ...newRun,discoveredAtMs:now-5000+i%1000,
        route:{token:'0xnew'},screen:{passesFeeFloor:true,grossSpreadPct:7}
      },{timestampMs:now-5000+i%1000,blockNumber:null,source:'fixture'});
    }
    for(let i=0;i<10;i++){
      store.record('route_screens',`old:${i}`,{
        ...oldRun,discoveredAtMs:now-4000,
        route:{token:'0xold'},screen:{passesFeeFloor:true,grossSpreadPct:99}
      },{timestampMs:now-4000,blockNumber:null,source:'fixture'});
      store.record('executable_quotes',`old:${i}`,{
        ...oldRun,discoveredAtMs:now-4000,route:{token:'0xold'},screen:{grossSpreadPct:99},
        quote:{inputUsd:1,outputUsd:2,gasUsd:0},netProfitUsd:1,
        verifiedClosedCycle:true,engine:'fixture-verified'
      },{timestampMs:now-3000,blockNumber:1n,source:'fixture'});
    }
    store.record('executable_quotes','new:1',{
      ...newRun,discoveredAtMs:now-5000,route:{token:'0xnew'},screen:{grossSpreadPct:7},
      quote:{inputUsd:1,outputUsd:.9,gasUsd:0},netProfitUsd:-.1,
      verifiedClosedCycle:true,engine:'v0.8-economic-truth'
    },{timestampMs:now-2000,blockNumber:2n,source:'fixture'});
    store.record('opportunity_lifecycle','new:1',{
      ...newRun,measurementTiming:{discoveredAtMs:now-5000,discoveryToFirstQuoteCompletedMs:100,firstQuoteDurationMs:80,sizingDurationMs:200}
    },{timestampMs:now-1900,blockNumber:null,source:'fixture'});
    store.record('opportunity_lifecycle','old:1',{
      ...oldRun,measurementTiming:{discoveredAtMs:now-4000,discoveryToFirstQuoteCompletedMs:9999,firstQuoteDurationMs:9999,sizingDurationMs:9999}
    },{timestampMs:now-1800,blockNumber:null,source:'fixture'});
    store.record('rpc_latency_samples','eth_call',{...newRun,durationMs:20,status:'200'},{timestampMs:now-1700,blockNumber:null,source:'fixture'});
    store.record('rpc_latency_samples','eth_call',{...oldRun,durationMs:9999,status:'200'},{timestampMs:now-1600,blockNumber:null,source:'fixture'});
    store.record('radar_runtime','tick-new',{...newRun,durationMs:300,scheduler:{queued:1,droppedStale:0,probesStarted:1,probesCompleted:1,sizingStarted:1,sizingCompleted:1,maxActiveProbes:1,maxActiveSizing:1}},
      {timestampMs:now-1000,blockNumber:null,source:'fixture'});
    store.record('radar_runtime','tick-old',{...oldRun,durationMs:9000,scheduler:{queued:10,droppedStale:0,probesStarted:10,probesCompleted:10,sizingStarted:10,sizingCompleted:10,maxActiveProbes:1,maxActiveSizing:1}},
      {timestampMs:now-2000,blockNumber:null,source:'fixture'});
    store.close();

    const current=buildDashboardSnapshot(dbPath,500,now,60_000,'current');
    assert.equal(current.run.selectedRunId,'run-new');
    assert.equal(current.run.engineVersion,'0.8.0-economic-truth');
    assert.equal(current.radar.qualifyingScreens,5105);
    assert.equal(current.radar.quoteBackedCandidates,1);
    assert.equal(current.radar.positiveExecutableQuotes,0);
    assert.equal(current.radar.medianRpcLatencyMs,20);
    assert.equal(current.radar.medianFirstQuoteMs,100);
    assert.equal(current.radar.medianSizingMs,200);
    assert.equal(current.runComparison.current.lastTickDurationMs,300);
    assert.equal(current.runComparison.previous.lastTickDurationMs,9000);

    const old=buildDashboardSnapshot(dbPath,500,now,60_000,'run-old');
    assert.equal(old.radar.qualifyingScreens,10);
    assert.equal(old.radar.quoteBackedCandidates,10);
    assert.equal(old.radar.positiveExecutableQuotes,10);
    assert.equal(old.radar.medianRpcLatencyMs,9999);
  } finally {
    try { store.close(); } catch {}
    rmSync(dir,{recursive:true,force:true});
  }
});


test('unverified legacy positive quote never becomes a verified green candidate', () => {
  const dir=mkdtempSync(join(tmpdir(),'arb-radar-unverified-'));
  const dbPath=join(dir,'radar.sqlite');
  const store=new ResearchStore(dbPath);
  const now=2_000_000_000_000;
  const run={runId:'run-v08',engineVersion:'0.8.0-economic-truth',runStartedAtMs:now-1000};
  try {
    store.record('radar_runs',run.runId,run,{timestampMs:run.runStartedAtMs,blockNumber:null,source:'fixture'});
    store.record('route_screens','candidate',{...run,discoveredAtMs:now-500,route:{token:'0x1'},screen:{passesFeeFloor:true,grossSpreadPct:10}},
      {timestampMs:now-500,blockNumber:null,source:'fixture'});
    store.record('executable_quotes','candidate',{...run,discoveredAtMs:now-500,route:{token:'0x1'},screen:{grossSpreadPct:10},
      quote:{inputUsd:1,outputUsd:2,gasUsd:0},netProfitUsd:1,verifiedClosedCycle:false},
      {timestampMs:now-400,blockNumber:1n,source:'fixture'});
    store.close();
    const snapshot=buildDashboardSnapshot(dbPath,100,now,60_000,'current');
    assert.equal(snapshot.radar.qualifyingScreens,1);
    assert.equal(snapshot.radar.quoteBackedCandidates,0);
    assert.equal(snapshot.radar.positiveExecutableQuotes,0);
    assert.equal(snapshot.opportunities[0].status,'nonpositive');
    assert.equal(snapshot.opportunities[0].verifiedClosedCycle,false);
  } finally {
    try { store.close(); } catch {}
    rmSync(dir,{recursive:true,force:true});
  }
});
