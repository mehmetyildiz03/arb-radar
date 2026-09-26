import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zeroAddress, parseEther } from 'viem';
import { poolKeyFor, poolIdOf } from 'par-sdk';
import { screenRoute, enumerateDirectedRoutes } from '../dist/arbitrage/routes.js';
import { optimizeRoute } from '../dist/arbitrage/optimizer.js';
import { normalizeLaunch } from '../dist/adapters/parIndexer.js';
import { resilientFetch } from '../dist/adapters/network.js';
import { Discovery } from '../dist/adapters/discovery.js';
import { selectMarkets, simulateRoute, netProfit } from '../dist/adapters/simulation.js';
import { verifyEntry, decodeVerified, decodeL2 } from '../dist/adapters/feedDecoder.js';
import { ResearchStore, tables } from '../dist/research/store.js';
import { ShadowState } from '../dist/research/shadow.js';
import { replayTrades } from '../dist/research/replay.js';
import { trackLifecycle, summarizeLifecycle } from '../dist/research/lifecycle.js';
import { measureCandidate } from '../dist/research/measurement.js';
import { originalReport, originalLong5 } from '../scripts/long5-target.mjs';

const token = '0x1111111111111111111111111111111111111111';
const pair = '0x2222222222222222222222222222222222222222';
const router = '0x3333333333333333333333333333333333333333';
const buy = { index: 0, pairToken: zeroAddress, quoteSymbol: 'ETH', tokenPriceEth: 1, priceAtMs: 1000 };
const sell = { index: 1, pairToken: pair, quoteSymbol: 'Q', tokenPriceEth: 1.1, priceAtMs: 1000 };
const route = { token, buy, sell, poolFeeUnits: 30000 };
const launch = { token, symbol:'T', kind:'multi', poolFeeUnits:30000, marketCount:2, markets:[buy,sell] };

test('unequal fees and extra routing costs change fee-floor decision', () => {
  const r = { ...route, buy: { ...buy, poolFeeUnits: 1000 }, sell: { ...sell, poolFeeUnits: 90000 } };
  assert.equal(screenRoute(r).passesFeeFloor, false);
  assert.equal(screenRoute(route, 500).passesFeeFloor, false);
});
test('invalid, zero, negative, stale and unknown-time prices fail closed', () => {
  for (const price of [0,-1,NaN,Infinity]) assert.equal(screenRoute({...route,buy:{...buy,tokenPriceEth:price}}),null);
  assert.equal(screenRoute({...route,buy:{...buy,stale:true}}),null);
  assert.equal(screenRoute(route,0,{nowMs:2001,maxAgeMs:1000}),null);
  assert.equal(screenRoute({...route,buy:{...buy,priceAtMs:undefined}},0,{nowMs:1000,maxAgeMs:1000}),null);
  assert.equal(screenRoute(route,NaN),null);
});
test('missing and duplicate markets cannot produce invented routes', () => {
  assert.equal(enumerateDirectedRoutes({...launch,markets:[buy]}).length,0);
  assert.equal(enumerateDirectedRoutes({...launch,markets:[buy,buy]}).length,0);
  assert.equal(normalizeLaunch({token,poolFee:30000,markets:[{lastPriceEth:1}]}).markets.length,0);
});
test('optimizer rejects missing gas, input mismatch and safety-erased profits', async () => {
  for (const q of [{inputUsd:1,outputUsd:2,gasUsd:NaN},{inputUsd:0,outputUsd:2,gasUsd:0},{inputUsd:1,outputUsd:2,gasUsd:0,safetyMarginUsd:2}]) {
    assert.equal(await optimizeRoute(route,async()=>q,{capitalUsd:1,maxTradeUsd:1}),null);
  }
});
test('HTTP backoff honors retry-after and is bounded', async () => {
  let calls=0; const waits=[];
  const f=resilientFetch(async()=>{calls++;return new Response('',{status:calls<3?429:200,headers:{'retry-after':'1'}})},async ms=>{waits.push(ms)});
  assert.equal((await f('https://example.test')).status,200);assert.deepEqual(waits,[1000,1000]);
  calls=0; const failed=resilientFetch(async()=>{calls++;return new Response('',{status:503})},async()=>{});
  assert.equal((await failed('https://example.test')).status,503);assert.equal(calls,4);
});
test('SQLite has provenance on all observation tables and exact bigint JSON', () => {
  const store=new ResearchStore(':memory:');
  for(const table of tables){store.record(table,'key',{raw:1234567890123456789n},{timestampMs:100,blockNumber:42n,source:'fixture'});
    const row=store.db.prepare(`SELECT * FROM ${table}`).get();assert.equal(row.block_number,'42');assert.equal(JSON.parse(row.payload).raw,'1234567890123456789');}
  store.close();
});
test('lifecycle uses absolute targets and measures actual late completions', async () => {
  let now=0,i=0;const clock={now:()=>now,sleep:async ms=>{now+=ms}};
  const samples=await trackLifecycle(async()=>{now+=150;return [4,3,1,-1,-2][i++]},x=>x,()=>{},clock);
  assert.deepEqual(samples.map(s=>s.targetMs),[0,100,250,500,1000]);
  assert.deepEqual(samples.map(s=>s.elapsedMs),[150,300,450,650,1150]);
  assert.equal(summarizeLifecycle(samples).crossingMs,650);
  assert.equal(summarizeLifecycle(samples).halfLifeMs,450);
});
test('failed requotes remain unknown, not zero-profit crossings', async () => {
  let now=0,i=0;
  const s=await trackLifecycle(async()=>{if(i++===1)throw Error('429');return 1},x=>x,()=>{},{now:()=>now,sleep:async ms=>{now+=ms}});
  assert.equal(s[1].netProfitUsd,null);assert.equal(summarizeLifecycle(s).status,'unknown');assert.equal(summarizeLifecycle(s).crossingMs,null);
});

