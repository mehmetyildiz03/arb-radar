import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseEther, zeroAddress,
} from 'viem';
import { createPar, robinhoodChain } from 'par-sdk';
import { Discovery } from '../dist/adapters/discovery.js';
import { enumerateClosedCycles, quoteClosedCycle } from '../dist/economic/v4Truth.js';

const require=createRequire(import.meta.url);
const solc=require('solc');

const source=readFileSync(new URL('../contracts/AtomicCycleExecutor.sol',import.meta.url),'utf8');
const input={
  language:'Solidity',
  sources:{'AtomicCycleExecutor.sol':{content:source}},
  settings:{
    optimizer:{enabled:true,runs:200},
    evmVersion:'cancun',
    outputSelection:{'*':{'*':['abi','evm.deployedBytecode.object']}},
  },
};
const compiled=JSON.parse(solc.compile(JSON.stringify(input)));
const errors=(compiled.errors??[]).filter(x=>x.severity==='error');
if(errors.length) throw new Error(errors.map(x=>x.formattedMessage).join('\n'));
const artifact=compiled.contracts?.['AtomicCycleExecutor.sol']?.AtomicCycleExecutor;
if(!artifact?.evm?.deployedBytecode?.object) throw new Error('Atomic executor runtime bytecode missing');
const abi=artifact.abi;
const runtime=('0x'+artifact.evm.deployedBytecode.object);
const runtimeSha256=createHash('sha256').update(Buffer.from(artifact.evm.deployedBytecode.object,'hex')).digest('hex');

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const api=process.env.PAR_API_BASE ?? 'https://api.par.family';
const client=createPublicClient({
  chain:robinhoodChain,
  transport:http(rpc,{retryCount:2,retryDelay:350,timeout:20_000}),
});
const discovery=new Discovery(createPar({client}),api);
const blockNumber=await client.getBlockNumber({cacheTime:0});
const launches=await discovery.latest(30);

let chosen=null;
const attempts=[];
const rawAmounts=[100000000000n,30000000000n,10000000000n,3000000000n,1000000000n];

for(const snapshot of launches){
  let launch;
  try{ launch=await discovery.metadata(snapshot.token); }catch(error){ attempts.push({token:snapshot.token,error:String(error)}); continue; }
  if(!launch||launch.kind!=='multi') continue;
  for(const buy of launch.markets){
    for(const sell of launch.markets){
      if(buy.index===sell.index) continue;
      const cycles=enumerateClosedCycles(launch,buy.index,sell.index)
        .filter(c=>c.allV4&&c.hooklessV4&&c.base.toLowerCase()===zeroAddress.toLowerCase())
        .sort((a,b)=>a.hopCount-b.hopCount);
      for(const cycle of cycles){
        for(const amountIn of rawAmounts){
          try{
            const quote=await quoteClosedCycle(client,cycle,amountIn,blockNumber);
            if(quote.amountOut>0n){
              chosen={snapshot,launch,buy:buy.index,sell:sell.index,cycle,amountIn,quote};
              break;
            }
          }catch(error){
            attempts.push({token:launch.token,buy:buy.index,sell:sell.index,hops:cycle.hopCount,amountIn:amountIn.toString(),error:String(error).slice(0,240)});
          }
        }
        if(chosen) break;
      }
      if(chosen) break;
    }
    if(chosen) break;
  }
  if(chosen) break;
}

if(!chosen){
  console.log(JSON.stringify({
    ok:true,skipped:true,paperOnly:true,
    purpose:'v0.9 state-override atomic executor smoke',
    message:'No currently quoteable native hookless all-V4 cycle in bounded discovery sample',
    launchesExamined:launches.length,
    compile:{runtimeBytes:(runtime.length-2)/2,runtimeSha256},
    attempts:attempts.slice(0,12),
  }));
  process.exit(0);
}

const executor='0x000000000000000000000000000000000000a11c';
const caller='0x000000000000000000000000000000000000beef';
const hops=chosen.cycle.hops.map(h=>({
  output:h.output,
  fee:h.key.fee,
  tickSpacing:h.key.tickSpacing,
  hooks:h.key.hooks,
}));
const overrides=[
  {address:executor,code:runtime,balance:parseEther('10')},
  {address:caller,balance:parseEther('10')},
];

const probeData=encodeFunctionData({
  abi,functionName:'probeNative',args:[chosen.amountIn,hops],
});
const call=await client.call({
  account:caller,to:executor,data:probeData,blockNumber,stateOverride:overrides,
});
if(!call.data) throw new Error('State-override probe returned no data');
const probeOut=decodeFunctionResult({abi,functionName:'probeNative',data:call.data});
if(probeOut!==chosen.quote.amountOut){
  throw new Error(`Executor/V4Quoter mismatch: executor=${probeOut} quoter=${chosen.quote.amountOut}`);
}

let probeGas=null,probeGasError=null;
try{
  probeGas=await client.estimateGas({
    account:caller,to:executor,data:probeData,blockNumber,stateOverride:overrides,
  });
}catch(error){probeGasError=String(error);}

let execute=null;
if(chosen.quote.amountOut>=chosen.amountIn){
  const executeData=encodeFunctionData({
    abi,functionName:'executeNative',args:[chosen.amountIn,0n,hops,caller],
  });
  const execCall=await client.call({
    account:caller,to:executor,data:executeData,blockNumber,stateOverride:overrides,
  });
  if(!execCall.data) throw new Error('State-override execute returned no data');
  const profit=decodeFunctionResult({abi,functionName:'executeNative',data:execCall.data});
  const expected=chosen.quote.amountOut-chosen.amountIn;
  if(profit!==expected) throw new Error(`Executor profit mismatch: ${profit} vs ${expected}`);
  let gas=null,gasError=null;
  try{
    gas=await client.estimateGas({
      account:caller,to:executor,data:executeData,blockNumber,stateOverride:overrides,
    });
  }catch(error){gasError=String(error);}
  execute={profit:profit.toString(),gas:gas?.toString()??null,gasError};
}

console.log(JSON.stringify({
  ok:true,paperOnly:true,
  purpose:'v0.9 state-override atomic executor smoke; no code deployed and no transaction submitted',
  blockNumber:blockNumber.toString(),
  token:chosen.launch.token,
  buyMarket:chosen.buy,
  sellMarket:chosen.sell,
  base:chosen.cycle.base,
  baseSymbol:chosen.cycle.baseSymbol,
  hopCount:chosen.cycle.hopCount,
  amountIn:chosen.amountIn.toString(),
  v4QuoterAmountOut:chosen.quote.amountOut.toString(),
  v4QuoterGasEstimate:chosen.quote.gasEstimate.toString(),
  executorProbeAmountOut:probeOut.toString(),
  executorProbeGas:probeGas?.toString()??null,
  executorProbeGasError:probeGasError,
  grossPositive:chosen.quote.amountOut>chosen.amountIn,
  execute,
  compile:{solc:solc.version(),runtimeBytes:(runtime.length-2)/2,runtimeSha256},
}));
