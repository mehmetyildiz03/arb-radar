# Arb Radar architecture — v0.2

The goal is to measure whether dislocations justify further research. The application only observes and simulates; it has no execution path.

## Pipeline

1. `adapters/discovery.ts` uses typed Par indexer responses and caches `getTradable` market/route metadata with a bounded size and refresh interval.
2. `adapters/parIndexer.ts` normalizes screening snapshots. `arbitrage/routes.ts` enumerates independent directed markets and screens last prices with unequal fees and freshness checks.
3. `adapters/simulation.ts` performs selected-market router simulations and gas estimates. ETH is the common raw numeraire, USD is a timestamped reporting valuation. Block hashes are checked before/after. Unsupported shared pools, hooks, missing routes and reverts fail closed.
4. `arbitrage/optimizer.ts` searches a bounded input grid, rejecting invalid costs and quotes that exceed the total paper budget.
5. `research/lifecycle.ts` uses absolute monotonic deadlines and records actual completion timing, unavailable quotes, nonpositive crossings and half-profit decay. Sizing time precedes the lifecycle origin and does not establish discovery-to-capture latency.
6. `research/store.ts` persists append-only provenance-bearing observations in SQLite WAL. JSON preserves raw amounts and assumptions. Null block numbers explicitly denote unknown association. Schema version is 2; this first persisted version has no migration from a previous database schema.
7. `research/replay.ts` applies historical trades in block/log order, without look-ahead, and emits screening-only reports. Historical simulations require separately captured or archive state and are not fabricated.
8. `research/sequencerExperiment.ts` consumes compressed frames, verifies them using `feedDecoder.ts`, tracks gaps/duplicates/reorgs, and prepares next-block candidates. Confirmed Swap log prices are reconciled against PoolManager slot0 at the same block. This is partial shadow observation, not pre-RPC EVM execution.

## Boundaries and sources

Indexer data is delayed screening information. Mainnet RPC is read-only and the main radar transport enforces an RPC method allowlist. Independent pool simulations are paper evidence, not atomic execution proof. Public indexer/RPC retries are bounded. Cost allowances and rejected routes are explicit, allowing future research to identify coverage gaps.

No local secret, signing implementation or transaction broadcast is necessary. The installed SDK contains general trading helpers, but application code does not invoke them. Simulation request internals returned by viem are discarded.

Promotion remains outside v0.2: it would require a sufficiently large independent sample, measured capture latency, full cost/failure evidence, atomic simulation, and adversarial testnet validation. No mainnet execution promotion is made here.
