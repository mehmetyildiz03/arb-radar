# Arb Radar v0.8.1 — Executable Truth Engine

Paper-only research radar for Par multi-market dislocations on Robinhood Chain. The application has no wallet, private key, signer, transaction submission, or automated trading path.

v0.8 introduced same-base closed-cycle research. v0.8.1 corrects an important weakness discovered in live observation: **StateView slot0 spot prices are not sufficient evidence of an executable edge**. A pool can sit at an extreme tick with zero active liquidity, producing an enormous mathematical spot ratio while the canonical amount-sensitive quote is negative or cannot complete.

The primary screen is therefore now an **executable micro exact quote**, not a displayed spot percentage.

## Verified path

For each recent Par multi-market launch the engine:

1. uses the Par indexer only for discovery and curve/market metadata,
2. pins one canonical Robinhood screen block,
3. constructs same-base closed cycles and removes common reference-route prefixes,
4. reads canonical V4 StateView state for structural/marginal prefiltering,
5. treats zero-active-liquidity spot state as unreliable rather than profitable,
6. submits a small same-block closed-cycle quote to the canonical V4Quoter,
7. admits a candidate only if that exact micro quote returns **more of the same base asset than it consumed**,
8. re-quotes at the current block when the first capture probe actually starts,
9. skips expensive sizing if that current-block first probe is already gross-negative,
10. otherwise performs exact sizing, using the analytical constant-product result only as an optional seed,
11. reports green only when an exact verified closed-cycle quote remains positive after the explicit paper-cost model.

Neither an indexer spread, StateView marginal ratio, analytical seed, nor a legacy numeric quote can independently produce a green result.

## Why v0.8.1 was necessary

A live v0.8 dashboard showed hundreds of “Same-block truth” candidates and absurdly large truth spreads while every exact quote was red. A dedicated public-RPC audit tested exact closed-cycle sizes at:

`$0.01, $0.03, $0.10, $0.30, $1, $3, $10`

Across 8 scans:
- 48 candidate observations
- 6 structural candidate identities
- 64 successful exact quotes
- 272 exact quote reverts
- **0 gross-positive exact quotes**
- **0 verified paper-positive quotes**

The best sampled paper result was still about **-$0.1564 at $0.01**. Lowering the old $1 minimum therefore did not reveal hidden green opportunities.

Per-hop diagnostics then identified the core false-positive pattern: some extreme slot0 ratios came from Par buy pools with **active liquidity = 0** and ticks near the price boundary. After replacing the spot-only gate with executable micro quoting, a later live audit over 26 recent launches on two independent blocks produced **0 executable-truth candidates** instead of hundreds of misleading ones. That zero is an honest result, not a radar failure.

## Run

Requires Node >=22.13 and Git for the pinned Par SDK dependency.

```bash
npm ci
npm run check
npm start
npm run watch
npm run dev
npm run dashboard
npm run replay
npm run sequencer
npm run live:cycle-smoke
npm run research:micro-size
```

- `npm start`: one read-only executable-truth scan.
- `npm run watch`: repeated scans.
- `npm run dev`: radar watch + local dashboard.
- `npm run dashboard`: dashboard only over an existing SQLite DB.
- `npm run live:cycle-smoke`: quote one supported real closed cycle without making a profitability claim.
- `npm run research:micro-size`: manual research sweep across sub-$1 and larger exact quote sizes.

Local dashboard: `http://127.0.0.1:4173`.

## Closed-cycle routing

For a directed market pair the engine searches the two Par reference routes for a common base and constructs:

`BASE -> buy quote -> Par token -> sell quote -> BASE`

rather than forcing every path to start and end in ETH.

The verified path currently requires a hookless all-V4 closed cycle. V3 and hooked cycles remain outside Verified Positive rather than being approximated.

Native ETH and WETH are not treated as magically interchangeable inside V4Quoter paths. If Par's router would wrap native ETH before a pool, the research graph starts from the actual pool currency so the canonical quote remains a real closed cycle.

## Executable micro screen

StateView still matters, but only as a cheap structural/marginal prefilter.

When every hop has positive active liquidity, a fee-aware nonpositive marginal edge can be rejected before quoting. When active liquidity is zero, slot0 is not treated as an executable marginal price; the canonical micro quote decides.

The default micro screen is `$0.01` reporting value. It is quoted at the pinned screen block through one canonical V4Quoter multi-hop call. The candidate survives only when:

`raw base amount out > raw base amount in`

This stage deliberately ignores gas when deciding whether a larger trade might be worth sizing: fixed gas can make a tiny trade net-negative even if its gross cycle rate is positive.

