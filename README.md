# Arb Radar v0.1

Paper-only research radar for cross-market price dislocations in Par multi-market launches on Robinhood Chain.

## Safety boundary

v0.1 has **no private key, wallet signer, transaction builder, or execution path**. It only reads public data and records/scores candidate spreads.

## Architecture

1. `ParIndexerClient` discovers recent multi-market launches and reads each market's ETH-normalized last price.
2. `enumerateDirectedRoutes` generates N×(N-1) directed cross-market routes (5 markets => 20 routes).
3. `screenRoute` rejects spreads that do not clear both pool fees. This is only a screening step — not an executable-profit claim.
4. `optimizeRoute` is deliberately quote-provider driven. A future v4 Quoter/RPC adapter must supply amount-sensitive outputs, gas and extra costs before any opportunity can be called executable.
5. Sequencer feed integration is intentionally non-executing in v0.1. Robinhood's feed is not a public mempool: the sequencer has already ordered/built the block when it broadcasts. A future shadow-state adapter may use it to react into the next block, never to claim front-running of the observed block.

## Important math

For two 3% pool legs, ignoring all other costs:

`break-even gross ratio = 1 / (0.97 * 0.97) = 1.062812...`

So a raw spread around 6.28% is only the fee floor; real execution also needs to cover price impact/slippage, quote-asset routing, gas and latency/state risk.

## Commands

```bash
npm install
npm run check
npm start
```

The live read-only command requires network access to `https://api.par.family`; tests do not.

## v0.2 target

- integrate `par-sdk` + `viem`
- use Uniswap v4 Quoter/state reads for amount-sensitive execution quotes
- persist observations in SQLite
- measure opportunity half-life (0/100/250/500/1000 ms)
- add Robinhood sequencer decoder / shadow-state experiment
- replay known launches such as LONG5
- only after evidence supports it: testnet atomic executor; mainnet execution remains out of scope until explicit promotion

See `docs/ASTRA_HANDOFF.md` for the implementation package and acceptance criteria.
