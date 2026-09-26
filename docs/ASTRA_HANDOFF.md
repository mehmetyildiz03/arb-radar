# Astra handoff — Arb Radar v0.2

Repository target: `mehmetyildiz03/arb-radar`.

## Current state
v0.1 is a paper-only TypeScript core. `npm test` currently targets 5 core tests. There is deliberately no wallet, signer or execution path.

## Immutable design decisions
1. Do not add live trading in v0.2.
2. Treat Par indexer prices as screening data only, never executable quotes.
3. Treat Robinhood Sequencer Feed as an already ordered/built-block observation, not a mempool.
4. A candidate becomes a paper opportunity only after amount-sensitive quote/simulation includes both pool legs, quote-asset routing where necessary, gas and explicit safety margin.
5. Keep every calculation reproducible in logs.

## Work package

### 1. Dependency integration
- Install `viem` and `github:pardotfamily/par-sdk`.
- Pin versions/commit in lockfile.
- Keep the existing pure math modules and tests.

### 2. Live discovery
- Replace/augment raw indexer normalization with typed `par-sdk` clients.
- Cache immutable launch metadata (`getTradable`/markets/routes).
- Restrict the radar to multi-market launches with >=2 independently priced markets.

### 3. Executable quote adapter
Build a `QuoteProvider` backed by Uniswap v4 state/Quoter or reliable `eth_call` simulation.
For each directed cross-market route and candidate input:
- buy token in market A;
- sell token in market B;
- account for quote-to-reference routing if quotes differ;
- include every fee and gas estimate;
- return common-numeraire USD/ETH output.
Never approximate concentrated-liquidity execution with a constant-product formula.

### 4. Persistence
Use SQLite with tables at minimum:
- launches
- market_snapshots
- route_screens
- executable_quotes
- opportunity_lifecycle
- rpc_latency_samples

Store timestamp, block number and data source on every observation.

### 5. Opportunity lifecycle
For every candidate, requote at approximately:
- t0
- +100 ms
- +250 ms
- +500 ms
- +1000 ms

Record when net profitability crosses <=0. This is the central metric.

### 6. LONG5 replay
Replay known LONG5-era data where possible. Produce a report:
- detected dislocations
- best executable size by timestamp
- expected gross/net P&L
- opportunity half-life
- whether a $100 paper wallet could realistically capture them under measured latency

### 7. Sequencer experiment
Use the Chainstack reference implementation or equivalent verified decoder. Prefer signature verification. Do not claim the feed enables front-running.
Experiment with maintaining a shadow state from relevant already-ordered transactions so the radar can prepare a candidate for the next block, then reconcile against RPC.

### 8. CI
Add GitHub Actions for:
- typecheck
- unit tests
- deterministic fixture/replay tests
No secrets required.

## Acceptance criteria
- Existing 5 tests remain green.
- Add tests for unequal pool fees, extra route costs, stale prices, missing markets and negative/zero prices.
- A five-market token always enumerates exactly 20 directed routes.
- Last-price screening and executable quoting are separate types/modules.
- No private-key environment variable exists anywhere in the repo.
- `npm run check` succeeds from a clean checkout.
- Live read-only mode can run without paid API keys using public endpoints, with graceful rate-limit/backoff handling.
- README clearly labels all P&L as paper/theoretical unless backed by executable quotes.