The dashboard therefore shows **Micro gross edge**, not “truth spread”.

## Current-block first probe

A screen only says that an executable gross edge existed at the screen block. When the scheduler reaches the candidate, the first capture probe uses the latest block.

If that current-block first probe is gross-negative, v0.8.1 stops before sizing and later lifecycle requotes. For the current hookless exact-input V4 path, increasing size cannot improve the average exchange rate enough to turn an already gross-negative micro cycle into a better gross cycle in the same state.

If the first probe is gross-positive but paper-net negative, sizing still continues because a larger trade can potentially absorb fixed gas and allowance costs.

## Sizing

Default sizing floor is now `$0.01`, not `$1`.

When strict Par reserve/liquidity assumptions hold, the constant-product closed form proposes an optimum and the engine exact-quotes 75%, 100% and 125% around it.

Otherwise the deterministic eight-size exact quote grid is used from `MIN_CANDIDATE_TRADE_USD` through the configured maximum. Analytical math never supplies P&L or green status by itself.

## Paper cost model

For an exact closed-cycle quote:

`paper net = base output value - base input value - research gas proxy - $0.05 allowance - 1% output safety margin`

The current research gas proxy is V4Quoter gas estimate +20%, valued at current gas price. This is **not deployed atomic-executor gas**.

The live micro-size audit showed gas around roughly $0.10 in sampled quotes, so merely shrinking trade size is not a path to positive paper net: small inputs become dominated by fixed costs.

## Run-isolated measurement

Every process creates:
- `runId`
- `engineVersion` (v0.8.1 uses `0.8.1-executable-truth`)
- `runStartedAtMs`

The dashboard defaults to Current run, so old v0.8 false-positive screens do not contaminate v0.8.1 metrics.

Run-scoped funnel counts are calculated directly in SQLite by distinct candidate key rather than inferred from the bounded dashboard row sample.

## Dashboard funnel

**Micro-exact truth -> Current-block quoted -> Verified paper positive**

- **Micro-exact truth:** same-block canonical micro cycle had gross output > input.
- **Current-block quoted:** the candidate was re-quoted when capture measurement reached it.
- **Verified paper positive:** a verified same-base exact quote remained above the configured minimum after explicit paper costs.

A zero in the first metric means no currently observed supported cycle passed the executable micro edge test.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PAR_API_BASE` | `https://api.par.family` | Discovery/indexer metadata |
| `ROBINHOOD_RPC_URL` | public mainnet RPC | Read-only canonical RPC |
| `ROBINHOOD_FEED_URL` | public sequencer feed | Ordered feed research |
| `RADAR_DB` | `data/radar.sqlite` | SQLite output |
| `POLL_MS` | 1000 | Delay after each completed watch scan |
| `PAPER_CAPITAL_USD` | 100 | Total paper budget |
| `MAX_CANDIDATE_TRADE_USD` | 100 | Maximum sizing quote input |
| `MIN_CANDIDATE_TRADE_USD` | 0.01 | Minimum sizing input |
| `SCREEN_PROBE_USD` | 0.01 | Same-block executable micro-screen input |
| `MIN_NET_PROFIT_USD` | 0.05 | Accepted paper-net threshold |
| `PROBE_CONCURRENCY` | 2 | Parallel current-block probes |
| `SIZING_CONCURRENCY` | 1 | Parallel candidate sizing phases |
| `SIZING_QUOTE_CONCURRENCY` | 2 | Parallel fixed-block sizing quotes |
| `CANDIDATE_MAX_QUEUE_MS` | 2500 | Drop stale candidate before probe |
| `TRUTH_LAUNCH_LIMIT` | 8 | Recent launches examined per scan |
| `TRUTH_SCAN_CONCURRENCY` | 2 | Parallel launch truth scans |
| `DASHBOARD_HOST` | `127.0.0.1` | Local dashboard bind |
| `DASHBOARD_PORT` | 4173 | Dashboard port |

## Boundaries

- paper research only; no key/signer/send transaction path,
- hookless all-V4 only for Verified Positive,
- V4Quoter gas remains a proxy,
- quote completion is not inclusion,
- public RPC latency/rate limiting remains relevant,
- a profitable sample would not establish strategy-level expectancy,
- historical LONG5 executable P&L remains unknown without historical canonical state.

See [architecture](docs/ARCHITECTURE.md), [v0.8.1 audit](docs/V0.8.1_AUDIT.md), and [LONG5 replay](docs/LONG5_REPLAY.md).
