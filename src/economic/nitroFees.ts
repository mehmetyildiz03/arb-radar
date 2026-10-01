import {
  encodeFunctionData,
  formatEther,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ClosedCycle } from './v4Truth.js';

export const NITRO_NODE_INTERFACE: Address = '0x00000000000000000000000000000000000000C8';
export const NITRO_FEE_PROBE_TARGET: Address = '0x000000000000000000000000000000000000dEaD';

export const nodeInterfaceAbi = parseAbi([
  'function gasEstimateComponents(address to, bool contractCreation, bytes data) view returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
]);

export const representativeExecutorAbi = parseAbi([
  'function executeCycle(address base, uint128 amountIn, uint128 minProfit, (address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path)',
]);

export interface NitroFeeComponents {
  gasEstimate: bigint;
  gasEstimateForL1: bigint;
  childGasEstimate: bigint;
  baseFeeWei: bigint;
  l1BaseFeeEstimateWei: bigint;
  parentDataCostWei: bigint;
  parentDataCostEth: number;
  parentDataCostUsd: number;
  calldataBytes: number;
  target: Address;
  source: 'nitro-node-interface';
}

export function encodeRepresentativeExecutorCall(
  cycle: ClosedCycle,
  amountIn: bigint,
  minProfit = 1n,
): Hex {
  if (amountIn <= 0n || amountIn > 2n**128n-1n) throw new Error('Invalid uint128 representative input');
  if (minProfit <= 0n || minProfit > 2n**128n-1n) throw new Error('Invalid uint128 representative min profit');
  return encodeFunctionData({
    abi: representativeExecutorAbi,
    functionName: 'executeCycle',
    args: [
      cycle.base,
      amountIn,
      minProfit,
      cycle.hops.map(hop => ({
        intermediateCurrency: hop.output,
        fee: hop.key.fee,
        tickSpacing: hop.key.tickSpacing,
        hooks: hop.key.hooks,
        hookData: '0x' as Hex,
      })),
    ],
  });
}

