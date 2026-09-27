# Arb Radar architecture — v0.8 Economic Truth Engine

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

### 7. Sizing

`economic/seed.ts` contains a two-pool constant-product analytical optimum.

It is used only when:
- both Par pool active-liquidities equal the locked Par liquidities exactly,
- required curve metadata exists,
- all conversion path rates needed by the seed are available from the same-block V4 states.

The seed generates three exact validation sizes around 75/100/125%. If the assumptions fail or the seeded exact quotes do not produce an accepted result, the engine uses the legacy deterministic eight-size exact quote grid.

The analytical result never supplies P&L by itself.

### 8. Cost model

`economic/engine.ts` converts the exact closed-cycle output to reporting USD and applies:
- V4Quoter gas estimate,
- 20% gas research buffer,
- current gas price,
- $0.05 explicit extra allowance,
- 1% output safety margin.

The resulting field is paper research P&L. V4Quoter gas is not a deployed atomic-executor gas measurement.

### 9. Lifecycle and scheduler

`research/scheduler.ts`, `measurement.ts` and `lifecycle.ts` retain:
- bounded probe/sizing concurrency,
- queue staleness rejection,
- original discovery-relative timing,
- lifecycle targets 0/100/250/500/1000ms,
- explicit unknown/error samples rather than fabricated zero P&L.

Quote completion is measurement completion, not inclusion.

### 10. Run identity and persistence

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

v0.8 observations carry run identity in payloads. Existing databases remain append-only/create-if-missing.

### 11. Dashboard

The dashboard defaults to Current run. It can select a recent run or all runs.

For run-scoped views, funnel counts are calculated directly in SQLite using distinct candidate keys rather than inferred from the bounded 5,000-row analysis sample.

Green status requires `verifiedClosedCycle=true`. A legacy positive numeric row is not promoted to Verified Positive.

## Canonical contracts used by the v0.8 truth path

Robinhood Chain:
- Uniswap V4 StateView: `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`
- Uniswap V4Quoter: `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`

The addresses are explicit in the source and covered by the live-smoke research path. The engine still uses the pinned Par SDK for launch/pool/reference-route metadata.

## Hard boundaries

No private key, mnemonic, account signer, `sendTransaction`, write contract, or automatic execution path is part of the application.

v0.8 does not claim:
- atomic executor gas,
- transaction inclusion probability,
- frontrunning capability,
- public-mempool access through the sequencer feed,
- historical LONG5 executable P&L,
- strategy profitability from isolated positive samples.

Promotion beyond paper research would require a real atomic executor design, adversarial simulation/testnet evidence, executor gas measurement, a sufficiently large independent opportunity sample, and observed capture/inclusion behavior.
