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
