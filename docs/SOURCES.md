# Primary sources used for v0.1 design

- Par integrator docs: https://par.family/docs
  - multi-market launches are ordinary Uniswap v4 pools
  - up to five markets per multi launch
  - public indexer `https://api.par.family`
  - `lastPriceEth` provides a common ETH-normalized price for indexed market data
  - trades appear in the indexer roughly ~1 second after the block
  - SDK: https://github.com/pardotfamily/par-sdk

- Robinhood Chain connection docs: https://docs.robinhood.com/chain/connecting/
  - public mainnet RPC `https://rpc.mainnet.chain.robinhood.com`
  - public sequencer feed `wss://feed.mainnet.chain.robinhood.com`
  - public endpoints are rate-limited/not recommended for production

- Chainstack reference sequencer decoder: https://github.com/chainstacklabs/robinhood-chain-sequencer-feed
  - feed is not a public mempool
  - block ordering/build has already happened when broadcast is observed
  - feed carries no execution outcome and must be reconciled against a node

## v0.2 implementation references and fixtures

- Pinned Par SDK commit: https://github.com/pardotfamily/par-sdk/tree/f5a5beb9f9efc17eaca0e2edf85648fa02bb2beb
  - `dist/trade.js` documents selected multi-router legs, ETH routes, and the launcher ERC-20 balance/allowance storage overrides used by the read-only adapter.
  - `dist/pool.js` documents the PoolManager slot0 read used for reconciliation.
- Uniswap Quoter interface: https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol
  - Reviewed as an alternative; this implementation uses actual Par router eth_call simulation rather than an unverified Quoter deployment address.
- Chainstack framing/reference: https://github.com/chainstacklabs/robinhood-chain-sequencer-feed
  - Reviewed `src/rhfeed/codec.py` (Git blob cdc9f197312d0761a20c47d1e3af31e9f4eafef4) and `verify.py` (2430e28dd4dbb4d6a67f1cd264e6d3e100882a8d).
  - Independently captured `tests/verified_message.json` (blob 330f2de0458f352c5dba4b2f44095c2ae94d7aaf) is retained as `tests/fixtures/sequencer-verified.json`. Its Apache-2.0 license is in `tests/fixtures/CHAINSTACK-LICENSE`. The TypeScript framing/preimage implementation is adapted for this project; transaction parsing uses viem rather than the reference's custom RLP parser.
  - The pinned feed authority was historically checked against L1 by the reference. This application verifies signatures locally; it does not dynamically track L1 authority rotations.
- LONG5 discovery: https://api.par.family/launches?q=LONG5&limit=100
  - Retrieved 2026-09-26 UTC. `long5-launches.json` retains the search response. `long5-trades.json` contains each exact trade URL, HTTP status and capture timestamp. Symbol collisions are kept distinct by address.
- USD valuation endpoint: https://api.coinbase.com/v2/prices/ETH-USD/spot
  - Used only to express paper amounts in USD. Raw ETH input/output remains recorded.
