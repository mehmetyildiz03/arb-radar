# Arb Radar v0.6.1

Paper-only research radar for cross-market price dislocations in Par launches on Robinhood Chain. No credentials, wallet, signing, transaction submission, or mainnet execution are implemented.

All P&L is paper/theoretical. Last-trade screening is never executable profit. `rpc-simulation` quotes include amount-sensitive buy/sell and reference routing at one block; they still do not prove atomic execution, future inclusion, or realized returns.

## Run

Requires Node >=22.13 (built-in SQLite) and Git for the pinned SDK dependency.

```bash
npm ci
npm run check
npm start
npm run watch
npm run dev
npm run dashboard
npm run replay
npm run sequencer
```

`start` performs one public read-only scan; `watch` repeats after each scan. `dev` runs the paper radar watch process together with the local read-only dashboard at `http://127.0.0.1:4173`. `dashboard` opens only the dashboard against an existing SQLite database. `replay` is offline and reproduces the committed LONG5 report. `sequencer` observes for 15 seconds by default and exits. Tests require no network or secrets. CI checks Node 22 and 24.

## Data and calculations

- Typed `par-sdk` discovery filters multi-market launches; SDK metadata/routes are cached for 60 seconds (routing qualification can change).
- Exactly N*(N-1) directed routes for N independent markets. Screens reject stale, missing, nonpositive, nonfinite and duplicate market data. Default last-trade age limit: 60 seconds.
- Fee floor uses each leg's fee. For two 3% pools: `1 / (0.97 * 0.97) = 1.062812...`. Routing, impact and gas come later.
- The simulation adapter makes `eth_call` and `eth_estimateGas` calls to Par's v4 router with exactly one buy market and one sell market, including their ETH conversion hops. Raw amounts stay bigint. Both legs use one block, checked again for reorgs. It does not approximate concentrated liquidity with constant-product math.
- Repeated/shared pools and hooks are excluded: independent calls cannot reproduce their sequential state changes. Unsupported state overrides/reverts produce an unavailable quote, never a last-price fallback.
- Coinbase ETH/USD is a public valuation input, with retrieval time and source saved; it is not an executable FX quote. v0.5 creates the valuation lazily on the first real probe and shares that single promise across the entire tick, so concurrent candidates do not trigger duplicate valuation requests. Valuations older than 60 seconds are rejected.
- Paper net = quoted output - input - gas - extra allowance - safety margin. v0.6 persists this decomposition for every numeric quote. The router output already includes pool fees, routing and price impact; those embedded effects are **not** independently observable here and are not fabricated as separate fee/slippage numbers. Gas uses the sum of both router estimates plus 20%. The explicit extra allowance is $0.05; the safety margin is 1% of output. These are research assumptions, not a verified atomic/L1 cost bound. Capital must cover input, gas and the extra allowance. Search is an eight-size grid, not a proof of a global optimum.
- Candidate lifecycle targets are 0/100/250/500/1000ms from the original qualifying screen (`discoveredAtMs`). v0.6 profiles queue delay, preparation, first-quote call duration, sizing-barrier wait, sizing-slot wait and sizing execution separately while preserving the original discovery-relative clock. v0.5 uses a staged scheduler: qualifying candidates are priority-ranked, all eligible first probes run under bounded `PROBE_CONCURRENCY`, and exhaustive sizing waits until the first-probe stage has settled. `firstExecutableQuoteStartedMs`/`firstExecutableQuoteCompletedMs`, `sizingStartedMs`/`sizingCompletedMs`, and post-sizing lifecycle start remain anchored to the original discovery clock. Candidates that exceed `CANDIDATE_MAX_QUEUE_MS` before entering the probe stage are recorded as stale drops and never receive a fake executable quote. Later samples retain the same probe input for comparable decay; the optimizer result is reported separately. Actual start/completion times and `deadlineMissedByMs` expose missed targets instead of resetting t0. Quote completion does not prove capture or inclusion. No subsecond capture capability is claimed.
- SQLite records launches, market snapshots, screens, quotes/errors, lifecycle, RPC latency, sequencer observations and `radar_runtime` scheduler telemetry. Every row has timestamp/source/block columns; a null block explicitly means the source did not supply one. Bigints are decimal strings in JSON. No current head is falsely attached to indexer data.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| PAR_API_BASE | https://api.par.family | Public indexer |
| ROBINHOOD_RPC_URL | https://rpc.mainnet.chain.robinhood.com | Read-only RPC |
| ROBINHOOD_FEED_URL | wss://feed.mainnet.chain.robinhood.com | Already-ordered feed |
| RADAR_DB | data/radar.sqlite | SQLite output |
| POLL_MS | 1000 | Delay between complete scans |
| PAPER_CAPITAL_USD | 100 | Paper budget including costs |
| MAX_CANDIDATE_TRADE_USD | 100 | Maximum input |
| MIN_NET_PROFIT_USD | 0.05 | Sizing selection threshold |
| RECENT_WINDOW_SECONDS | 60 | Maximum screening price age |
| PROBE_CONCURRENCY | 2 | Maximum simultaneous first-probe phases, clamped 1–8 |
| SIZING_CONCURRENCY | 1 | Maximum simultaneous sizing phases, clamped 1–4 |
| CANDIDATE_MAX_QUEUE_MS | 2500 | Drop a queued candidate before probe if its discovery age exceeds this threshold |
| FEED_SECONDS | 15 | Bounded sequencer experiment, max 300 |
| DASHBOARD_HOST | 127.0.0.1 | Local dashboard bind address |
| DASHBOARD_PORT | 4173 | Local dashboard port |

