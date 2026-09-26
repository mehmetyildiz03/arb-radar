import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const tables = ['launches', 'market_snapshots', 'route_screens', 'executable_quotes', 'opportunity_lifecycle', 'rpc_latency_samples', 'sequencer_observations'] as const;
export type ObservationTable = typeof tables[number];
export interface Provenance { timestampMs: number; blockNumber: bigint | number | null; source: string }
export const json = (value: unknown): string => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

export class ResearchStore {
  readonly db: DatabaseSync;
  constructor(path = 'data/radar.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, block_number TEXT,
      source TEXT NOT NULL, observation_key TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${table}_lookup ON ${table}(observation_key, timestamp_ms);`);
    this.db.exec('PRAGMA user_version=2');
  }
  record(table: ObservationTable, key: string, data: unknown, provenance: Provenance): void {
    if (!tables.includes(table) || !Number.isFinite(provenance.timestampMs) || !provenance.source) throw new Error('Invalid observation');
    this.db.prepare(`INSERT INTO ${table}(timestamp_ms,block_number,source,observation_key,payload) VALUES (?,?,?,?,?)`)
      .run(provenance.timestampMs, provenance.blockNumber?.toString() ?? null, provenance.source, key, json(data));
  }
  close(): void { this.db.close(); }
}
