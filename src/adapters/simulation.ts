import { encodeAbiParameters, keccak256, maxUint256, toHex, parseEther, formatEther, type PublicClient, type Address } from 'viem';
import { multiRouterAbi, poolIdOf, type TradableLaunch } from 'par-sdk';
import type { DirectedRoute, ExecutionQuote } from '../domain.js';

const observer: Address = '0x000000000000000000000000000000000000dEaD';
export interface Valuation { usdPerEth: number; timestampMs: number; source: string }
export interface SimulationProfile {
  blockReadMs: number;
  buySimulationMs: number;
  sellSimulationMs: number;
  buyGasEstimateMs: number;
  sellGasEstimateMs: number;
  gasPriceMs: number;
  blockConfirmMs: number;
  totalMs: number;
}
export interface SimulationQuote extends ExecutionQuote {
  kind: 'rpc-simulation'; timestampMs: number; blockNumber: bigint; blockHash: string;
  source: string; inputWei: bigint; tokenOut: bigint; outputWei: bigint;
  gasUnits: bigint; gasPriceWei: bigint; valuation: Valuation; safetyMarginUsd: number;
  profile: SimulationProfile;
  assumptions: string[];
}
export const netProfit = (q: ExecutionQuote): number => q.outputUsd - q.inputUsd - q.gasUsd - (q.extraCostsUsd ?? 0) - (q.safetyMarginUsd ?? 0);

export function selectMarkets(launch: TradableLaunch, route: DirectedRoute) {
  if (launch.kind !== 'multi' || launch.token.toLowerCase() !== route.token.toLowerCase()) throw new Error('Launch mismatch');
  const a = launch.markets.findIndex(m => m.index === route.buy.index);
  const b = launch.markets.findIndex(m => m.index === route.sell.index);
  if (a < 0 || b < 0 || a === b) throw new Error('Missing or identical market');
  const buy = launch.markets[a], sell = launch.markets[b];
  const buyRoute = launch.routes[a], sellRoute = launch.routes[b];
  if (!buyRoute?.qualifies || !sellRoute?.qualifies) throw new Error('Missing/stale reference route');
  for (const [snapshot, market] of [[route.buy, buy], [route.sell, sell]] as const) {
    if (snapshot.pairToken.toLowerCase() !== market.pairToken.toLowerCase() || (snapshot.poolId && snapshot.poolId.toLowerCase() !== market.poolId.toLowerCase())) throw new Error('Indexer/RPC market mismatch');
  }
  const hops = [...buyRoute.buyHops, { key: buy.poolKey, v3: false }, { key: sell.poolKey, v3: false }, ...sellRoute.sellHops];
  const ids = hops.map(h => `${h.v3 ? 'v3' : 'v4'}:${poolIdOf(h.key).toLowerCase()}`);
  if (new Set(ids).size !== ids.length) throw new Error('Shared pool requires atomic stateful simulation; excluded');
  if (hops.some(h => h.key.hooks !== '0x0000000000000000000000000000000000000000')) throw new Error('Hooks require stateful simulation; excluded');
  return { buy, sell, buyRoute, sellRoute };
}