HTTP retry/backoff is bounded and honors Retry-After (capped at 10 seconds). Public endpoint errors are recorded; paid keys are not required. Single-scan discovery failure exits nonzero; watch mode continues. Ctrl+C stops watch after the current scan.

## Research results and limits

[LONG5 replay](docs/LONG5_REPLAY.md) explicitly targets the original research address `0x9bbd4d06ac29d8900b34998a56e96a33c16220f0` regardless of its indexed symbol (currently Xl5). Its latest 2000 trades provide partial history, not complete launch-era coverage. Five other LONG5 tokens are labeled as a comparison cohort and never substituted for an unavailable original target. Historical executable sizes, P&L and subsecond half-lives remain unknown; no $100 capture conclusion is inferred. `node scripts/capture-original-long5.mjs` refreshes the original fixture from public read-only endpoints; `npm run replay` uses saved fixtures offline.

The sequencer experiment verifies the Nitro feed signature against a pinned public authority, decodes signed transaction batches, marks next-block candidates, and checks a log-derived shadow price against canonical RPC slot0. Gaps/reorgs invalidate the shadow cache. Calldata alone never updates pool prices. This is a limited reconciliation experiment, not a full speculative EVM or a demonstrated latency advantage. The feed is already ordered, not a public mempool. Authority rotation requires re-verification and a code update; failures are rejected.

See [architecture](docs/ARCHITECTURE.md), [audit](docs/V0.2_AUDIT.md), and [handoff specification](docs/ASTRA_HANDOFF.md).


## Local dashboard

The v0.6 dashboard is a read-only view over `RADAR_DB`. It does not call the chain from the browser and exposes only bounded local GET endpoints:

- `/api/health`
- `/api/snapshot?limit=120&windowSeconds=60`

It shows a true time-windowed funnel from fee-floor screens → quote-backed candidates → positive paper candidates, groups repeated optimizer/requote rows by candidate key, and keeps screen spread visually separate from quote-backed paper P&L. The dashboard adds positive/nonpositive/unavailable filters, token/route search, sorting, a latest-positive summary, paper P&L trace, discovery-to-first-quote median/p95, sizing median/p95, missed lifecycle deadline rate/p95, RPC latency, and lifetime dataset counts. Windows are bounded to 10 seconds–15 minutes and the analysis scan is capped at 5,000 rows per table with a visible truncation warning. A missing database renders an empty waiting state instead of creating research rows. The HTTP server binds to localhost by default.


### v0.4 metric semantics

- **Fee-floor screens**: qualifying last-price screens inside the selected time window. This is not executable profit.
- **Quote-backed candidate**: a unique candidate key with at least one amount-sensitive numeric RPC simulation inside the selected time window.
- **Positive paper candidate**: a quote-backed candidate with at least one positive net paper quote in the selected time window. Its latest quote may already be nonpositive; the table shows both latest net and best observed net.
- **Latest positive quote**: the most recent individual quote row with positive net paper P&L in the selected window.
- **Deadline miss rate**: lifecycle samples whose quote started after their original discovery-relative target. A completed quote is still not transaction inclusion or realized capture.

The dashboard can pause browser refresh without stopping the radar process. Changing the analysis window triggers a fresh bounded snapshot.


## v0.5 scheduler semantics

The scheduler is a research-throughput layer, not an execution engine. Candidate priority is deterministic: higher fee-adjusted screening return first, then earlier discovery time, then stable key order. Probe and sizing concurrency are independently bounded. A sizing slot is never opened until the first-probe stage for the current queue has settled, preventing one candidate's eight-size optimizer from blocking every later candidate's first executable observation.

The latest completed tick is written to `radar_runtime` with queue size, stale drops, probe/sizing starts and completions, observed peak concurrency, tick duration, configured queue age limit, and actual valuation fetch count. The local dashboard exposes these fields under **Candidate throughput**. This telemetry measures observation throughput only; it does not imply transaction inclusion speed.


## v0.6 cost and latency semantics

For every numeric executable quote, the dashboard can show:

`gross quoted edge = router output - input`

`paper net = gross quoted edge - gas - extra allowance - safety margin`

A negative result is classified by the first explicit stage that erases a previously positive quoted edge. If router output is already below input, the route is labeled negative before explicit research costs. Pool fees, routing and price impact remain embedded in router output and are not presented as separately measured values.

The P&L chart now separates **first probe** from **best observed candidate** values so optimizer/lifecycle requotes do not appear as a single stream of realized gains or losses.

The pipeline profiler aggregates median/p95 for queue delay, preparation, first quote, sizing barrier, sizing queue and sizing execution. First-probe simulation profiles additionally time block read, buy simulation, sell simulation, buy/sell gas estimation, gas-price read and block confirmation. These are local observation timings only; they do not measure transaction inclusion.


## v0.6.1 dashboard window semantics

Dashboard analysis windows are candidate-discovery windows. A quote or lifecycle row written later does not pull an older candidate into the current 60s/5m/15m funnel. New rows persist `discoveredAtMs`; legacy standard candidate keys fall back to their timestamp suffix. This keeps fee-floor screens, quote-backed candidates, P&L traces and lifecycle profiler summaries on the same discovery-time basis.