function tradable() {
  const markets=[buy,sell].map(m=>({...m,poolKey:poolKeyFor(token,m.pairToken,30000,10)}));
  for(const m of markets)m.poolId=poolIdOf(m.poolKey);
  return {token,kind:'multi',router,markets,routes:[{qualifies:true,buyHops:[],sellHops:[]},{qualifies:true,buyHops:[{key:poolKeyFor(pair,zeroAddress,3000,60),v3:false}],sellHops:[{key:poolKeyFor(pair,zeroAddress,3000,60),v3:false}]}]};
}
test('simulator quotes selected markets at one block, includes routing, gas and safety', async () => {
  const calls=[];const meta=tradable();
  const client={getBlock:async()=>({number:50n,hash:'0xabc'}),simulateContract:async args=>{calls.push(args);return {result:args.functionName==='buyWithEth'?123n:parseEther('0.04')}},estimateContractGas:async()=>100000n,getGasPrice:async()=>1000000000n};
  const q=await simulateRoute(client,meta,route,100,{usdPerEth:3000,timestampMs:Date.now(),source:'fixture'},{extraCostsUsd:0.05,safetyBps:100,source:'fixture'});
  assert.equal(q.outputUsd,120);assert.equal(q.gasUnits,240000n);assert.equal(q.safetyMarginUsd,1.2);assert.ok(netProfit(q)>0);
  assert.equal(calls[0].blockNumber,50n);assert.equal(calls[1].blockNumber,50n);assert.equal(calls[0].args[1][0].market,0);assert.equal(calls[1].args[1][0].market,1);assert.equal(calls[1].args[1][0].amountIn,123n);assert.equal(calls[1].args[1][0].hops.length,1);
});
test('overlapping pools and absent reference routes are excluded',()=>{
  const m=tradable();m.routes[0].buyHops=m.routes[1].sellHops;
  assert.throws(()=>selectMarkets(m,route),/Shared pool/);
  m.routes[1]=null;assert.throws(()=>selectMarkets(m,route),/Missing/);
});
test('real sequencer signature and transaction decoder fixture',async()=>{
  const entry=JSON.parse(readFileSync('tests/fixtures/sequencer-verified.json','utf8'));
  assert.equal(await verifyEntry(entry),true);assert.equal(await verifyEntry(entry,4664),false);
  assert.equal((await decodeVerified(entry)).transactions.length,2);
  assert.equal(await verifyEntry({...entry,sequenceNumber:entry.sequenceNumber+1}),false);
  assert.equal(await verifyEntry({...entry,signatureV2:''}),false);
  assert.throws(()=>decodeL2(Buffer.from([3,0,1])),/Truncated/);
});
test('shadow state invalidates on reorg/gap and rejects divergent RPC',()=>{
  const s=new ShadowState();assert.equal(s.observe(1,'0xaa').status,'new');
  s.reconcile('pool',4n,4n,1n);assert.equal(s.pools.size,1);
  assert.equal(s.observe(1,'0xbb').status,'reorg');assert.equal(s.pools.size,0);
  assert.equal(s.observe(3,'0xcc').status,'gap');assert.equal(s.reconcile('pool',4n,5n,3n),false);
});
test('LONG5 fixtures replay deterministically without invented P&L',()=>{
  const launches=JSON.parse(readFileSync('tests/fixtures/long5-launches.json','utf8'));
  const captures=JSON.parse(readFileSync('tests/fixtures/long5-trades.json','utf8'));
  for(const c of captures){assert.equal(c.status,200);const raw=launches.find(l=>l.token===c.token);const r=replayTrades(raw,c.trades);
    assert.deepEqual(r,replayTrades(raw,[...c.trades].reverse()));assert.ok(r.frames.length>0);
    assert.ok(r.frames.every(f=>f.netPnlUsd===null&&f.halfLifeMs===null));}
});

