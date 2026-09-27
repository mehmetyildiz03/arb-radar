export interface ConstantProductSeedInput {
  buyQuoteReserve: number;
  buyTokenReserve: number;
  sellTokenReserve: number;
  sellQuoteReserve: number;
  buyFeeMultiplier: number;
  sellFeeMultiplier: number;
  baseToBuyQuoteRate: number;
  sellQuoteToBaseRate: number;
}

export function optimalBaseInputConstantProduct(input: ConstantProductSeedInput): number | null {
  const {
    buyQuoteReserve:x,
    buyTokenReserve:y,
    sellTokenReserve:u,
    sellQuoteReserve:v,
    buyFeeMultiplier:a,
    sellFeeMultiplier:b,
    baseToBuyQuoteRate:sA,
    sellQuoteToBaseRate:sB,
  }=input;
  if(![x,y,u,v,a,b,sA,sB].every(Number.isFinite)) return null;
  if(x<=0||y<=0||u<=0||v<=0||a<=0||a>1||b<=0||b>1||sA<=0||sB<=0) return null;

  // q is buy-quote input. Composition:
  // tokenOut = y*a*q/(x+a*q)
  // sellQuoteOut = v*b*tokenOut/(u+b*tokenOut)
  // baseOut = sB*sellQuoteOut; baseIn = q/sA
  const N=v*b*y*a;
  const D=u*x;
  const E=a*(u+b*y);
  const radicand=sA*sB*N*D;
  if(!Number.isFinite(radicand)||radicand<=0||E<=0) return null;
  const q=(Math.sqrt(radicand)-D)/E;
  if(!Number.isFinite(q)||q<=0) return null;
  const baseInput=q/sA;
  return Number.isFinite(baseInput)&&baseInput>0?baseInput:null;
}

export function seedValidationAmounts(seedUsd:number, minUsd:number, maxUsd:number): number[] {
  if(![seedUsd,minUsd,maxUsd].every(Number.isFinite)||minUsd<=0||maxUsd<minUsd) return [];
  const clipped=Math.min(maxUsd,Math.max(minUsd,seedUsd));
  const values=[clipped*0.75,clipped,clipped*1.25]
    .map(x=>Math.min(maxUsd,Math.max(minUsd,x)))
    .map(x=>Number(x.toFixed(8)));
  return [...new Set(values)].sort((a,b)=>a-b);
}
