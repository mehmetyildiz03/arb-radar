import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { getReference, robinhoodChain } from 'par-sdk';
import type { ClosedCycle, DirectedPoolHop } from './v4Truth.js';
import type { MixedCycleQuote, MixedQuoteStep } from './mixedQuote.js';

export const ROBINHOOD_UNIVERSAL_ROUTER: Address = '0x204FAca1764B154221e35c0d20aBb3c525710498';
export const UNIVERSAL_MIXED_CALLER: Address = '0x000000000000000000000000000000000000dEaD';

const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
const OPEN_DELTA = 0n;

const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_WRAP_ETH = 0x0b;
const CMD_UNWRAP_WETH = 0x0c;
const CMD_V4_SWAP = 0x10;

const ACTION_SWAP_EXACT_IN = 0x07;
const ACTION_SETTLE = 0x0b;
const ACTION_TAKE = 0x0e;

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);

const erc20BalanceAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

function same(a:Address,b:Address):boolean {
  return a.toLowerCase()===b.toLowerCase();
}

function rawRpc(client:PublicClient):{request(args:{method:string;params:unknown[]}):Promise<unknown>} {
  return client as unknown as {request(args:{method:string;params:unknown[]}):Promise<unknown>};
}

function commandByte(value:number):Hex {
  return toHex(value,{size:1});
}

function encodeV3Path(hops:readonly DirectedPoolHop[]):Hex {
  if(!hops.length||hops.some(h=>!h.v3)) throw new Error('Expected contiguous V3 segment');
  const parts:Hex[]=[hops[0]!.input as Hex];
  let current=hops[0]!.input;
  for(const hop of hops){
    if(!same(hop.input,current)) throw new Error('Discontinuous V3 path');
    if(same(hop.input,zeroAddress)||same(hop.output,zeroAddress)) throw new Error('V3 path requires wrapped/ERC20 currencies');
    parts.push(toHex(hop.key.fee,{size:3}));
    parts.push(hop.output as Hex);
    current=hop.output;
  }
  return concatHex(parts);
}

function encodeWrapEth(amountIn:bigint):Hex {
  return encodeAbiParameters(
    [{type:'address'},{type:'uint256'}],
    [ADDRESS_THIS,amountIn],
  );
}

function encodeUnwrapWeth(minAmount:bigint):Hex {
  return encodeAbiParameters(
    [{type:'address'},{type:'uint256'}],
    [MSG_SENDER,minAmount],
  );
}

function encodeV3Command(hops:readonly DirectedPoolHop[], step:MixedQuoteStep):Hex {
  return encodeAbiParameters(
    [
      {type:'address'},
      {type:'uint256'},
      {type:'uint256'},
      {type:'bytes'},
      {type:'bool'},
      {type:'uint256[]'},
    ],
    [
      ADDRESS_THIS,
      step.amountIn,
      step.amountOut,
      encodeV3Path(hops),
      false,
      [],
    ],
  );
}

const pathKeyType={
  type:'tuple[]',
  components:[
    {name:'intermediateCurrency',type:'address'},
    {name:'fee',type:'uint256'},
    {name:'tickSpacing',type:'int24'},
    {name:'hooks',type:'address'},
    {name:'hookData',type:'bytes'},
  ],
} as const;

const exactInputType={
  type:'tuple',
  components:[
    {name:'currencyIn',type:'address'},
    {name:'path',...pathKeyType},
    {name:'minHopPriceX36',type:'uint256[]'},
    {name:'amountIn',type:'uint128'},
    {name:'amountOutMinimum',type:'uint128'},
  ],
} as const;

function encodeV4Command(hops:readonly DirectedPoolHop[],step:MixedQuoteStep):Hex {
  if(!hops.length||hops.some(h=>h.v3)) throw new Error('Expected contiguous V4 segment');
  if(step.amountIn>2n**128n-1n||step.amountOut>2n**128n-1n) throw new Error('V4 segment exceeds uint128');
  const currencyIn=hops[0]!.input;
  const currencyOut=hops.at(-1)!.output;
  for(const hop of hops){
    if(!same(hop.key.hooks,zeroAddress)) throw new Error('Hooked V4 segment is unsupported');
  }

  const swapParam=encodeAbiParameters(
    [exactInputType],
    [{
      currencyIn,
      path:hops.map(hop=>({
        intermediateCurrency:hop.output,
        fee:BigInt(hop.key.fee),
        tickSpacing:hop.key.tickSpacing,
        hooks:hop.key.hooks,
        hookData:'0x' as Hex,
      })),
      minHopPriceX36:[],
      amountIn:step.amountIn,
      amountOutMinimum:step.amountOut,
    }],
  );
  const settleParam=encodeAbiParameters(
    [{type:'address'},{type:'uint256'},{type:'bool'}],
    [currencyIn,OPEN_DELTA,false],
  );
  const takeParam=encodeAbiParameters(
    [{type:'address'},{type:'address'},{type:'uint256'}],
    [currencyOut,ADDRESS_THIS,OPEN_DELTA],
  );

  return encodeAbiParameters(
    [{type:'bytes'},{type:'bytes[]'}],
    [
      concatHex([commandByte(ACTION_SWAP_EXACT_IN),commandByte(ACTION_SETTLE),commandByte(ACTION_TAKE)]),
      [swapParam,settleParam,takeParam],
    ],
  );
}

