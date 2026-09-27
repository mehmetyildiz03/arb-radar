import {
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  getReference,
  poolIdOf,
  type Hop,
  type PoolKey,
  type TradableLaunch,
} from 'par-sdk';

export const ROBINHOOD_STATE_VIEW: Address = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const ROBINHOOD_V4_QUOTER: Address = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const v4QuoterAbi = parseAbi([
  'function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);

export interface DirectedPoolHop {
  input: Address;
  output: Address;
  key: PoolKey;
  v3: boolean;
  role: 'reference' | 'par-buy' | 'par-sell';
}

export interface ClosedCycle {
  token: Address;
  buyMarket: number;
  sellMarket: number;
  base: Address;
  baseSymbol: string;
  hops: DirectedPoolHop[];
  referenceToBase: DirectedPoolHop[];
  hopCount: number;
  allV4: boolean;
}

export interface V4PoolState {
  poolId: Hex;
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: bigint;
}

export interface CycleTruth {
  blockNumber: bigint;
  cycle: ClosedCycle;
  states: Record<string,V4PoolState>;
  infinitesimalMultiplier: number;
  infinitesimalEdgeBps: number;
  passesInfinitesimalEdge: boolean;
}

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function otherCurrency(key: PoolKey, input: Address): Address {
  if (same(key.currency0,input)) return key.currency1;
  if (same(key.currency1,input)) return key.currency0;
  throw new Error('Route hop does not contain current currency');
}

function walk(reference: Address, hops: readonly Hop[]): { currencies: Address[]; steps: DirectedPoolHop[] } {
  const currencies: Address[]=[reference];
  const steps: DirectedPoolHop[]=[];
  let current=reference;
  for(const hop of hops){
    const output=otherCurrency(hop.key,current);
    steps.push({input:current,output,key:hop.key,v3:hop.v3,role:'reference'});
    currencies.push(output);
    current=output;
  }
  return {currencies,steps};
}

function reverseSteps(steps: readonly DirectedPoolHop[]): DirectedPoolHop[] {
  return [...steps].reverse().map(step=>({
    ...step,
    input:step.output,
    output:step.input,
  }));
}

function marketHop(launch: TradableLaunch, index:number, side:'buy'|'sell'): DirectedPoolHop {
  const market=launch.markets[index];
  if(!market) throw new Error('Missing market');
  return side==='buy'
    ? {input:market.pairToken,output:launch.token,key:market.poolKey,v3:false,role:'par-buy'}
    : {input:launch.token,output:market.pairToken,key:market.poolKey,v3:false,role:'par-sell'};
}

function symbolForBase(launch: TradableLaunch, base: Address, chainId:number): string {
  const ref=getReference(chainId);
  if(same(base,ref.address)) return ref.symbol;
  if(same(base,ref.wrapped)) return 'W'+ref.symbol;
  const market=launch.markets.find(m=>same(m.pairToken,base));
  return market?.quoteSymbol ?? (base.slice(0,6)+'…'+base.slice(-4));
}

export function enumerateClosedCycles(
  launch: TradableLaunch,
  buyMarket: number,
  sellMarket: number,
  chainId = 4663,
): ClosedCycle[] {
  if(launch.kind!=='multi' || buyMarket===sellMarket) return [];
  const buy=launch.markets[buyMarket],sell=launch.markets[sellMarket];
  const buyRoute=launch.routes[buyMarket],sellRoute=launch.routes[sellMarket];
  if(!buy||!sell||!buyRoute||!sellRoute) return [];

  const ref=getReference(chainId);
  const a=walk(ref.address,buyRoute.buyHops);
  const b=walk(ref.address,sellRoute.buyHops);
  if(!same(a.currencies.at(-1)!,buy.pairToken) || !same(b.currencies.at(-1)!,sell.pairToken)) {
    throw new Error('Reference route endpoint mismatch');
  }

  const cycles: ClosedCycle[]=[];
  for(let ia=0;ia<a.currencies.length;ia++){
    const base=a.currencies[ia]!;
    for(let ib=0;ib<b.currencies.length;ib++){
      if(!same(base,b.currencies[ib]!)) continue;
      const referenceToBase=a.steps.slice(0,ia);
      const toBuy=a.steps.slice(ia);
      const fromSell=reverseSteps(b.steps.slice(ib));
      const hops=[
        ...toBuy,
        marketHop(launch,buyMarket,'buy'),
        marketHop(launch,sellMarket,'sell'),
        ...fromSell,
      ];
      if(hops.length===0 || !same(hops[0]!.input,base) || !same(hops.at(-1)!.output,base)) continue;
      cycles.push({
        token:launch.token,
        buyMarket,
        sellMarket,
        base,
        baseSymbol:symbolForBase(launch,base,chainId),
        hops,
        referenceToBase,
        hopCount:hops.length,
        allV4:hops.every(h=>!h.v3),
      });
    }
  }

  const unique=new Map<string,ClosedCycle>();
  for(const cycle of cycles){
    const key=[cycle.base.toLowerCase(),...cycle.hops.map(h=>poolIdOf(h.key).toLowerCase())].join(':');
    if(!unique.has(key)) unique.set(key,cycle);
  }
  return [...unique.values()].sort((x,y)=>
    Number(y.allV4)-Number(x.allV4) ||
    x.hopCount-y.hopCount ||
    x.base.toLowerCase().localeCompare(y.base.toLowerCase()));
}

function zeroForOne(hop: DirectedPoolHop): boolean {
  if(same(hop.input,hop.key.currency0) && same(hop.output,hop.key.currency1)) return true;
  if(same(hop.input,hop.key.currency1) && same(hop.output,hop.key.currency0)) return false;
  throw new Error('Directed hop does not match pool currencies');
}

export function directionalProtocolFee(packed:number, isZeroForOne:boolean): number {
  return isZeroForOne ? packed & 0xfff : (packed >> 12) & 0xfff;
}

export function totalSwapFeePips(protocolFee:number, lpFee:number): number {
  if(protocolFee<0||protocolFee>1000||lpFee<0||lpFee>1_000_000) throw new Error('Invalid v4 fee');
  return protocolFee + lpFee - Math.floor((protocolFee*lpFee)/1_000_000);
}

export function rawSpotRate(hop: DirectedPoolHop, state: V4PoolState, includeFee=true): number {
  const sqrt=Number(state.sqrtPriceX96)/2**96;
  const p=sqrt*sqrt;
  if(!Number.isFinite(p)||p<=0) throw new Error('Invalid sqrt price');
  const z=zeroForOne(hop);
  const rate=z?p:1/p;
  if(!includeFee) return rate;
  const protocol=directionalProtocolFee(state.protocolFee,z);
  const fee=totalSwapFeePips(protocol,state.lpFee);
  return rate*(1-fee/1_000_000);
}

export function cycleSpotMultiplier(cycle:ClosedCycle, states:Record<string,V4PoolState>, includeFee=true): number {
  let multiplier=1;
  for(const hop of cycle.hops){
    if(hop.v3) throw new Error('V3 hop has no v4 state truth');
    const id=poolIdOf(hop.key).toLowerCase();
    const state=states[id];
    if(!state) throw new Error('Missing pool state '+id);
    multiplier*=rawSpotRate(hop,state,includeFee);
  }
  return multiplier;
}

export async function readV4States(
  client: PublicClient,
  cycles: readonly ClosedCycle[],
  blockNumber: bigint,
): Promise<Record<string,V4PoolState>> {
  const ids=new Map<string,Hex>();
  for(const cycle of cycles){
    for(const hop of [...cycle.hops,...cycle.referenceToBase]){
      if(hop.v3) continue;
      const id=poolIdOf(hop.key);
      ids.set(id.toLowerCase(),id);
    }
  }
  const unique=[...ids.values()];
  if(unique.length===0) return {};

  const slotContracts=unique.map(id=>({
    address:ROBINHOOD_STATE_VIEW,
    abi:stateViewAbi,
    functionName:'getSlot0' as const,
    args:[id] as const,
  }));
  const liquidityContracts=unique.map(id=>({
    address:ROBINHOOD_STATE_VIEW,
    abi:stateViewAbi,
    functionName:'getLiquidity' as const,
    args:[id] as const,
  }));
  const [slots,liquidities]=await Promise.all([
    client.multicall({contracts:slotContracts,blockNumber,allowFailure:false}),
    client.multicall({contracts:liquidityContracts,blockNumber,allowFailure:false}),
  ]);

  const entries=unique.map((id,index)=>{
    const slot0=slots[index] as readonly [bigint,number,number,number];
    const liquidity=liquidities[index] as bigint;
    const [sqrtPriceX96,tick,protocolFee,lpFee]=slot0;
    const state:V4PoolState={
      poolId:id,
      sqrtPriceX96,
      tick:Number(tick),
      protocolFee:Number(protocolFee),
      lpFee:Number(lpFee),
      liquidity,
    };
    return [id.toLowerCase(),state] as const;
  });
  return Object.fromEntries(entries);
}

export function cycleTruthFromStates(
  cycle: ClosedCycle,
  states: Record<string,V4PoolState>,
  blockNumber: bigint,
): CycleTruth {
  if(!cycle.allV4) throw new Error('Same-block v4 truth requires an all-v4 cycle');
  const infinitesimalMultiplier=cycleSpotMultiplier(cycle,states,true);
  return {
    blockNumber,
    cycle,
    states,
    infinitesimalMultiplier,
    infinitesimalEdgeBps:(infinitesimalMultiplier-1)*10_000,
    passesInfinitesimalEdge:infinitesimalMultiplier>1,
  };
}

export async function readCycleTruth(
  client: PublicClient,
  cycle: ClosedCycle,
  blockNumber?: bigint,
): Promise<CycleTruth> {
  if(!cycle.allV4) throw new Error('Same-block v4 truth requires an all-v4 cycle');
  if(cycle.referenceToBase.some(h=>h.v3)) throw new Error('Same-block base valuation contains v3');
  const block=blockNumber ?? await client.getBlockNumber({cacheTime:0});
  const states=await readV4States(client,[cycle],block);
  return cycleTruthFromStates(cycle,states,block);
}

export interface ClosedCycleQuote {
  blockNumber: bigint;
  cycle: ClosedCycle;
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
  grossMultiplier: number;
}

export async function quoteClosedCycle(
  client: PublicClient,
  cycle: ClosedCycle,
  amountIn: bigint,
  blockNumber: bigint,
): Promise<ClosedCycleQuote> {
  if(!cycle.allV4) throw new Error('Canonical V4Quoter requires an all-v4 cycle');
  if(amountIn<=0n || amountIn>(2n**128n-1n)) throw new Error('Invalid uint128 cycle input');
  const path=cycle.hops.map(hop=>({
    intermediateCurrency:hop.output,
    fee:hop.key.fee,
    tickSpacing:hop.key.tickSpacing,
    hooks:hop.key.hooks,
    hookData:'0x' as Hex,
  }));
  const simulation=await client.simulateContract({
    address:ROBINHOOD_V4_QUOTER,
    abi:v4QuoterAbi,
    functionName:'quoteExactInput',
    args:[{exactCurrency:cycle.base,path,exactAmount:amountIn}],
    blockNumber,
  });
  const [amountOut,gasEstimate]=simulation.result;
  return {
    blockNumber,
    cycle,
    amountIn,
    amountOut,
    gasEstimate,
    grossMultiplier:Number(amountOut)/Number(amountIn),
  };
}

export function referenceToBaseSpot(cycle:ClosedCycle, states:Record<string,V4PoolState>): number {
  let multiplier=1;
  for(const hop of cycle.referenceToBase){
    if(hop.v3) throw new Error('Base valuation path contains v3');
    const state=states[poolIdOf(hop.key).toLowerCase()];
    if(!state) throw new Error('Missing base valuation state');
    multiplier*=rawSpotRate(hop,state,false);
  }
  return multiplier;
}

export function bestStructuralCycle(cycles:readonly ClosedCycle[]): ClosedCycle | null {
  return cycles.find(c=>c.allV4) ?? cycles[0] ?? null;
}

export { zeroAddress };
