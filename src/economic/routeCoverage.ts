import { zeroAddress, type Address } from 'viem';
import type { TradableLaunch } from 'par-sdk';
import { enumerateClosedCycles, type ClosedCycle } from './v4Truth.js';

export type CoverageClass = 'hookless-all-v4' | 'v4-hooks' | 'mixed-v3-v4' | 'no-closed-cycle' | 'route-error';

export interface PairCoverage {
  token: Address;
  buyMarket: number;
  sellMarket: number;
  category: CoverageClass;
  cycleCount: number;
  shortestHopCount: number | null;
  referenceHopCount: number | null;
  savedReferenceHops: number | null;
  base: Address | null;
  baseSymbol: string | null;
  v3HopCount: number;
  hookedV4HopCount: number;
  error: string | null;
}

export interface CoverageSummary {
  launches: number;
  directedPairs: number;
  classes: Record<CoverageClass,number>;
  excludedOnlyByV3: number;
  eligiblePairs: number;
  structurallyClosedPairs: number;
  pairsWithCompressedBase: number;
  referenceHopsSaved: number;
  scanErrors: number;
}

export function bestCoverageCycle(cycles: readonly ClosedCycle[]): {category: Exclude<CoverageClass,'no-closed-cycle'|'route-error'>;cycle: ClosedCycle} | null {
  if(!cycles.length) return null;
  // A pair is already supported whenever ANY hookless all-v4 cycle exists,
  // regardless of whether the physically shortest alternative is mixed-v3.
  const supported=cycles.filter(c=>c.allV4&&c.hooklessV4);
  const hooked=cycles.filter(c=>c.allV4&&!c.hooklessV4);
  const mixed=cycles.filter(c=>!c.allV4);
  const choice = (supported.length ? ['hookless-all-v4',supported]
    : hooked.length ? ['v4-hooks',hooked]
    : ['mixed-v3-v4',mixed]) as [Exclude<CoverageClass,'no-closed-cycle'|'route-error'>,ClosedCycle[]];
  const cycle=[...choice[1]].sort((a,b)=>a.hopCount-b.hopCount ||
    a.base.toLowerCase().localeCompare(b.base.toLowerCase()))[0]!;
  return {category:choice[0],cycle};
}

export function classifyLaunchCoverage(launch: TradableLaunch): PairCoverage[] {
  if(launch.kind!=='multi') return [];
  const out:PairCoverage[]=[];
  for(const buy of launch.markets){
    for(const sell of launch.markets){
      if(buy.index===sell.index) continue;
      const base={
        token:launch.token,
        buyMarket:buy.index,
        sellMarket:sell.index,
        cycleCount:0,
        shortestHopCount:null,
        referenceHopCount:null,
        savedReferenceHops:null,
        base:null,
        baseSymbol:null,
        v3HopCount:0,
        hookedV4HopCount:0,
        error:null,
      };
      try{
        const cycles=enumerateClosedCycles(launch,buy.index,sell.index);
        const selected=bestCoverageCycle(cycles);
        if(!selected){
          out.push({...base,category:'no-closed-cycle'});continue;
        }
        const shortestSelected=selected.cycle;
        // Compare against the uncompressed reference-root cycle only if the
        // same pair has one; otherwise leave the benchmark unknown.
        const longest=cycles
          .filter(c=>c.hopCount>=shortestSelected.hopCount)
          .sort((a,b)=>b.hopCount-a.hopCount)[0];
        const reference=longest?.hopCount ?? null;
        const saved=reference===null ? null : Math.max(0,reference-shortestSelected.hopCount);
        out.push({
          ...base,
          category:selected.category,
          cycleCount:cycles.length,
          shortestHopCount:shortestSelected.hopCount,
          referenceHopCount:reference,
          savedReferenceHops:saved,
          base:shortestSelected.base,
          baseSymbol:shortestSelected.baseSymbol,
          v3HopCount:shortestSelected.hops.filter(h=>h.v3).length,
          hookedV4HopCount:shortestSelected.hops.filter(h=>!h.v3 && h.key.hooks.toLowerCase()!==zeroAddress).length,
        });
      }catch(error){
        out.push({...base,category:'route-error',error:String(error)});
      }
    }
  }
  return out;
}

export function summarizeCoverage(pairs:readonly PairCoverage[],launches:number):CoverageSummary {
  const classes:Record<CoverageClass,number>={
    'hookless-all-v4':0,
    'v4-hooks':0,
    'mixed-v3-v4':0,
    'no-closed-cycle':0,
    'route-error':0,
  };
  for(const p of pairs) classes[p.category]++;
  const compressed=pairs.filter(p=>(p.savedReferenceHops??0)>0);
  return {
    launches,
    directedPairs:pairs.length,
    classes,
    excludedOnlyByV3:classes['mixed-v3-v4'] -
      pairs.filter(p=>p.category==='mixed-v3-v4'&&p.hookedV4HopCount>0).length,
    eligiblePairs:classes['hookless-all-v4'],
    structurallyClosedPairs:pairs.length-classes['no-closed-cycle']-classes['route-error'],
    pairsWithCompressedBase:compressed.length,
    referenceHopsSaved:compressed.reduce((sum,p)=>sum+(p.savedReferenceHops??0),0),
    scanErrors:classes['route-error'],
  };
}
