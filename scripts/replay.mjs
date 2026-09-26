import { readFileSync, writeFileSync } from 'node:fs';
import { replayTrades } from '../dist/research/replay.js';
const launches = JSON.parse(readFileSync('tests/fixtures/long5-launches.json', 'utf8'));
const captures = JSON.parse(readFileSync('tests/fixtures/long5-trades.json', 'utf8'));
const reports = captures.map(c => ({ source: c.url, capturedAt: c.capturedAt,
  ...replayTrades(launches.find(l => l.token === c.token), c.trades) }));
const report = { paperOnly: true, cohort: 'Five most-traded exact LONG5 symbols among the first 100 search results; not exhaustive.', reports };
writeFileSync('docs/LONG5_REPLAY.json', JSON.stringify(report, null, 2) + '\n');
const lines = ['# LONG5 paper replay', '', report.cohort, '',
  '| Token | Trades | Block observations | Fee-floor dislocations |', '|---|---:|---:|---:|',
  ...reports.map(r => `| ${r.token} | ${r.trades} | ${r.frames.length} | ${r.frames.reduce((n,f)=>n+f.dislocations.length,0)} |`), '',
  'Best executable size by timestamp, gross/net P&L, profitability half-life, and realistic capture by a $100 paper wallet: **unknown**. The saved indexer histories do not contain historical amount-sensitive simulations, complete routing state, gas observations, or subsecond quotes. Do not interpret fee-floor dislocations as executable profit.', '',
  'Replay starts with no market prices, applies trades in block/log order, groups each block before screening, and rejects market prices older than 60 seconds. Prices remain trade observations, not guaranteed simultaneous pool state. No future prices are backfilled. Token addresses disambiguate duplicate symbols.', '',
  'Timestamp-level observations and explicit null results are in LONG5_REPLAY.json. Fixtures include public source URLs and capture timestamps. Run `npm run replay` offline to reproduce. Live opportunity lifecycle measurement is a separate experiment; its timing cannot be imputed to these historical launches.', ''];
writeFileSync('docs/LONG5_REPLAY.md', lines.join('\n'));
console.log(lines.join('\n'));
