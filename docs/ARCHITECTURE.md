# Arb Radar architecture — v0.6

The goal is to measure whether dislocations justify further research. The application only observes and simulates; it has no execution path.

## Pipeline

1. `adapters/discovery.ts` uses typed Par indexer responses and caches `getTradable` market/route metadata with a bounded size and refresh interval.
2. `adapters/parIndexer.ts` normalizes screening snapshots. `arbitrage/routes.ts` enumerates independent directed markets and screens last prices with unequal fees and freshness checks.
3. `adapters/simulation.ts` performs selected-market router simulations and gas estimates. ETH is the common raw numeraire, USD is a timestamped reporting valuation. Block hashes are checked before/after. v0.6 records read-only quote substep durations (block read, buy/sell simulation, gas estimates, gas price and block confirmation). Router output already embeds pool fees, routing and price impact; these are not independently decomposed. Unsupported shared pools, hooks, missing routes and reverts fail closed.
4. `arbitrage/optimizer.ts` searches a bounded input grid, rejecting invalid costs and quotes that exceed the total paper budget.
5. `research/scheduler.ts` priority-ranks qualifying candidates and runs a staged queue. Probe phases are bounded separately from sizing phases; all first-probe phases settle before exhaustive sizing is admitted. Queue age is checked immediately before expensive probe work, so stale candidates are dropped without a fake executable quote. `sharedAsyncResource()` makes tick-scoped inputs such as ETH/USD valuation lazy and single-fetch. `research/measurement.ts` keeps all timing anchored to the original qualifying screen while separately recording queue delay, preparation time, first-quote call duration, sizing-barrier wait, sizing-slot wait and sizing execution. `research/lifecycle.ts` retains discovery-relative absolute monotonic deadlines, lateness and completion timing. These measurements do not prove transaction capture or inclusion.
6. `research/store.ts` persists append-only provenance-bearing observations in SQLite WAL. JSON preserves raw amounts and assumptions. Null block numbers explicitly denote unknown association. Schema version is 3 and includes `radar_runtime` rows for queue size, stale drops, probe/sizing throughput, configured concurrency, tick duration and actual valuation fetch count. Tables remain create-if-missing and backwards-compatible with an existing v0.2/v0.4 database file.
7. `research/replay.ts` applies historical trades in block/log order, without look-ahead, and emits screening-only reports. `scripts/long5-target.mjs` pins the original research target 0x9bbd4d06ac29d8900b34998a56e96a33c16220f0 independently of symbol. Unavailable target metadata/history is reported explicitly; other tokens are comparisons only. Historical simulations require separately captured or archive state and are not fabricated.
8. `research/sequencerExperiment.ts` consumes compressed frames, verifies them using `feedDecoder.ts`, tracks gaps/duplicates/reorgs, and prepares next-block candidates. Confirmed Swap log prices are reconciled against PoolManager slot0 at the same block. This is partial shadow observation, not pre-RPC EVM execution.

## Boundaries and sources

Indexer data is delayed screening information. Mainnet RPC is read-only and the main radar transport enforces an RPC method allowlist. Independent pool simulations are paper evidence, not atomic execution proof. Public indexer/RPC retries are bounded. Cost allowances and rejected routes are explicit, allowing future research to identify coverage gaps.

No local secret, signing implementation or transaction broadcast is necessary. The installed SDK contains general trading helpers, but application code does not invoke them. Simulation request internals returned by viem are discarded.

Promotion remains outside v0.6: it would require a sufficiently large independent sample, measured capture latency, full cost/failure evidence, atomic simulation, and adversarial testnet validation. No mainnet execution promotion is made here.


## Cost decomposition boundary

`research/costs.ts` decomposes only observable arithmetic: input, router output, gas, explicit extra allowance, safety margin and resulting paper net. It deliberately does not manufacture separate pool-fee or slippage numbers because those effects are already embedded in the quoted router output and are not independently identifiable from the current simulation interface.