test('metadata cache reuses immutable reads and refreshes routing qualification', async()=>{
  let now=0,calls=0;const discovery=new Discovery({getTradable:async()=>{calls++;return tradable()}},'https://example.test',()=>now);
  await discovery.metadata(token);await discovery.metadata(token);assert.equal(calls,1);
  now=60001;await discovery.metadata(token);assert.equal(calls,2);
});
test('gas reserve keeps a $100 paper wallet within its total budget',async()=>{
  const q=await optimizeRoute(route,async(_r,inputUsd)=>({inputUsd,outputUsd:inputUsd*2,gasUsd:2}),{capitalUsd:100,maxTradeUsd:100,minTradeUsd:100});
  assert.equal(q,null);
});
test('simulation rejects a reorg and never falls back after a revert',async()=>{
  let blocks=0;
  const client={getBlock:async()=>({number:50n,hash:blocks++===0?'0xaa':'0xbb'}),simulateContract:async()=>({result:1n}),estimateContractGas:async()=>1n,getGasPrice:async()=>1n};
  const value={usdPerEth:3000,timestampMs:Date.now(),source:'fixture'},opts={extraCostsUsd:0.05,safetyBps:100,source:'fixture'};
  await assert.rejects(()=>simulateRoute(client,tradable(),route,1,value,opts),/Block changed/);
  client.simulateContract=async()=>{throw Error('revert')};
  await assert.rejects(()=>simulateRoute(client,tradable(),route,1,value,opts),/revert/);
});

