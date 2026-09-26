# Arb Radar architecture — v0.1

## Goal
Measure whether Par multi-market price dislocations on Robinhood Chain are sufficiently frequent, deep and persistent to justify building a real atomic arbitrage executor.

## Non-goals
- No wallet/private key.
- No signed transactions.
- No mainnet execution.
- No claim that a last-price spread is executable profit.
- No front-running assumption: Robinhood Sequencer Feed is an observation of an already ordered/built block, not a public mempool.

## Data planes

### A. Par indexer — discovery / research
`https://api.par.family`

Use for launches, market metadata, trade history, candles and coarse screening. Trade rows are indexed roughly ~1s after block, so this is not an execution signal.

### B. Robinhood RPC — canonical state / quote confirmation
`https://rpc.mainnet.chain.robinhood.com`

Use for state reads, Uniswap v4 quoting/simulation and receipts. Public endpoint is rate-limited; production may later need a provider.

### C. Robinhood Sequencer Feed — early observation
`wss://feed.mainnet.chain.robinhood.com`

Use experimentally to reconstruct/shadow next state earlier than downstream RPC/indexer visibility. Feed messages must never be treated as settlement or a mempool/front-running opportunity.

## Pipeline
1. Discover multi-market launches.
2. Normalize each market price to ETH (`lastPriceEth`) for coarse comparison.
3. Enumerate N*(N-1) directed routes.
4. Apply fee-only screen.
5. For survivors, obtain amount-sensitive executable quotes from v4 Quoter / call simulation.
6. Search optimal input size subject to capital and risk limits.
7. Requote at +100/+250/+500/+1000 ms and record opportunity decay.
8. Paper-record only.

## Promotion gate to execution
Execution work starts only if paper data demonstrates all of:
- positive net P&L after amount-sensitive price impact, routing, gas and failure allowance;
- sufficient sample size across independent launches;
- opportunities survive long enough for our measured end-to-end latency;
- quote/state reconciliation shows a low false-positive rate;
- testnet atomic executor passes adversarial and revert-path tests.
