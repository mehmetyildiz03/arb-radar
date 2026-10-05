import {
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { poolIdOf } from 'par-sdk';
import {
  ROBINHOOD_V4_QUOTER,
  v4QuoterAbi,
  type ClosedCycle,
  type DirectedPoolHop,
} from './v4Truth.js';

export const ROBINHOOD_V3_QUOTER_V2: Address = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';

export const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);

export interface MixedQuoteStep {
  protocol: 'v3' | 'v4';
  hopStart: number;
  hopEnd: number;
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
}

export interface MixedCycleQuote {
  blockNumber: bigint;
  cycle: ClosedCycle;
  amountIn: bigint;
  amountOut: bigint;
  gasEstimateProxy: bigint;
  steps: MixedQuoteStep[];
  grossMultiplier: number;
  atomicVerified: false;
}

function same(a:Address,b:Address):boolean {
  return a.toLowerCase()===b.toLowerCase();
}

function assertSimpleDistinctPools(cycle:ClosedCycle):void {
  const seen=new Set<string>();
  for(const hop of cycle.hops){
    const id=hop.v3
      ? ['v3',hop.key.currency0.toLowerCase(),hop.key.currency1.toLowerCase(),String(hop.key.fee)].join(':')
      : 'v4:'+poolIdOf(hop.key).toLowerCase();
    if(seen.has(id)) throw new Error('Repeated pool in mixed cycle requires stateful atomic simulation');
    seen.add(id);
  }
}

function assertDirectedHop(hop:DirectedPoolHop):void {
  const matchesForward=same(hop.input,hop.key.currency0)&&same(hop.output,hop.key.currency1);
  const matchesReverse=same(hop.input,hop.key.currency1)&&same(hop.output,hop.key.currency0);
  if(!matchesForward&&!matchesReverse) throw new Error('Directed mixed hop does not match pool currencies');
}

async function quoteV3Hop(
  client:PublicClient,
  hop:DirectedPoolHop,
  amountIn:bigint,
  blockNumber:bigint,
):Promise<{amountOut:bigint;gasEstimate:bigint}> {
  if(!hop.v3) throw new Error('Expected v3 hop');
  if(same(hop.input,zeroAddress)||same(hop.output,zeroAddress)) {
    throw new Error('V3 hop cannot use native currency; wrapped currency required');
  }
  assertDirectedHop(hop);
  const result=await client.simulateContract({
    account:'0x000000000000000000000000000000000000dEaD',
    address:ROBINHOOD_V3_QUOTER_V2,
    abi:quoterV2Abi,
    functionName:'quoteExactInputSingle',
    args:[{
      tokenIn:hop.input,
      tokenOut:hop.output,
      amountIn,
      fee:hop.key.fee,
      sqrtPriceLimitX96:0n,
    }],
    blockNumber,
  });
  const [amountOut,, ,gasEstimate]=result.result;
  if(amountOut<=0n) throw new Error('V3 QuoterV2 returned zero output');
  return {amountOut,gasEstimate};
}

async function quoteV4Segment(
  client:PublicClient,
  hops:readonly DirectedPoolHop[],
  amountIn:bigint,
  blockNumber:bigint,
):Promise<{amountOut:bigint;gasEstimate:bigint}> {
  if(!hops.length||hops.some(h=>h.v3)) throw new Error('Expected contiguous V4 segment');
  for(const hop of hops){
    assertDirectedHop(hop);
    if(!same(hop.key.hooks,zeroAddress)) throw new Error('Hooked V4 hop is outside mixed verified-quote support');
  }
  const path=hops.map(hop=>({
    intermediateCurrency:hop.output,
    fee:hop.key.fee,
    tickSpacing:hop.key.tickSpacing,
    hooks:hop.key.hooks,
    hookData:'0x' as Hex,
  }));
  const result=await client.simulateContract({
    account:'0x000000000000000000000000000000000000dEaD',
    address:ROBINHOOD_V4_QUOTER,
    abi:v4QuoterAbi,
    functionName:'quoteExactInput',
    args:[{exactCurrency:hops[0]!.input,path,exactAmount:amountIn}],
    blockNumber,
  });
  const [amountOut,gasEstimate]=result.result;
  if(amountOut<=0n) throw new Error('V4Quoter returned zero output');
  return {amountOut,gasEstimate};
}

export async function quoteMixedCycle(
  client:PublicClient,
  cycle:ClosedCycle,
  amountIn:bigint,
  blockNumber:bigint,
):Promise<MixedCycleQuote> {
  if(amountIn<=0n) throw new Error('Mixed cycle input must be positive');
  if(!cycle.hops.length) throw new Error('Mixed cycle path is empty');
  if(cycle.allV4) throw new Error('Use canonical all-V4 quote path for all-V4 cycle');
  if(!same(cycle.hops[0]!.input,cycle.base)||!same(cycle.hops.at(-1)!.output,cycle.base)) {
    throw new Error('Mixed cycle is not closed in the same base asset');
  }
  if(cycle.hops.some(h=>!h.v3&&!same(h.key.hooks,zeroAddress))) {
    throw new Error('Hooked V4 hop is outside mixed quote support');
  }
  assertSimpleDistinctPools(cycle);

  let amount=amountIn;
  let gasEstimateProxy=0n;
  const steps:MixedQuoteStep[]=[];

  for(let i=0;i<cycle.hops.length;){
    const hop=cycle.hops[i]!;
    if(hop.v3){
      const quoted=await quoteV3Hop(client,hop,amount,blockNumber);
      steps.push({
        protocol:'v3',hopStart:i,hopEnd:i,
        amountIn:amount,amountOut:quoted.amountOut,gasEstimate:quoted.gasEstimate,
      });
      amount=quoted.amountOut;
      gasEstimateProxy+=quoted.gasEstimate;
      i++;
      continue;
    }

    let end=i;
    while(end+1<cycle.hops.length&&!cycle.hops[end+1]!.v3) end++;
    const segment=cycle.hops.slice(i,end+1);
    const quoted=await quoteV4Segment(client,segment,amount,blockNumber);
    steps.push({
      protocol:'v4',hopStart:i,hopEnd:end,
      amountIn:amount,amountOut:quoted.amountOut,gasEstimate:quoted.gasEstimate,
    });
    amount=quoted.amountOut;
    gasEstimateProxy+=quoted.gasEstimate;
    i=end+1;
  }

  return {
    blockNumber,
    cycle,
    amountIn,
    amountOut:amount,
    gasEstimateProxy,
    steps,
    grossMultiplier:Number(amount)/Number(amountIn),
    atomicVerified:false,
  };
}