export async function readNitroFeeComponentsForCall(
  client: PublicClient,
  target: Address,
  data: Hex,
  ethUsdPrice: number,
  blockNumber?: bigint,
): Promise<NitroFeeComponents> {
  if (!Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) throw new Error('Invalid ETH/USD valuation');
  const result = await client.readContract({
    address: NITRO_NODE_INTERFACE,
    abi: nodeInterfaceAbi,
    functionName: 'gasEstimateComponents',
    args: [target, false, data],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  const [gasEstimate, gasEstimateForL1, baseFeeWei, l1BaseFeeEstimateWei] = result;
  if (gasEstimate < gasEstimateForL1) throw new Error('Nitro gas components are inconsistent');
  if (baseFeeWei <= 0n) throw new Error('Nitro base fee is zero');

  const childGasEstimate = gasEstimate - gasEstimateForL1;
  const parentDataCostWei = gasEstimateForL1 * baseFeeWei;
  const parentDataCostEth = Number(formatEther(parentDataCostWei));
  const parentDataCostUsd = parentDataCostEth * ethUsdPrice;
  const calldataBytes = (data.length - 2) / 2;

  if (![parentDataCostEth,parentDataCostUsd,calldataBytes].every(Number.isFinite) || parentDataCostUsd < 0) {
    throw new Error('Invalid Nitro fee component conversion');
  }

  return {
    gasEstimate,
    gasEstimateForL1,
    childGasEstimate,
    baseFeeWei,
    l1BaseFeeEstimateWei,
    parentDataCostWei,
    parentDataCostEth,
    parentDataCostUsd,
    calldataBytes,
    target,
    source: 'nitro-node-interface',
  };
}

export async function readNitroFeeComponents(
  client: PublicClient,
  cycle: ClosedCycle,
  amountIn: bigint,
  ethUsdPrice: number,
  blockNumber?: bigint,
): Promise<NitroFeeComponents> {
  const data = encodeRepresentativeExecutorCall(cycle, amountIn, 1n);
  return readNitroFeeComponentsForCall(
    client,
    NITRO_FEE_PROBE_TARGET,
    data,
    ethUsdPrice,
    blockNumber,
  );
}

export type ResearchCostMode =
  | 'atomic-override-nitro-calibrated'
  | 'atomic-override-parent-fallback'
  | 'quoter-proxy-nitro-calibrated'
  | 'legacy-fallback';

export type ExecutionGasSource =
  | 'state-override-estimateGas'
  | 'v4quoter-plus-nitro-child'
  | 'v4quoter-legacy';

export interface CalibratedResearchCost {
  mode: ResearchCostMode;
  executionGasSource: ExecutionGasSource;
  gasUnitsResearch: bigint;
  gasPriceWei: bigint;
  gasUsd: number;
  extraCostsUsd: number;
  nitro: NitroFeeComponents | null;
  fallbackReason: string | null;
}

function bufferedGas(gas: bigint, gasBufferBps: number): bigint {
  return (gas * BigInt(10_000 + Math.floor(gasBufferBps)) + 9_999n) / 10_000n;
}

function gasCostUsd(gasUnits: bigint, gasPriceWei: bigint, ethUsdPrice: number): number {
  const value = Number(formatEther(gasUnits * gasPriceWei)) * ethUsdPrice;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid gas USD');
  return value;
}

export async function calibrateResearchCost(options: {
  client: PublicClient;
  cycle: ClosedCycle;
  amountIn: bigint;
  quoterGasEstimate: bigint;
  ethUsdPrice: number;
  gasBufferBps: number;
  fallbackExtraCostsUsd: number;
  blockNumber?: bigint;
  executorGasEstimate?: bigint | null;
  executorTarget?: Address;
  executorCalldata?: Hex;
}): Promise<CalibratedResearchCost> {
  const {
    client,cycle,amountIn,quoterGasEstimate,ethUsdPrice,gasBufferBps,
    fallbackExtraCostsUsd,blockNumber,executorGasEstimate,executorTarget,executorCalldata,
  } = options;
  if (quoterGasEstimate <= 0n) throw new Error('Invalid quoter gas estimate');
  if (!Number.isFinite(gasBufferBps) || gasBufferBps < 0 || gasBufferBps > 10_000) throw new Error('Invalid gas buffer');
  if (!Number.isFinite(fallbackExtraCostsUsd) || fallbackExtraCostsUsd < 0) throw new Error('Invalid fallback extra cost');

  if (executorGasEstimate !== undefined && executorGasEstimate !== null && executorGasEstimate > 0n) {
    if (!executorTarget || !executorCalldata) throw new Error('Executor gas estimate requires target and calldata');
    try {
      const [nitro,rpcGasPrice] = await Promise.all([
        readNitroFeeComponentsForCall(client,executorTarget,executorCalldata,ethUsdPrice,blockNumber),
        client.getGasPrice(),
      ]);
      const gasPriceWei = rpcGasPrice > nitro.baseFeeWei ? rpcGasPrice : nitro.baseFeeWei;
      const gasUnitsResearch = bufferedGas(executorGasEstimate,gasBufferBps);
      return {
        mode:'atomic-override-nitro-calibrated',
        executionGasSource:'state-override-estimateGas',
        gasUnitsResearch,
        gasPriceWei,
        gasUsd:gasCostUsd(gasUnitsResearch,gasPriceWei,ethUsdPrice),
        extraCostsUsd:nitro.parentDataCostUsd,
        nitro,
        fallbackReason:null,
      };
    } catch (error) {
      const gasPriceWei = await client.getGasPrice();
      const gasUnitsResearch = bufferedGas(executorGasEstimate,gasBufferBps);
      return {
        mode:'atomic-override-parent-fallback',
        executionGasSource:'state-override-estimateGas',
        gasUnitsResearch,
        gasPriceWei,
        gasUsd:gasCostUsd(gasUnitsResearch,gasPriceWei,ethUsdPrice),
        extraCostsUsd:fallbackExtraCostsUsd,
        nitro:null,
        fallbackReason:String(error),
      };
    }
  }

  try {
    const nitroPromise = executorTarget && executorCalldata
      ? readNitroFeeComponentsForCall(client,executorTarget,executorCalldata,ethUsdPrice,blockNumber)
      : readNitroFeeComponents(client,cycle,amountIn,ethUsdPrice,blockNumber);
    const [nitro,rpcGasPrice] = await Promise.all([
      nitroPromise,
      client.getGasPrice(),
    ]);
    const gasPriceWei = rpcGasPrice > nitro.baseFeeWei ? rpcGasPrice : nitro.baseFeeWei;
    const preBufferGas = quoterGasEstimate + nitro.childGasEstimate;
    const gasUnitsResearch = bufferedGas(preBufferGas,gasBufferBps);
    return {
      mode:'quoter-proxy-nitro-calibrated',
      executionGasSource:'v4quoter-plus-nitro-child',
      gasUnitsResearch,
      gasPriceWei,
      gasUsd:gasCostUsd(gasUnitsResearch,gasPriceWei,ethUsdPrice),
      extraCostsUsd:nitro.parentDataCostUsd,
      nitro,
      fallbackReason:null,
    };
  } catch (error) {
    const gasPriceWei = await client.getGasPrice();
    const gasUnitsResearch = bufferedGas(quoterGasEstimate,gasBufferBps);
    return {
      mode:'legacy-fallback',
      executionGasSource:'v4quoter-legacy',
      gasUnitsResearch,
      gasPriceWei,
      gasUsd:gasCostUsd(gasUnitsResearch,gasPriceWei,ethUsdPrice),
      extraCostsUsd:fallbackExtraCostsUsd,
      nitro:null,
      fallbackReason:String(error),
    };
  }
}
