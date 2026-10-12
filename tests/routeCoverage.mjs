import test from 'node:test';
import assert from 'node:assert/strict';
import { poolKeyFor, getReference, poolIdOf } from 'par-sdk';
import { classifyLaunchCoverage, summarizeCoverage, bestCoverageCycle } from '../dist/economic/routeCoverage.js';
import { enumerateClosedCycles } from '../dist/economic/v4Truth.js';

const token='0x1111111111111111111111111111111111111111';
const qa='0x2222222222222222222222222222222222222222';
const qb='0x3333333333333333333333333333333333333333';
const usdg='0x4444444444444444444444444444444444444444';
const hook='0x9999999999999999999999999999999999999999';
const ref=getReference(4663);

function pool(a,b,fee=3000,hooks){
  const key=poolKeyFor(a,b,fee,60);
  return hooks?{...key,hooks}:key;
}
function launch(routes, overrides={}){
  const keys=[pool(token,qa,30000),pool(token,qb,30000)];
  return {
    kind:'multi',token,
    markets:[
      {index:0,pairToken:qa,quoteSymbol:'QA',poolKey:keys[0],poolId:poolIdOf(keys[0])},
      {index:1,pairToken:qb,quoteSymbol:'QB',poolKey:keys[1],poolId:poolIdOf(keys[1])},
    ],
    routes,
    ...overrides,
  };
}
function r(hops){
  return {qualifies:true,buyHops:hops.map(({key,v3=false})=>({key,v3})),sellHops:[]};
}

test('hookless v4 pairs are verified-eligible and counted once per direction',()=>{
  const l=launch([r([{key:pool(qa,ref.address)}]),r([{key:pool(qb,ref.address)}])]);
  const pairs=classifyLaunchCoverage(l);
  const s=summarizeCoverage(pairs,1);
  assert.equal(s.directedPairs,2);
  assert.equal(s.eligiblePairs,2);
  assert.equal(s.excludedOnlyByV3,0);
  assert.equal(s.scanErrors,0);
  assert.ok(pairs.every(x=>x.category==='hookless-all-v4'&&x.shortestHopCount===4));
});

test('v3 reference hop is counted as uncovered while preserving all market pair directions',()=>{
  const l=launch([r([{key:pool(qa,ref.address),v3:true}]),r([{key:pool(qb,ref.address)}])]);
  const s=summarizeCoverage(classifyLaunchCoverage(l),1);
  assert.equal(s.directedPairs,2);
  assert.equal(s.classes['mixed-v3-v4'],2);
  assert.equal(s.excludedOnlyByV3,2);
  assert.equal(s.eligiblePairs,0);
});

test('hooked v4 is separate from v3 and never called eligible',()=>{
  const l=launch([r([{key:pool(qa,ref.address,3000,hook)}]),r([{key:pool(qb,ref.address)}])]);
  const s=summarizeCoverage(classifyLaunchCoverage(l),1);
  assert.equal(s.classes['v4-hooks'],2);
  assert.equal(s.eligiblePairs,0);
  assert.equal(s.excludedOnlyByV3,0);
});

test('cancelled common v3 prefix still permits hookless all-v4 cycle',()=>{
  const common={key:pool(usdg,ref.address),v3:true};
  const l=launch([
    r([common,{key:pool(qa,usdg)}]),
    r([common,{key:pool(qb,usdg)}]),
  ]);
  const coverage=classifyLaunchCoverage(l);
  assert.equal(coverage.length,2);
  assert.equal(coverage[0].category,'hookless-all-v4');
  assert.equal(coverage[0].base?.toLowerCase(),usdg.toLowerCase());
  assert.equal(coverage[0].shortestHopCount,4);
  assert.equal(coverage[0].referenceHopCount,6);
  assert.equal(coverage[0].savedReferenceHops,2);
  assert.equal(summarizeCoverage(coverage,1).referenceHopsSaved,4);
});

test('route corruption and disconnected native versus wrapped roots fail closed',()=>{
  const invalid=launch([r([{key:pool(qa,qb)}]),r([{key:pool(qb,ref.address)}])]);
  assert.equal(summarizeCoverage(classifyLaunchCoverage(invalid),1).scanErrors,2);
  const disconnected=launch([
    r([{key:pool(qa,ref.address)}]),
    r([{key:pool(qb,ref.wrapped)}]),
  ]);
  const s=summarizeCoverage(classifyLaunchCoverage(disconnected),1);
  assert.equal(s.classes['no-closed-cycle'],2);
  assert.equal(s.eligiblePairs,0);
});

test('unsupported mixed routes never outrank an alternative verified v4 cycle',()=>{
  const common={key:pool(usdg,ref.address),v3:true};
  const l=launch([
    r([common,{key:pool(qa,usdg)}]),
    r([common,{key:pool(qb,usdg)}]),
  ]);
  const cycles=enumerateClosedCycles(l,0,1);
  assert.ok(cycles.some(c=>!c.allV4));
  assert.equal(bestCoverageCycle(cycles)?.category,'hookless-all-v4');
});
