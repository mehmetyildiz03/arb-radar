# Arb Radar v0.8.3 — Economic Truth Engine

Paper-only research radar for Par multi-market dislocations on Robinhood Chain. The application has no wallet, private key, signer, transaction submission, or automated trading path.

v0.8 changes the research question from **"do two indexer prices look far apart?"** to **"does one closed cycle, starting and ending in the same base asset, remain positive when canonical onchain state and an amount-sensitive quote are used?"**

## What is verified in v0.8

The indexer is used for discovery and immutable/curve metadata only. It is not the source of executable price truth.

For each recent multi-market launch, the engine:

1. loads typed Par market and reference-route metadata,
2. pins one canonical Robinhood block for screening,
3. builds directed closed cycles between market pairs,
4. removes any common reference-route prefix so the cycle is not forced to ETH,
5. reads V4 pool state from Robinhood's canonical Uniswap StateView at that block,
6. computes the fee-aware infinitesimal cycle edge from those same-block states,
7. admits only hookless all-V4 cycles to the verified quote path,
8. first-probes the cycle at the **current** block with one canonical V4Quoter multi-hop quote,
9. sizes with exact quotes, using an analytical constant-product optimum only as a seed when strict assumptions hold,
10. records lifecycle, run identity, RPC latency and paper P&L in SQLite.

A dashboard row is **Verified Positive** only when a quote is marked `verifiedClosedCycle=true` and the same-base exact quote remains positive after the explicit research costs. Legacy/indexer-only positives cannot become green.

This is still paper evidence. It does not prove transaction inclusion, atomic-executor gas, realized profit, or future opportunity persistence.

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
```

- `npm start`: one read-only economic-truth scan.
- `npm run watch`: repeated scans.
- `npm run dev`: radar watch + local dashboard.
- `npm run dashboard`: dashboard only, using an existing SQLite file.
- `npm run replay`: offline LONG5 historical screening replay.
- `npm run sequencer`: bounded already-ordered feed experiment.

Local dashboard: `http://127.0.0.1:4173`.

## Economic truth model

### Closed-cycle routing

For a directed market pair the engine searches for a common base along the two Par reference routes. A cycle can therefore be:

`BASE -> quoteCheap -> Par token -> quoteExpensive -> BASE`

rather than always:

`ETH -> ... -> quoteCheap -> token -> quoteExpensive -> ... -> ETH`.

The structural selector prefers an all-V4 cycle and then fewer hops. Verified quoting currently requires every hop to be V4 and hookless. Cycles containing V3 hops or hooks remain outside the verified-green path rather than being approximated.

### Same-block screening

Screening state comes from canonical V4 StateView reads at one block. For each V4 pool the engine reads slot0 and active liquidity and applies Uniswap v4's directional protocol-fee + LP-fee composition. The indexer's `lastPriceEth` is not used to decide whether a v0.8 opportunity is executable.

The screen is infinitesimal/marginal only. It is a cheap onchain filter, not a profit quote. Every hop must have non-zero active V4 liquidity before a marginal edge can enter the candidate queue. v0.8.2 then uses exact executable depth, not the marginal percentage, to decide how far sizing may continue.

### Exact amount-sensitive quote

The first executable probe uses the deployed Robinhood V4Quoter as one multi-hop closed-cycle quote. v0.8.2 probes from $0.01 so cent-scale executable depth is not hidden by a larger fixed minimum. The quote starts and ends in the same raw base asset, so no nominal cross-asset comparison is treated as profit.

Screen block and quote block are intentionally different concepts:
- the screen records when an edge was observed;
- the first probe quotes the latest block when the probe actually starts;
- sizing pins one block for all amount comparisons in that sizing pass.

This prevents a stale profitable screen from being presented as a current executable result.

### Sizing

Sizing is now **depth-aware and monotonic**. At one pinned sizing block the engine attempts `$0.01 → $0.03 → $0.10 → $0.30 → $1 → $3 → $10 → $30 → $100` (bounded by paper capital and max trade). If canonical V4Quoter returns `NotEnoughLiquidity`, that notional becomes an observed depth boundary and larger sizes are not attempted. Any other quote/RPC error still fails closed.

If the smallest exact quote has gross output <= input, sizing stops immediately because a larger hookless V4 trade cannot improve average execution on that directed cycle. Successful exact quotes are retained even when the next size hits the liquidity boundary.

The constant-product model remains available only as an **analytical seed** under strict Par liquidity/curve assumptions. Seed validation points are considered only inside the already-observed executable depth region. Analytical math never creates a green result by itself.

## Paper cost model