function elapsed(start: number, end: number): number {
  const value = end - start;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Only eth_call, eth_estimateGas and state reads. Never exposes a submission request. */
export async function simulateRoute(client: PublicClient, launch: TradableLaunch, route: DirectedRoute,
  inputUsd: number, valuation: Valuation, options: { extraCostsUsd: number; safetyBps: number; source: string; blockNumber?: bigint; clockNow?: () => number },
): Promise<SimulationQuote> {
  if (![inputUsd, valuation.usdPerEth].every(n => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(options.extraCostsUsd) || options.extraCostsUsd < 0 ||
      !Number.isFinite(options.safetyBps) || options.safetyBps <= 0 || options.safetyBps >= 10_000 ||
      !Number.isFinite(valuation.timestampMs) || Date.now() - valuation.timestampMs > 60_000 || valuation.timestampMs > Date.now()) throw new Error('Invalid/stale valuation or cost assumptions');

  const clockNow = options.clockNow ?? (() => performance.now());
  const totalStarted = clockNow();
  const { buy, sell, buyRoute, sellRoute } = selectMarkets(launch, route);

  let started = clockNow();
  const block = await client.getBlock(options.blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: options.blockNumber });
  const blockReadMs = elapsed(started, clockNow());
  if (block.number === null || !block.hash) throw new Error('No canonical block');

  const inputWei = parseEther((inputUsd / valuation.usdPerEth).toFixed(18));
  if (inputWei <= 0n) throw new Error('Input rounds to zero');
  const buyArgs = [launch.token, [{ market: buy.index, hops: buyRoute.buyHops, amountIn: inputWei }], 0n, observer] as const;
  const buyState = [{ address: observer, balance: inputWei * 10n + parseEther('1') }];
  const common = { address: launch.router, abi: multiRouterAbi, account: observer, blockNumber: block.number } as const;

  started = clockNow();
  const buyResult = await client.simulateContract({ ...common, functionName: 'buyWithEth', args: buyArgs, value: inputWei, stateOverride: buyState });
  const buySimulationMs = elapsed(started, clockNow());
  const tokenOut = buyResult.result;
  if (tokenOut <= 0n) throw new Error('Empty buy quote');

  // OpenZeppelin layout verified against the pinned Par SDK quoteSellToEth implementation.
  const balanceSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [observer, 0n]));
  const allowanceInner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [observer, 1n]));
  const allowanceSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [launch.router, allowanceInner]));
  const sellState = [...buyState, { address: launch.token, stateDiff: [
    { slot: balanceSlot, value: toHex(tokenOut, { size: 32 }) },
    { slot: allowanceSlot, value: toHex(maxUint256, { size: 32 }) },
  ] }];
  const sellArgs = [launch.token, [{ market: sell.index, hops: sellRoute.sellHops, amountIn: tokenOut }], 0n, observer] as const;

  started = clockNow();
  const sellResult = await client.simulateContract({ ...common, functionName: 'sellToEth', args: sellArgs, stateOverride: sellState });
  const sellSimulationMs = elapsed(started, clockNow());

  started = clockNow();
  const buyGas = await client.estimateContractGas({ ...common, functionName: 'buyWithEth', args: buyArgs, value: inputWei, stateOverride: buyState });
  const buyGasEstimateMs = elapsed(started, clockNow());

  started = clockNow();
  const sellGas = await client.estimateContractGas({ ...common, functionName: 'sellToEth', args: sellArgs, stateOverride: sellState });
  const sellGasEstimateMs = elapsed(started, clockNow());

  started = clockNow();
  const gasPriceWei = await client.getGasPrice();
  const gasPriceMs = elapsed(started, clockNow());

  started = clockNow();
  const confirm = await client.getBlock({ blockNumber: block.number });
  const blockConfirmMs = elapsed(started, clockNow());
  if (confirm.hash !== block.hash) throw new Error('Block changed during simulation');

  const gasUnits = (buyGas + sellGas) * 120n / 100n;
  const outputWei = sellResult.result;
  const outputUsd = Number(formatEther(outputWei)) * valuation.usdPerEth;
  const profile: SimulationProfile = {
    blockReadMs,
    buySimulationMs,
    sellSimulationMs,
    buyGasEstimateMs,
    sellGasEstimateMs,
    gasPriceMs,
    blockConfirmMs,
    totalMs: elapsed(totalStarted, clockNow()),
  };

  return {
    kind: 'rpc-simulation',
    timestampMs: Date.now(),
    blockNumber: block.number,
    blockHash: block.hash,
    source: options.source,
    inputUsd,
    outputUsd,
    inputWei,
    tokenOut,
    outputWei,
    gasUnits,
    gasPriceWei,
    gasUsd: Number(formatEther(gasUnits * gasPriceWei)) * valuation.usdPerEth,
    extraCostsUsd: options.extraCostsUsd,
    safetyMarginUsd: outputUsd * options.safetyBps / 10_000,
    valuation,
    profile,
    assumptions: [
      'Disjoint pools; independently simulated legs at one block',
      'Router output already embeds pool fees, routing and price impact; those effects are not independently decomposed',
      'Gas estimate +20%; explicit extra allowance for L1/routing/failure costs',
      'Paper estimate; atomic executor and inclusion unvalidated',
    ],
  };
}
