# Arb Radar architecture — v0.9 Atomic Override Economic Truth

## Objective

Measure current Par multi-market dislocations using a closed-cycle, same-base economic model without adding a transaction execution path.

A v0.8 result may become green only after canonical amount-sensitive quoting. Indexer prices are discovery metadata and cannot independently establish executable profitability.

## Pipeline

### 1. Discovery

`adapters/discovery.ts` asks the Par indexer for recent multi-market launches and refreshes typed `par-sdk` launch/route metadata with a bounded cache.

`adapters/parIndexer.ts` now keeps a market even when `lastPriceEth` is missing. This is intentional: price availability is no longer a prerequisite for discovery. Curve seed metadata such as `phantomQuote`, `quoteRaised`, `tokensOnCurve` and quote decimals is retained when present.

### 2. Screen block

Each radar tick pins one canonical Robinhood block. Recent launches are evaluated against that block rather than against asynchronous indexer last-trade prices.

### 3. Closed-cycle graph

`economic/v4Truth.ts` walks each market's Par reference route from the chain reference asset toward the market quote asset.

For every directed pair it finds common route nodes and constructs closed cycles:

`base -> buy quote -> Par token -> sell quote -> base`

A common ETH/reference prefix can therefore cancel out. Structural preference is:
1. all V4,
2. fewer hops,
3. deterministic base ordering.

The verified quote path additionally requires every hop to have zero hooks. Unsupported V3/hooked cycles fail closed instead of being approximated.

### 4. Same-block V4 truth

The engine batches StateView `getSlot0` and `getLiquidity` calls with viem multicall at the pinned screen block.

The infinitesimal multiplier uses pool direction, sqrtPriceX96, directional protocol fee and LP fee. Protocol + LP fee composition follows Uniswap v4's sequential formula:

`swapFee = protocolFee + lpFee - floor(protocolFee * lpFee / 1_000_000)`

This stage is only a marginal filter. It is not amount-sensitive P&L.

### 5. Base valuation

Exact arbitrage math remains in raw same-base units. USD is reporting/accounting only.

ETH/native and wrapped ETH use ETH/USD directly. Other base assets are valued at the same canonical block through Par QuotePricer's `priceEthAmountInQuote`, then combined with the timestamped ETH/USD valuation.

### 6. Current-block exact first probe

A qualifying same-block screen enters the staged scheduler. Immediately before the first probe, the engine obtains the current block and submits the whole hookless all-V4 cycle to Robinhood's canonical V4Quoter in one `quoteExactInput` multi-hop simulation.

This deliberately avoids quoting the historical screen block: the first probe asks whether the opportunity still exists when measurement reaches it.

### 7. Executable depth and sizing

The first exact probe begins at `MIN_CANDIDATE_TRADE_USD` (default $0.01). Sizing then runs an ascending USD depth ladder on one fixed block:

`0.01 -> 0.03 -> 0.10 -> 0.30 -> 1 -> 3 -> 10 -> 30 -> 100`

The list is clipped to the configured minimum, paper capital and max-trade bound.

`economic/depth.ts` treats canonical V4Quoter `NotEnoughLiquidity(poolId)` as an observed capacity boundary, not as an RPC failure. That failure is recorded with notional and pool id, and larger sizes are not attempted. Unknown/revert/RPC errors still fail closed.

If an exact quote succeeds but gross output is already <= input, sizing stops because increasing a hookless V4 exact-input trade cannot improve the average execution price of the same directed path.

`economic/seed.ts` still contains the two-pool constant-product analytical optimum. It is only a seed under strict Par liquidity/curve assumptions. Seed points are quoted only when they lie below the observed liquidity boundary; they never establish profitability without an exact quote.

This makes successful shallow quotes durable research evidence even when the next larger notional is impossible.

### 8. State-override atomic executor

`contracts/AtomicCycleExecutor.sol` is a minimal, hookless all-V4 closed-cycle executor compiled reproducibly with pinned solc 0.8.30, Cancun EVM and optimizer runs=200. Its runtime bytecode and SHA-256 are pinned in `AtomicCycleExecutor.artifact.json`; CI fails on artifact drift.

The contract is never deployed by Arb Radar. `economic/atomicExecutor.ts` injects its runtime bytecode at a fixed dummy address using the third state-override argument to `eth_call`.

Inside PoolManager `unlock`, the executor:
- reconstructs each sorted PoolKey,
- performs exact-input swaps using canonical TickMath price limits,
- rejects hooks and non-empty hook data,
- rejects partial fills and invalid delta signs,
- exact-chains each output into the next hop,
- requires the final currency to be the initial base,
- requires positive/minimum profit,
- takes only the final profit credit.

Successful atomic output must equal the canonical V4Quoter output or the quote fails closed.

When the endpoint accepts the same override on `eth_estimateGas`, that result is the preferred execution-gas source.

### 9. Cost model

`economic/nitroFees.ts` combines the best available execution-gas evidence with Nitro parent/data fee measurement.

Preferred path:
- state-override atomic executor gas,
- 20% research buffer,
- current/base gas price,
- Nitro parent/data fee priced using the **actual executor target and calldata**,
- 1% output safety margin.

When atomic override gas is unavailable, the previous V4Quoter + Nitro-child proxy remains an explicit fallback. If Nitro parent/data measurement also fails, the conservative legacy allowance remains explicit. No fallback silently produces a cheaper classification.

### 10. Lifecycle and scheduler

`research/scheduler.ts`, `measurement.ts` and `lifecycle.ts` retain:
- bounded probe/sizing concurrency,
- queue staleness rejection,
- original discovery-relative timing,
- lifecycle targets 0/100/250/500/1000ms,
- explicit unknown/error samples rather than fabricated zero P&L.

Quote completion is measurement completion, not inclusion.

### 11. Run identity and persistence

`research/run.ts` creates process-level `runId`, `engineVersion` and `runStartedAtMs`.

SQLite schema version 4 includes:
- launches
- market_snapshots
- route_screens
- executable_quotes
- opportunity_lifecycle
- rpc_latency_samples
- sequencer_observations
- radar_runtime
- radar_runs

v0.9 uses the run identity `0.9.0-economic-truth-atomic-override`; observations carry that identity in payloads. Existing databases remain append-only/create-if-missing.

### 12. Dashboard

The dashboard defaults to Current run. It can select a recent run or all runs.

For run-scoped views, funnel counts are calculated directly in SQLite using distinct candidate keys rather than inferred from the bounded 5,000-row analysis sample.

For v0.9 rows, green status additionally requires atomic state-override evidence and `quote.green=true`. A quoter-only or legacy positive numeric row is not promoted to Verified Positive.

## Canonical contracts used by the v0.8 truth path

Robinhood Chain:
- Uniswap V4 StateView: `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`
- Uniswap V4Quoter: `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`

The addresses are explicit in the source and covered by the live-smoke research path. The engine still uses the pinned Par SDK for launch/pool/reference-route metadata.

## Hard boundaries

No private key, mnemonic, account signer, `sendTransaction`, write contract, or automatic execution path is part of the application.

v0.9 does not claim:
- deployed executor behavior or transaction inclusion probability,
- frontrunning capability,
- public-mempool access through the sequencer feed,
- historical LONG5 executable P&L,
- strategy profitability from isolated positive samples.

Promotion beyond paper research would require a real atomic executor design, adversarial simulation/testnet evidence, executor gas measurement, a sufficiently large independent opportunity sample, and observed capture/inclusion behavior.