export interface UniversalMixedPlan {
  commands: Hex;
  inputs: Hex[];
  calldata: Hex;
  value: bigint;
  expectedAmountOut: bigint;
  routerWethDust: bigint;
  finalMinimum: bigint;
  deadline: bigint;
}

export async function buildUniversalMixedPlan(
  client:PublicClient,
  quote:MixedCycleQuote,
  deadline:bigint=2n**256n-1n,
  extraFinalMinimum:bigint=0n,
):Promise<UniversalMixedPlan> {
  const {cycle,amountIn,amountOut,blockNumber,steps}=quote;
  const ref=getReference(robinhoodChain.id);
  if(!same(cycle.base,ref.wrapped)) throw new Error('Universal mixed atomic plan currently requires WETH base');
  if(amountIn<=0n||amountOut<=0n) throw new Error('Invalid mixed quote amounts');

  const wethDust=await client.readContract({
    address:ref.wrapped,
    abi:erc20BalanceAbi,
    functionName:'balanceOf',
    args:[ROBINHOOD_UNIVERSAL_ROUTER],
    blockNumber,
  });

  const commands:number[]=[CMD_WRAP_ETH];
  const inputs:Hex[]=[encodeWrapEth(amountIn)];

  for(const step of steps){
    const hops=cycle.hops.slice(step.hopStart,step.hopEnd+1);
    if(step.protocol==='v3'){
      commands.push(CMD_V3_SWAP_EXACT_IN);
      inputs.push(encodeV3Command(hops,step));
    }else{
      commands.push(CMD_V4_SWAP);
      inputs.push(encodeV4Command(hops,step));
    }
  }

  if(extraFinalMinimum<0n) throw new Error('Negative final minimum increment');
  const finalMinimum=wethDust+amountOut+extraFinalMinimum;
  commands.push(CMD_UNWRAP_WETH);
  inputs.push(encodeUnwrapWeth(finalMinimum));

  const commandsHex=concatHex(commands.map(commandByte));
  const calldata=encodeFunctionData({
    abi:universalRouterAbi,
    functionName:'execute',
    args:[commandsHex,inputs,deadline],
  });

  return {
    commands:commandsHex,
    inputs,
    calldata,
    value:amountIn,
    expectedAmountOut:amountOut,
    routerWethDust:wethDust,
    finalMinimum,
    deadline,
  };
}

export interface UniversalMixedAtomicSimulation {
  blockNumber: bigint;
  amountIn: bigint;
  expectedAmountOut: bigint;
  grossProfit: bigint;
  routerWethDust: bigint;
  gasEstimate: bigint|null;
  gasEstimateSource:'state-override-estimateGas'|'unsupported';
  gasEstimateError:string|null;
  calldata:Hex;
  calldataBytes:number;
  atomicVerified:true;
  exactOutputParity:true;
  source:'universal-router-state-override';
}

export async function simulateUniversalMixedAtomic(
  client:PublicClient,
  quote:MixedCycleQuote,
):Promise<UniversalMixedAtomicSimulation> {
  if(quote.amountOut<=quote.amountIn) throw new Error('Mixed atomic verification requires gross-positive quote');
  const plan=await buildUniversalMixedPlan(client,quote);
  const strictPlan=await buildUniversalMixedPlan(client,quote,plan.deadline,1n);
  const rpc=rawRpc(client);
  const blockTag=toHex(quote.blockNumber);
  const callerBalance=quote.amountIn*100n+10n**18n;
  const stateOverride={
    [UNIVERSAL_MIXED_CALLER]:{balance:toHex(callerBalance)},
  };
  const tx={
    from:UNIVERSAL_MIXED_CALLER,
    to:ROBINHOOD_UNIVERSAL_ROUTER,
    data:plan.calldata,
    value:toHex(plan.value),
  };

  const result=await rpc.request({
    method:'eth_call',
    params:[tx,blockTag,stateOverride],
  });
  if(typeof result!=='string'||!result.startsWith('0x')) throw new Error('Invalid Universal Router eth_call result');

  const strictTx={...tx,data:strictPlan.calldata};
  let strictReverted=false;
  try{
    await rpc.request({
      method:'eth_call',
      params:[strictTx,blockTag,stateOverride],
    });
  }catch{
    strictReverted=true;
  }
  if(!strictReverted) {
    throw new Error('Universal Router output exceeded sequential quote; atomic parity not proven');
  }

  let gasEstimate:bigint|null=null;
  let gasEstimateError:string|null=null;
  try{
    const gasResult=await rpc.request({
      method:'eth_estimateGas',
      params:[tx,blockTag,stateOverride],
    });
    if(typeof gasResult!=='string'||!/^0x[0-9a-f]+$/i.test(gasResult)) throw new Error('Invalid Universal Router gas estimate');
    gasEstimate=BigInt(gasResult);
    if(gasEstimate<=0n) throw new Error('Zero Universal Router gas estimate');
  }catch(error){
    gasEstimate=null;
    gasEstimateError=String(error);
  }

  return {
    blockNumber:quote.blockNumber,
    amountIn:quote.amountIn,
    expectedAmountOut:quote.amountOut,
    grossProfit:quote.amountOut-quote.amountIn,
    routerWethDust:plan.routerWethDust,
    gasEstimate,
    gasEstimateSource:gasEstimate===null?'unsupported':'state-override-estimateGas',
    gasEstimateError,
    calldata:plan.calldata,
    calldataBytes:(plan.calldata.length-2)/2,
    atomicVerified:true,
    exactOutputParity:true,
    source:'universal-router-state-override',
  };
}
