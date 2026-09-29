import { createPublicClient, http, zeroAddress } from 'viem';
import { poolKeyFor, robinhoodChain } from 'par-sdk';
import { readNitroFeeComponents } from '../dist/economic/nitroFees.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const client=createPublicClient({chain:robinhoodChain,transport:http(rpc,{retryCount:2,retryDelay:400,timeout:20_000})});

const ethResponse=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
if(!ethResponse.ok) throw new Error('ETH/USD unavailable: '+ethResponse.status);
const ethBody=await ethResponse.json();
const ethUsd=Number(ethBody?.data?.amount);
if(!Number.isFinite(ethUsd)||ethUsd<=0) throw new Error('Invalid ETH/USD');

const a='0x1111111111111111111111111111111111111111';
const b='0x2222222222222222222222222222222222222222';
const cycle={
  base:zeroAddress,
  baseSymbol:'ETH',
  hops:[
    {output:a,key:poolKeyFor(a,zeroAddress,3000,60)},
    {output:b,key:poolKeyFor(a,b,30000,10)},
    {output:zeroAddress,key:poolKeyFor(b,zeroAddress,3000,60)},
  ],
};

const blockNumber=await client.getBlockNumber({cacheTime:0});
const amountIn=10n**12n;
const fee=await readNitroFeeComponents(client,cycle,amountIn,ethUsd,blockNumber);

console.log(JSON.stringify({
  ok:true,
  paperOnly:true,
  purpose:'v0.8.3 Nitro transaction-fee calibration smoke; representative calldata only; no transaction submitted',
  blockNumber:blockNumber.toString(),
  hopCount:cycle.hops.length,
  gasEstimate:fee.gasEstimate.toString(),
  gasEstimateForL1:fee.gasEstimateForL1.toString(),
  childGasEstimate:fee.childGasEstimate.toString(),
  baseFeeWei:fee.baseFeeWei.toString(),
  l1BaseFeeEstimateWei:fee.l1BaseFeeEstimateWei.toString(),
  parentDataCostWei:fee.parentDataCostWei.toString(),
  parentDataCostUsd:fee.parentDataCostUsd,
  calldataBytes:fee.calldataBytes,
  legacyAllowanceUsd:.05,
  calibrationBelowLegacyAllowance:fee.parentDataCostUsd<.05,
}));
