import { ParIndexer, type Par, type TradableLaunch } from 'par-sdk';
import type { HexAddress, LaunchSnapshot } from '../domain.js';
import { normalizeLaunch } from './parIndexer.js';
import { resilientFetch } from './network.js';

export class Discovery {
  readonly indexer: ParIndexer;
  private readonly cache = new Map<string, { at: number; value: TradableLaunch }>();
  constructor(private readonly par: Pick<Par, 'getTradable'>, url = 'https://api.par.family', private readonly now = Date.now) {
    this.indexer = new ParIndexer(url, resilientFetch());
  }
  async metadata(token: HexAddress): Promise<TradableLaunch | null> {
    const key = token.toLowerCase();
    const cached = this.cache.get(key);
    // Pool metadata is immutable, but routing qualification may change. Refresh it periodically.
    if (cached && this.now() - cached.at < 60_000) return cached.value;
    const value = await this.par.getTradable(token);
    if (value) {
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: this.now(), value });
    }
    return value;
  }
  async latest(limit = 30): Promise<LaunchSnapshot[]> {
    const rows = await this.indexer.launches({ orderBy: 'lastTradeAt', orderDirection: 'desc', limit });
    return rows.map(normalizeLaunch).filter((x): x is LaunchSnapshot => !!x && x.kind === 'multi' &&
      new Set(x.markets.map(m => m.poolId ?? `index:${m.index}`)).size >= 2);
  }
}
