export interface DepthFailure<F = unknown> {
  inputUsd: number;
  failure: F;
}

export interface DepthSizingResult<Q, F = unknown> {
  quotes: Q[];
  failures: Array<DepthFailure<F>>;
  bestQuote: Q | null;
  firstLiquidityFailureUsd: number | null;
  stoppedReason: 'liquidity-boundary' | 'gross-nonpositive' | 'max-reached' | 'no-quote';
}

function normalizeUsd(value:number):number {
  return Number(value.toFixed(8));
}

export function buildDepthLadder(minUsd:number,maxUsd:number):number[] {
  if(![minUsd,maxUsd].every(Number.isFinite)||minUsd<=0||maxUsd<minUsd) return [];
  const out:number[]=[];
  for(let decade=0;decade<16;decade++){
    for(const factor of [1,3]){
      const value=normalizeUsd(minUsd*factor*10**decade);
      if(value>maxUsd+1e-9) continue;
      if(!out.includes(value)) out.push(value);
    }
    if(minUsd*10**(decade+1)>maxUsd*10+1e-9) break;
  }
  const capped=normalizeUsd(maxUsd);
  if(!out.includes(capped)) out.push(capped);
  return out.sort((a,b)=>a-b);
}

export async function runDepthAwareSizing<Q,F>(options:{
  minUsd:number;
  maxUsd:number;
  extraAmountsUsd?:readonly number[];
  quote:(inputUsd:number)=>Promise<Q>;
  score:(quote:Q)=>number;
  grossPositive:(quote:Q)=>boolean;
  classifyFailure:(error:unknown)=>F & {kind:string};
  onQuote?:(quote:Q,inputUsd:number)=>void;
  onFailure?:(failure:DepthFailure<F>)=>void;
}):Promise<DepthSizingResult<Q,F>> {
  const ladder=buildDepthLadder(options.minUsd,options.maxUsd);
  const quotes:Q[]=[];
  const failures:Array<DepthFailure<F>>=[];
  const attempted=new Set<number>();
  let firstLiquidityFailureUsd:number|null=null;
  let stoppedReason:DepthSizingResult<Q,F>['stoppedReason']='no-quote';

  const tryAmount=async(inputUsd:number):Promise<'continue'|'stop'>=>{
    const amount=normalizeUsd(inputUsd);
    if(attempted.has(amount)) return 'continue';
    attempted.add(amount);
    try{
      const quote=await options.quote(amount);
      quotes.push(quote);
      options.onQuote?.(quote,amount);
      stoppedReason='max-reached';
      if(!options.grossPositive(quote)){
        stoppedReason='gross-nonpositive';
        return 'stop';
      }
      return 'continue';
    }catch(error){
      const failure=options.classifyFailure(error);
      if(failure.kind!=='not-enough-liquidity') throw error;
      const item={inputUsd:amount,failure};
      failures.push(item);
      options.onFailure?.(item);
      firstLiquidityFailureUsd=amount;
      stoppedReason='liquidity-boundary';
      return 'stop';
    }
  };

  for(const amount of ladder){
    if(await tryAmount(amount)==='stop') break;
  }

  if(stoppedReason!=='gross-nonpositive'){
    const upper=firstLiquidityFailureUsd ?? options.maxUsd+1e-9;
    const extras=[...(options.extraAmountsUsd??[])]
      .filter(x=>Number.isFinite(x)&&x>=options.minUsd&&x<=options.maxUsd&&x<upper)
      .map(normalizeUsd)
      .filter((x,i,a)=>a.indexOf(x)===i&&!attempted.has(x))
      .sort((a,b)=>a-b);

    for(const amount of extras){
      if(await tryAmount(amount)==='stop') break;
    }
  }

  const finite=quotes
    .map(quote=>({quote,score:options.score(quote)}))
    .filter(item=>Number.isFinite(item.score))
    .sort((a,b)=>b.score-a.score);
  return {
    quotes,
    failures,
    bestQuote:finite[0]?.quote ?? null,
    firstLiquidityFailureUsd,
    stoppedReason:firstLiquidityFailureUsd!==null && stoppedReason==='max-reached' ? 'liquidity-boundary' : stoppedReason,
  };
}
