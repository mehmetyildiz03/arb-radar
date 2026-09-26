# Arb Radar v0.2

Paper-only research radar for cross-market price dislocations in Par launches on Robinhood Chain. No credentials, wallet, signing, transaction submission, or mainnet execution are implemented.

All P&L is paper/theoretical. Last-trade screening is never executable profit. `rpc-simulation` quotes include amount-sensitive buy/sell and reference routing at one block; they still do not prove atomic execution, future inclusion, or realized returns.

## Run

Requires Node >=22.13 (built-in SQLite) and Git for the pinned SDK dependency.

```bash
npm ci
npm run check
npm start
npm run watch
npm run replay
npm run sequencer
```

`start` performs one public read-only scan; `watch` repeats after each scan. `replay` is offline and reproduces the committed LONG5 report. `sequencer` observes for 15 seconds by default and exits. Tests require no network or secrets. CI checks Node 22 and 24.

## Data and calculations

- Typed `par-sdk` discovery filters multi-market launches; SDK metadata/routes are cached for 60 seconds (routing qualification can change).
- Exactly N*(N-1) directed routes for N independent markets. Screens reject stale, missing, nonpositive, nonfinite and duplicate market data. Default last-trade age limit: 60 seconds.
- Fee floor uses each leg's fee. For two 3% pools: `1 / (0.97 * 0.97) = 1.062812...`. Routing, impact and gas come later.
- The simulation adapter makes `eth_call` and `eth_estimateGas` calls to Par's v4 router with exactly one buy market and one sell market, including their ETH conversion hops. Raw amounts stay bigint. Both legs use one block, checked again for reorgs. It does not approximate concentrated liquidity with constant-product math.
- Repeated/shared pools and hooks are excluded: independent calls cannot reproduce their sequential state changes. Unsupported state overrides/reverts produce an unavailable quote, never a last-price fallback.
- Coinbase ETH/USD is a public valuation input, with retrieval time and source saved; it is not an executable FX quote. Valuations older than 60 seconds are rejected.
- Paper net = quoted output - input - gas - extra allowance - safety margin. Gas uses the sum of both router estimates plus 20%. The explicit extra allowance is $0.05; the safety margin is 1% of output. These are research assumptions, not a verified atomic/L1 cost bound. Capital must cover input, gas and the extra allowance. Search is an eight-size grid, not a proof of a global optimum.
- Candidate lifecycle targets are 0/100/250/500/1000ms after sizing. Slow calls are serialized to respect public RPC limits: actual start/completion times and missed deadlines are saved. Zero-profit crossing and 50%-profit decay are separate metrics. Missing samples stay unknown and surviving observations are right-censored.
- SQLite records launches, market snapshots, screens, quotes/errors, lifecycle and RPC latency. Every row has timestamp/source/block columns; a null block explicitly means the source did not supply one. Bigints are decimal strings in JSON. No current head is falsely attached to indexer data.

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
| FEED_SECONDS | 15 | Bounded sequencer experiment, max 300 |

HTTP retry/backoff is bounded and honors Retry-After (capped at 10 seconds). Public endpoint errors are recorded; paid keys are not required. Single-scan discovery failure exits nonzero; watch mode continues. Ctrl+C stops watch after the current scan.

## Research results and limits

[LONG5 replay](docs/LONG5_REPLAY.md) covers five explicitly identified tokens, with reproducible block-level screens. Historical executable sizes, P&L and subsecond half-lives are unknown because the saved history lacks the necessary simulations and observations. The report does not infer capture by a $100 wallet.

The sequencer experiment verifies the Nitro feed signature against a pinned public authority, decodes signed transaction batches, marks next-block candidates, and checks a log-derived shadow price against canonical RPC slot0. Gaps/reorgs invalidate the shadow cache. Calldata alone never updates pool prices. This is a limited reconciliation experiment, not a full speculative EVM or a demonstrated latency advantage. The feed is already ordered, not a public mempool. Authority rotation requires re-verification and a code update; failures are rejected.

See [architecture](docs/ARCHITECTURE.md), [audit](docs/V0.2_AUDIT.md), and [handoff specification](docs/ASTRA_HANDOFF.md).