For an exact closed-cycle quote, v0.8.3 uses:

`paper net = base output value - base input value - calibrated research gas - parent-data fee - 1% safety margin`

The engine queries Nitro's NodeInterface `gasEstimateComponents` with representative executor calldata. When available:

- transaction child-gas overhead is added to the V4Quoter swap-gas proxy,
- the existing 20% research gas buffer is applied,
- the parent/data fee is measured from Nitro instead of using a fixed dollar allowance.

If NodeInterface is unavailable or invalid, the quote fails closed to the previous conservative model: V4Quoter gas + 20% and the legacy $0.05 allowance. The dashboard identifies each quote as **NITRO CALIBRATED** or **LEGACY FALLBACK** and exposes the fallback reason.

The 1% safety margin remains unchanged. V4Quoter gas is still **not** a deployed atomic-executor gas measurement; state-override executor simulation is the next accuracy target.

Coinbase ETH/USD is used only to report common USD values. A non-ETH base is valued at the same canonical block through Par's onchain QuotePricer and then combined with ETH/USD. The actual arbitrage quote itself remains same-base raw units.

## Run-isolated measurement

Every process creates:
- `runId`
- `engineVersion`
- `runStartedAtMs`

They are persisted across route screens, executable quotes, lifecycle rows, RPC samples and runtime telemetry. The dashboard defaults to **Current run**, can select a recent run explicitly, or show all runs.

The current-run funnel is counted directly in SQLite by distinct candidate key; it is not limited by the dashboard's 5,000-row display/analysis cap.

## Dashboard semantics

The v0.8 funnel is:

**Same-block truth -> Closed-cycle quoted -> Verified paper positive**

The table also exposes:
- base asset,
- hop count,
- exact first-probe depth edge (marginal spot outliers are not presented as executable spread),
- depth-rejected candidate count and `NotEnoughLiquidity` failure count,
- first probe,
- latest/best paper net,
- block,
- engine/truth metadata internally.

"Verified" means verified by the v0.8 closed-cycle research path, not verified future execution or realized return.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PAR_API_BASE` | `https://api.par.family` | Public discovery/indexer metadata |
| `ROBINHOOD_RPC_URL` | public Robinhood mainnet RPC | Read-only canonical RPC |
| `ROBINHOOD_FEED_URL` | public sequencer feed | Already-ordered research feed |
| `RADAR_DB` | `data/radar.sqlite` | SQLite output |
| `POLL_MS` | 1000 | Delay between completed watch scans |
| `PAPER_CAPITAL_USD` | 100 | Total paper budget |
| `MAX_CANDIDATE_TRADE_USD` | 100 | Maximum quote input |
| `MIN_CANDIDATE_TRADE_USD` | 0.01 | Exact first-probe and depth-ladder minimum |
| `MIN_NET_PROFIT_USD` | 0.05 | Accepted paper-net threshold |
| `PROBE_CONCURRENCY` | 2 | Parallel first-probe phases, max 8 |
| `SIZING_CONCURRENCY` | 1 | Parallel candidate sizing phases, max 4 |
| `SIZING_QUOTE_CONCURRENCY` | 2 | Fixed-block sizing quote concurrency, max 4 |
| `CANDIDATE_MAX_QUEUE_MS` | 2500 | Drop before expensive probe when stale in queue |
| `TRUTH_LAUNCH_LIMIT` | 8 | Recent launches examined per truth scan, max 30 |
| `TRUTH_SCAN_CONCURRENCY` | 2 | Concurrent launch truth scans, max 4 |
| `DASHBOARD_HOST` | `127.0.0.1` | Local dashboard bind |
| `DASHBOARD_PORT` | 4173 | Local dashboard port |

## Safety and research boundaries

The main RPC transport allowlists read methods only. No secret configuration, account, signing or transaction broadcasting is required by the application.

The important remaining limits are:

- only hookless all-V4 closed cycles are eligible for verified quoting;
- V4Quoter gas is a research proxy rather than atomic executor gas;
- quote completion is not transaction inclusion;
- public RPC latency/rate limiting can dominate short-lived opportunities;
- a positive sample does not establish strategy-level expectancy;
- LONG5 historical data still lacks historical executable same-block state needed to reconstruct past closed-cycle P&L honestly.

See [architecture](docs/ARCHITECTURE.md), [v0.8.3 cost audit](docs/V0.8.3_AUDIT.md), [v0.8.2 depth audit](docs/V0.8.2_AUDIT.md), [v0.8 audit](docs/V0.8_AUDIT.md), and [LONG5 replay](docs/LONG5_REPLAY.md).
