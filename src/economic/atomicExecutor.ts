import { readFileSync } from 'node:fs';
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ClosedCycle } from './v4Truth.js';

export const ATOMIC_EXECUTOR_ADDRESS: Address = '0x000000000000000000000000000000000000A709';
export const ATOMIC_EXECUTOR_CALLER: Address = '0x000000000000000000000000000000000000dEaD';

export const atomicExecutorAbi = parseAbi([
  'function executeCycle(address base,uint128 amountIn,uint128 minProfit,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path) returns (uint256 amountOut,uint256 profit)',
  'error PartialFill(uint256 hop,uint256 requested,uint256 consumed)',
  'error InvalidDelta(uint256 hop,int128 inputDelta,int128 outputDelta)',
  'error CycleNotClosed(address expectedBase,address finalCurrency)',
  'error NoProfit(uint256 amountIn,uint256 amountOut)',
  'error ProfitBelowMinimum(uint256 profit,uint256 minProfit)',
  'error HooksUnsupported()',
  'error HookDataUnsupported()',
  'error InvalidAmount()',
  'error InvalidHop()',
  'error NotPoolManager()',
]);

interface ExecutorArtifact {
  contractName: string;
  compiler: string;
  evmVersion: string;
  optimizer: { enabled: boolean; runs: number };
  poolManager: Address;
  runtimeBytecode: Hex;
  runtimeHexSha256: string;
  runtimeBytes: number;
}

let cachedArtifact: ExecutorArtifact | null = null;

export function atomicExecutorArtifact(): ExecutorArtifact {
  if (cachedArtifact) return cachedArtifact;
  const url = new URL('../../contracts/AtomicCycleExecutor.artifact.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as ExecutorArtifact;
  if (parsed.contractName !== 'AtomicCycleExecutor') throw new Error('Unexpected atomic executor artifact');
  if (!/^0x[0-9a-f]+$/i.test(parsed.runtimeBytecode)) throw new Error('Invalid atomic executor runtime');
  if ((parsed.runtimeBytecode.length - 2) / 2 !== parsed.runtimeBytes) throw new Error('Atomic executor runtime length mismatch');
  cachedArtifact = parsed;
  return parsed;
}

export function encodeAtomicExecutorCall(
  cycle: ClosedCycle,
  amountIn: bigint,
  minProfit = 1n,
): Hex {
  if (!cycle.allV4 || !cycle.hooklessV4) throw new Error('Atomic executor requires hookless all-v4 cycle');
  if (amountIn <= 0n || amountIn > BigInt((1n << 127n) - 1n)) throw new Error('Invalid atomic executor input');
  if (minProfit <= 0n || minProfit > 2n**128n-1n) throw new Error('Invalid atomic executor min profit');
  return encodeFunctionData({
    abi: atomicExecutorAbi,
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

export interface AtomicExecutorSimulation {
  blockNumber: bigint;
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  minProfit: bigint;
  gasEstimate: bigint | null;
  gasEstimateSource: 'state-override-estimateGas' | 'unsupported';
  gasEstimateError: string | null;
  calldata: Hex;
  calldataBytes: number;
  executorAddress: Address;
  runtimeBytes: number;
  runtimeHexSha256: string;
  source: 'state-override-eth-call';
}

function rawRpc(client: PublicClient): { request(args: { method: string; params: unknown[] }): Promise<unknown> } {
  return client as unknown as { request(args: { method: string; params: unknown[] }): Promise<unknown> };
}

export async function simulateAtomicExecutor(
  client: PublicClient,
  cycle: ClosedCycle,
  amountIn: bigint,
  blockNumber: bigint,
  minProfit = 1n,
): Promise<AtomicExecutorSimulation> {
  const artifact = atomicExecutorArtifact();
  const calldata = encodeAtomicExecutorCall(cycle, amountIn, minProfit);
  const tx = {
    from: ATOMIC_EXECUTOR_CALLER,
    to: ATOMIC_EXECUTOR_ADDRESS,
    data: calldata,
  };
  const stateOverride = {
    [ATOMIC_EXECUTOR_ADDRESS]: {
      code: artifact.runtimeBytecode,
    },
  };
  const blockTag = toHex(blockNumber);
  const rpc = rawRpc(client);

  const callResult = await rpc.request({
    method: 'eth_call',
    params: [tx, blockTag, stateOverride],
  });
  if (typeof callResult !== 'string' || !callResult.startsWith('0x')) {
    throw new Error('Invalid state-override eth_call result');
  }
  const [amountOut, profit] = decodeFunctionResult({
    abi: atomicExecutorAbi,
    functionName: 'executeCycle',
    data: callResult as Hex,
  });
  if (amountOut <= amountIn || profit !== amountOut - amountIn || profit < minProfit) {
    throw new Error('Atomic executor returned inconsistent profit');
  }

  let gasEstimate: bigint | null = null;
  let gasEstimateError: string | null = null;
  try {
    const gasResult = await rpc.request({
      method: 'eth_estimateGas',
      params: [tx, blockTag, stateOverride],
    });
    if (typeof gasResult !== 'string' || !/^0x[0-9a-f]+$/i.test(gasResult)) throw new Error('Invalid override gas estimate');
    gasEstimate = BigInt(gasResult);
    if (gasEstimate <= 0n) throw new Error('Zero override gas estimate');
  } catch (error) {
    gasEstimate = null;
    gasEstimateError = String(error);
  }

  return {
    blockNumber,
    amountIn,
    amountOut,
    profit,
    minProfit,
    gasEstimate,
    gasEstimateSource: gasEstimate === null ? 'unsupported' : 'state-override-estimateGas',
    gasEstimateError,
    calldata,
    calldataBytes: (calldata.length - 2) / 2,
    executorAddress: ATOMIC_EXECUTOR_ADDRESS,
    runtimeBytes: artifact.runtimeBytes,
    runtimeHexSha256: artifact.runtimeHexSha256,
    source: 'state-override-eth-call',
  };
}
