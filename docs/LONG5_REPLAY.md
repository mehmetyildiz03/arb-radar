# LONG5 paper replay

## Original research target

Address: **0x9bbd4d06ac29d8900b34998a56e96a33c16220f0**. Status: **partial-indexer-history**. Indexed symbol: Xl5.

Latest at most 2000 trades; not a complete launch-era replay. Missing earlier state is not backfilled.

Captured trades: 2000; indexed total: 14683; block observations: 922; fee-floor dislocations: 1490.

Launch source: https://api.par.family/launches/0x9bbd4d06ac29d8900b34998a56e96a33c16220f0 (HTTP 200). Trade source: https://api.par.family/trades?token=0x9bbd4d06ac29d8900b34998a56e96a33c16220f0&limit=2000 (HTTP 200). Capture: 2026-09-26T21:19:26.989Z.

Executable size, gross/net P&L, half-life and $100 capture feasibility remain null/unknown. Historical amount-sensitive state is not available in this fixture. An unavailable original target is reported explicitly and is never replaced by a matching symbol.

## Comparison cohort

Comparison cohort only: five most-traded exact LONG5 symbols among the first 100 search results; these do not substitute for the original target.

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