test('exhaustive optimizer cannot reset discovery clock or delay first probe', async () => {
  const discoveredAtMs = 1000;
  let now = 1300; // Already queued for 300ms since its first qualifying screen.
  const clock = { now: () => now, sleep: async ms => { now += ms; } };
  const calls = [], recorded = [], timings = [];
  const result = await measureCandidate({
    discoveredAtMs,
    prepare: async () => { now += 200; return {}; },
    quote: async () => { calls.push('probe'); now += 50; return 1; },
    size: async () => optimizeRoute(route, async (_route, inputUsd) => {
      calls.push('size'); now += 100;
      return { inputUsd, outputUsd: inputUsd * 1.2, gasUsd: 0.01 };
    }, { capitalUsd: 100, maxTradeUsd: 50, steps: 8 }),
    profit: q => q, recordSample: s => recorded.push(s), recordTiming: t => timings.push(t),
  }, clock);
  assert.equal(calls[0], 'probe'); assert.equal(calls.filter(c => c === 'size').length, 8);
  assert.equal(result.timing.firstExecutableQuoteStartedMs, 1500);
  assert.equal(result.timing.firstExecutableQuoteCompletedMs, 1550);
  assert.equal(result.timing.sizingStartedMs, 1550); assert.equal(result.timing.sizingCompletedMs, 2350);
  assert.equal(result.timing.discoveryToFirstQuoteCompletedMs, 550);
  assert.equal(result.timing.sizingDurationMs, 800);
  assert.equal(result.timing.discoveryToPostSizingLifecycleMs, 1350);
  assert.deepEqual(recorded.map(s => s.targetMs), [0,100,250,500,1000]);
  assert.deepEqual(recorded.map(s => s.deadlineMs), [1000,1100,1250,1500,2000]);
  assert.equal(recorded[1].startedMs, 2350); assert.equal(recorded[1].elapsedMs, 1400);
  assert.equal(recorded[1].deadlineMissedByMs, 1250);
  assert.ok(recorded.every(s => s.discoveredAtMs === discoveredAtMs));
  assert.deepEqual(timings, [result.timing]);
});
test('unavailable first quote and preparation failure retain timing without fake capture', async () => {
  let now=100, sizeCalls=0; const timings=[];
  const options={discoveredAtMs:0, prepare:async()=>null,
    quote:async()=>{now+=25;throw Error('RPC unavailable')}, size:async()=>{sizeCalls++},
    profit:q=>q,recordSample:()=>{},recordTiming:t=>timings.push(t)};
  const clock={now:()=>now,sleep:async ms=>{now+=ms}};
  const result=await measureCandidate(options,clock);
  assert.equal(sizeCalls,0);assert.equal(result.samples[0].netProfitUsd,null);
  assert.equal(result.timing.firstExecutableQuoteSucceeded,false);
  assert.equal(result.timing.firstExecutableQuoteCompletedMs,125);
  assert.equal(result.timing.sizingStartedMs,null);
  await assert.rejects(()=>measureCandidate({...options,prepare:async()=>{throw Error('metadata unavailable')}},clock));
  assert.equal(timings[1].discoveredAtMs,0);assert.equal(timings[1].firstExecutableQuoteStartedMs,null);
});
test('sizing failure persists duration and original discovery timestamp', async () => {
  let now=10, timing;
  await assert.rejects(()=>measureCandidate({discoveredAtMs:0,prepare:async()=>null,quote:async()=>1,
    size:async()=>{now+=900;throw Error('sizing failed')},profit:q=>q,recordSample:()=>{},recordTiming:t=>{timing=t}
  },{now:()=>now,sleep:async ms=>{now+=ms}}),/sizing failed/);
  assert.equal(timing.sizingDurationMs,900);assert.equal(timing.discoveredAtMs,0);
  assert.equal(timing.postSizingLifecycleStartedMs,null);
});
test('original LONG5 is address-pinned and never substituted when unavailable', () => {
  const fixture=JSON.parse(readFileSync('tests/fixtures/long5-original.json','utf8'));
  const report=originalReport(fixture);
  assert.equal(report.token,originalLong5);assert.equal(report.role,'original-research-target');
  assert.equal(report.status,'partial-indexer-history');assert.equal(report.replay.trades,2000);
  assert.ok(report.replay.frames.every(f=>f.netPnlUsd===null&&f.bestExecutableSizeUsd===null));
  const absent=originalReport({...fixture,launch:{...fixture.launch,status:404,body:null}});
  assert.equal(absent.status,'launch-unavailable');assert.equal(absent.token,originalLong5);assert.equal(absent.replay,null);
  const noHistory=originalReport({...fixture,trades:{...fixture.trades,status:200,body:[]}});
  assert.equal(noHistory.status,'historical-trades-unavailable');assert.equal(noHistory.netPnlUsd,null);
  assert.throws(()=>originalReport({...fixture,token}),/target mismatch/);
});
