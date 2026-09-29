import { createPublicClient, http, zeroAddress } from 'viem';
import { poolKeyFor, robinhoodChain } from 'par-sdk';
import { readNitroFeeComponents } from '../dist/economic/nitroFees.js';

const rpc=process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const client=createPublicClient({chain:robinhoodChain,transport:http(rpc,{retryCount:2,retryDelay:400,timeout:20_000})});

const blockNumber=74176592n;
const ethUsd=2694.035;
const grossEdgeUsd=0.004638354542048133;
const outputUsd=0.014638354542048133;
const oldGasUsd=0.012405372946816519;
const oldExtraUsd=0.05;
const safetyUsd=0.00014638354542048133;
const oldNetUsd=-0.05791340195018887;
const quoterGasEstimate=191043n;
const amountInRaw=3711904262565n;

const token='0x19ed196a285c33d213032b2078c006f70a453c6d';
const qBuy='0x507B6F349a80114097A67B8b4677367acC15b220';
const qSell='0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf';
const bridge='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const cycle={
  base:zeroAddress,
  baseSymbol:'ETH',
  hops:[
    {output:qBuy,key:poolKeyFor(qBuy,zeroAddress,10000,10)},
    {output:token,key:poolKeyFor(token,qBuy,15000,10)},
    {output:qSell,key:poolKeyFor(token,qSell,15000,10)},
    {output:bridge,key:poolKeyFor(qSell,bridge,9000,90)},
    {output:zeroAddress,key:poolKeyFor(bridge,zeroAddress,460,9)},
  ],
};

try{
  const fee=await readNitroFeeComponents(client,cycle,amountInRaw,ethUsd,blockNumber);
  const gasPriceWei=fee.baseFeeWei;
  const preBufferGas=quoterGasEstimate+fee.childGasEstimate;
  const gasUnitsResearch=(preBufferGas*12000n+9999n)/10000n;
  const gasUsd=Number(gasUnitsResearch*gasPriceWei)/1e18*ethUsd;
  const recalibratedNetUsd=grossEdgeUsd-gasUsd-fee.parentDataCostUsd-safetyUsd;

  console.log(JSON.stringify({
    ok:true,
    paperOnly:true,
    purpose:'v0.8.3 historical Nitro cost recheck of recorded gross-positive exact quote',
    blockNumber:blockNumber.toString(),
    route:{token,hopCount:5,base:'ETH'},
    inputUsd:.01,
    outputUsd,
    grossEdgeUsd,
    quoterGasEstimate:quoterGasEstimate.toString(),
    old:{gasUsd:oldGasUsd,extraUsd:oldExtraUsd,safetyUsd,netUsd:oldNetUsd},
    nitro:{
      gasEstimate:fee.gasEstimate.toString(),
      gasEstimateForL1:fee.gasEstimateForL1.toString(),
      childGasEstimate:fee.childGasEstimate.toString(),
      baseFeeWei:fee.baseFeeWei.toString(),
      l1BaseFeeEstimateWei:fee.l1BaseFeeEstimateWei.toString(),
      parentDataCostUsd:fee.parentDataCostUsd,
      calldataBytes:fee.calldataBytes,
    },
    recalibrated:{
      preBufferGas:preBufferGas.toString(),
      gasUnitsResearch:gasUnitsResearch.toString(),
      gasPriceWei:gasPriceWei.toString(),
      gasUsd,
      parentDataCostUsd:fee.parentDataCostUsd,
      safetyUsd,
      netUsd:recalibratedNetUsd,
      positive:recalibratedNetUsd>0,
    },
  }));
}catch(error){
  console.error(JSON.stringify({
    ok:false,
    paperOnly:true,
    purpose:'v0.8.3 historical Nitro cost recheck of recorded gross-positive exact quote',
    blockNumber:blockNumber.toString(),
    archiveHistoricalFeeUnavailable:true,
    error:String(error),
  }));
  process.exit(2);
}
