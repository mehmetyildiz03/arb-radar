# LONG5 paper replay

Five most-traded exact LONG5 symbols among the first 100 search results; not exhaustive.

| Token | Trades | Block observations | Fee-floor dislocations |
|---|---:|---:|---:|
| 0xc8ae1ae44c79af0a529a8acfffa425654771c812 | 64 | 29 | 27 |
| 0x4d3ac7a97cf59b79b466215438b8aed30be9aef7 | 62 | 23 | 43 |
| 0x21d98c6eb8918d2c20be37ca565201c03029ff6a | 61 | 27 | 29 |
| 0xe3dfd5a068233b9461cd2d84396bb9d95fa73862 | 52 | 12 | 0 |
| 0x483f8d260689d603fa9b51b8fdacd5b40141dea9 | 34 | 17 | 9 |

Best executable size by timestamp, gross/net P&L, profitability half-life, and realistic capture by a $100 paper wallet: **unknown**. The saved indexer histories do not contain historical amount-sensitive simulations, complete routing state, gas observations, or subsecond quotes. Do not interpret fee-floor dislocations as executable profit.

Replay starts with no market prices, applies trades in block/log order, groups each block before screening, and rejects market prices older than 60 seconds. Prices remain trade observations, not guaranteed simultaneous pool state. No future prices are backfilled. Token addresses disambiguate duplicate symbols.

Timestamp-level observations and explicit null results are in LONG5_REPLAY.json. Fixtures include public source URLs and capture timestamps. Run `npm run replay` offline to reproduce. Live opportunity lifecycle measurement is a separate experiment; its timing cannot be imputed to these historical launches.
