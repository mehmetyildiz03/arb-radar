import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

interface ObservationRow {
  id: number;
  timestamp_ms: number;
  block_number: string | null;
  source: string;
  observation_key: string;
  payload: string;
}

export interface DashboardSnapshot {
  paperOnly: true;
  generatedAtMs: number;
  database: { path: string; exists: boolean; lastObservationAtMs: number | null };
  counts: {
    launches: number;
    marketSnapshots: number;
    routeScreens: number;
    executableQuotes: number;
    lifecycleRows: number;
    rpcSamples: number;
  };
  radar: {
    qualifyingScreens: number;
    positiveExecutableQuotes: number;
    unavailableQuotes: number;
    medianRpcLatencyMs: number | null;
    p95RpcLatencyMs: number | null;
  };
  opportunities: Array<Record<string, unknown>>;
  timings: Array<Record<string, unknown>>;
  rpcLatency: Array<Record<string, unknown>>;
}

const tableNames = ['launches','market_snapshots','route_screens','executable_quotes','opportunity_lifecycle','rpc_latency_samples'] as const;
type TableName = typeof tableNames[number];

function clampLimit(value: number, fallback = 100): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(value)));
}

function parsePayload(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function hasTable(db: DatabaseSync, table: TableName): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function countRows(db: DatabaseSync, table: TableName): number {
  if (!hasTable(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function rows(db: DatabaseSync, table: TableName, limit: number): ObservationRow[] {
  if (!hasTable(db, table)) return [];
  return db.prepare(`SELECT id,timestamp_ms,block_number,source,observation_key,payload FROM ${table} ORDER BY timestamp_ms DESC,id DESC LIMIT ?`)
    .all(clampLimit(limit)) as unknown as ObservationRow[];
}

function latestTimestamp(db: DatabaseSync): number | null {
  let latest: number | null = null;
  for (const table of tableNames) {
    if (!hasTable(db, table)) continue;
    const row = db.prepare(`SELECT MAX(timestamp_ms) AS value FROM ${table}`).get() as { value?: number | null } | undefined;
    const value = row?.value;
    if (typeof value === 'number' && Number.isFinite(value) && (latest === null || value > latest)) latest = value;
  }
  return latest;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildDashboardSnapshot(path = 'data/radar.sqlite', limit = 100): DashboardSnapshot {
  const generatedAtMs = Date.now();
  if (!existsSync(path)) {
    return {
      paperOnly: true,
      generatedAtMs,
      database: { path, exists: false, lastObservationAtMs: null },
      counts: { launches:0,marketSnapshots:0,routeScreens:0,executableQuotes:0,lifecycleRows:0,rpcSamples:0 },
      radar: { qualifyingScreens:0,positiveExecutableQuotes:0,unavailableQuotes:0,medianRpcLatencyMs:null,p95RpcLatencyMs:null },
      opportunities: [], timings: [], rpcLatency: [],
    };
  }

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const screens = rows(db,'route_screens',Math.max(limit,250));
    const quotes = rows(db,'executable_quotes',limit);
    const lifecycle = rows(db,'opportunity_lifecycle',Math.max(limit,250));
    const rpc = rows(db,'rpc_latency_samples',Math.max(limit,250));

    const qualifyingScreens = screens.reduce((total,row)=>{
      const payload=parsePayload(row.payload);
      const screen=payload?.screen as Record<string,unknown> | null | undefined;
      return total + (screen?.passesFeeFloor === true ? 1 : 0);
    },0);

    let positiveExecutableQuotes=0, unavailableQuotes=0;
    const opportunities: Array<Record<string, unknown>> = [];
    for (const row of quotes) {
      const payload=parsePayload(row.payload);
      if (!payload) continue;
      if (payload.status === 'unavailable') {
        unavailableQuotes++;
        opportunities.push({ key:row.observation_key,timestampMs:row.timestamp_ms,status:'unavailable',reason:String(payload.reason ?? 'unavailable'),source:row.source });
        continue;
      }
      const quote = payload.quote as Record<string,unknown> | undefined;
      const route = payload.route as Record<string,unknown> | undefined;
      const screen = payload.screen as Record<string,unknown> | undefined;
      const netProfitUsd=num(payload.netProfitUsd);
      if (!quote || !route || netProfitUsd === null) continue;
      if (netProfitUsd > 0) positiveExecutableQuotes++;
      const buy=route.buy as Record<string,unknown> | undefined;
      const sell=route.sell as Record<string,unknown> | undefined;
      opportunities.push({
        key:row.observation_key,
        timestampMs:row.timestamp_ms,
        status: netProfitUsd > 0 ? 'positive' : 'nonpositive',
        token:route.token ?? null,
        buyMarket:buy?.quoteSymbol ?? buy?.index ?? null,
        sellMarket:sell?.quoteSymbol ?? sell?.index ?? null,
        grossSpreadPct:num(screen?.grossSpreadPct),
        inputUsd:num(quote.inputUsd),
        outputUsd:num(quote.outputUsd),
        gasUsd:num(quote.gasUsd),
        extraCostsUsd:num(quote.extraCostsUsd),
        safetyMarginUsd:num(quote.safetyMarginUsd),
        netProfitUsd,
        blockNumber:quote.blockNumber ?? row.block_number,
        source:row.source,
      });
    }

    const timings = lifecycle.flatMap(row => {
      const payload=parsePayload(row.payload);
      const timing=payload?.measurementTiming as Record<string,unknown> | undefined;
      if (!timing) return [];
      return [{
        key:row.observation_key,
        timestampMs:row.timestamp_ms,
        discoveryToFirstQuoteStartedMs:num(timing.discoveryToFirstQuoteStartedMs),
        discoveryToFirstQuoteCompletedMs:num(timing.discoveryToFirstQuoteCompletedMs),
        sizingDurationMs:num(timing.sizingDurationMs),
        discoveryToPostSizingLifecycleMs:num(timing.discoveryToPostSizingLifecycleMs),
        firstExecutableQuoteSucceeded:timing.firstExecutableQuoteSucceeded === true,
        captureCapability:timing.captureCapability ?? null,
      }];
    });

    const rpcLatency = rpc.flatMap(row => {
      const payload=parsePayload(row.payload);
      const durationMs=num(payload?.durationMs);
      if (durationMs === null) return [];
      return [{ timestampMs:row.timestamp_ms,method:row.observation_key,durationMs,status:payload?.status ?? null }];
    });
    const durations=rpcLatency.map(x=>x.durationMs as number);

    return {
      paperOnly:true,
      generatedAtMs,
      database:{path,exists:true,lastObservationAtMs:latestTimestamp(db)},
      counts:{
        launches:countRows(db,'launches'),
        marketSnapshots:countRows(db,'market_snapshots'),
        routeScreens:countRows(db,'route_screens'),
        executableQuotes:countRows(db,'executable_quotes'),
        lifecycleRows:countRows(db,'opportunity_lifecycle'),
        rpcSamples:countRows(db,'rpc_latency_samples'),
      },
      radar:{
        qualifyingScreens,
        positiveExecutableQuotes,
        unavailableQuotes,
        medianRpcLatencyMs:percentile(durations,0.5),
        p95RpcLatencyMs:percentile(durations,0.95),
      },
      opportunities,
      timings,
      rpcLatency,
    };
  } finally {
    db.close();
  }
}
