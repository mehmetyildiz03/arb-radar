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

type Freshness = 'empty' | 'idle' | 'live' | 'delayed' | 'stale';

interface OpportunitySummary extends Record<string, unknown> {
  key: string;
  timestampMs: number;
  status: 'positive' | 'nonpositive' | 'unavailable';
  token: unknown;
  buyMarket: unknown;
  sellMarket: unknown;
  grossSpreadPct: number | null;
  latestInputUsd: number | null;
  latestNetProfitUsd: number | null;
  bestObservedInputUsd: number | null;
  bestObservedNetProfitUsd: number | null;
  quoteCount: number;
  blockNumber: unknown;
  source: string;
  reason: string | null;
}

export interface DashboardSnapshot {
  paperOnly: true;
  generatedAtMs: number;
  database: {
    path: string;
    exists: boolean;
    lastObservationAtMs: number | null;
    ageMs: number | null;
    freshness: Freshness;
  };
  window: {
    durationMs: number;
    fromMs: number;
    toMs: number;
    analysisRowCap: number;
    truncated: {
      routeScreens: boolean;
      executableQuotes: boolean;
      lifecycleRows: boolean;
      rpcSamples: boolean;
    };
  };
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
    quoteBackedCandidates: number;
    positiveExecutableQuotes: number;
    nonpositiveExecutableQuotes: number;
    unavailableQuotes: number;
    positiveRatePct: number | null;
    uniqueTokens: number;
    medianRpcLatencyMs: number | null;
    p95RpcLatencyMs: number | null;
    medianFirstQuoteMs: number | null;
    p95FirstQuoteMs: number | null;
    medianSizingMs: number | null;
    p95SizingMs: number | null;
    lifecycleDeadlineSamples: number;
    missedLifecycleDeadlines: number;
    missedDeadlineRatePct: number | null;
    p95DeadlineMissMs: number | null;
    latestPositiveOpportunity: OpportunitySummary | null;
  };
  opportunities: OpportunitySummary[];
  timings: Array<Record<string, unknown>>;
  rpcLatency: Array<Record<string, unknown>>;
  paperPnl: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
  runtime: {
    lastTickAtMs: number | null;
    tickDurationMs: number | null;
    queued: number;
    droppedStale: number;
    probesStarted: number;
    probesCompleted: number;
    sizingStarted: number;
    sizingCompleted: number;
    maxActiveProbes: number;
    maxActiveSizing: number;
    probeConcurrency: number | null;
    sizingConcurrency: number | null;
    candidateMaxQueueMs: number | null;
    valuationFetches: number;
  };
}

const tableNames = ['launches','market_snapshots','route_screens','executable_quotes','opportunity_lifecycle','rpc_latency_samples','radar_runtime'] as const;
type TableName = typeof tableNames[number];
const DEFAULT_WINDOW_MS = 60_000;
const ANALYSIS_ROW_CAP = 5_000;

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
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const sorted = [...finite].sort((a,b)=>a-b);
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

function countSince(db: DatabaseSync, table: TableName, sinceMs: number): number {
  if (!hasTable(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE timestamp_ms >= ?`).get(sinceMs) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function rowsSince(db: DatabaseSync, table: TableName, sinceMs: number, limit = ANALYSIS_ROW_CAP): ObservationRow[] {
  if (!hasTable(db, table)) return [];
  return db.prepare(`SELECT id,timestamp_ms,block_number,source,observation_key,payload FROM ${table} WHERE timestamp_ms >= ? ORDER BY timestamp_ms DESC,id DESC LIMIT ?`)
    .all(sinceMs, Math.min(ANALYSIS_ROW_CAP, Math.max(1, Math.floor(limit)))) as unknown as ObservationRow[];
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

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function freshness(lastObservationAtMs: number | null, nowMs: number): { ageMs: number | null; freshness: Freshness } {
  if (lastObservationAtMs === null) return { ageMs: null, freshness: 'idle' };
  const ageMs = Math.max(0, nowMs - lastObservationAtMs);
  if (ageMs <= 15_000) return { ageMs, freshness: 'live' };
  if (ageMs <= 60_000) return { ageMs, freshness: 'delayed' };
  return { ageMs, freshness: 'stale' };
}

function routeFields(payload: Record<string, unknown>): {
  token: unknown;
  buyMarket: unknown;
  sellMarket: unknown;
  grossSpreadPct: number | null;
} {
  const route = payload.route as Record<string,unknown> | undefined;
  const screen = payload.screen as Record<string,unknown> | undefined;
  const buy = route?.buy as Record<string,unknown> | undefined;
  const sell = route?.sell as Record<string,unknown> | undefined;
  return {
    token: route?.token ?? null,
    buyMarket: buy?.quoteSymbol ?? buy?.index ?? null,
    sellMarket: sell?.quoteSymbol ?? sell?.index ?? null,
    grossSpreadPct: num(screen?.grossSpreadPct),
  };
}

function summarizeOpportunities(rows: ObservationRow[]): {
  opportunities: OpportunitySummary[];
  paperPnl: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
  latestPositiveOpportunity: OpportunitySummary | null;
} {
  type Mutable = OpportunitySummary & { _hasNumeric: boolean };
  const groups = new Map<string, Mutable>();
  const paperPnl: Array<{ timestampMs: number; netProfitUsd: number; key: string }> = [];
  let latestPositiveRow: { row: ObservationRow; payload: Record<string,unknown> } | null = null;

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload) continue;
    const fields = routeFields(payload);
    const current = groups.get(row.observation_key);
    const quote = payload.quote as Record<string,unknown> | undefined;
    const netProfitUsd = num(payload.netProfitUsd);
    const isUnavailable = payload.status === 'unavailable';

    if (!current) {
      groups.set(row.observation_key, {
        key: row.observation_key,
        timestampMs: row.timestamp_ms,
        status: isUnavailable ? 'unavailable' : (netProfitUsd !== null && netProfitUsd > 0 ? 'positive' : 'nonpositive'),
        token: fields.token,
        buyMarket: fields.buyMarket,
        sellMarket: fields.sellMarket,
        grossSpreadPct: fields.grossSpreadPct,
        latestInputUsd: quote ? num(quote.inputUsd) : null,
        latestNetProfitUsd: netProfitUsd,
        bestObservedInputUsd: quote ? num(quote.inputUsd) : null,
        bestObservedNetProfitUsd: netProfitUsd,
        quoteCount: netProfitUsd === null ? 0 : 1,
        blockNumber: quote?.blockNumber ?? row.block_number,
        source: row.source,
        reason: isUnavailable ? String(payload.reason ?? 'unavailable') : null,
        _hasNumeric: netProfitUsd !== null,
      });
    } else {
      if ((current.token === null || current.token === undefined) && fields.token !== null) current.token = fields.token;
      if ((current.buyMarket === null || current.buyMarket === undefined) && fields.buyMarket !== null) current.buyMarket = fields.buyMarket;
      if ((current.sellMarket === null || current.sellMarket === undefined) && fields.sellMarket !== null) current.sellMarket = fields.sellMarket;
      if (current.grossSpreadPct === null && fields.grossSpreadPct !== null) current.grossSpreadPct = fields.grossSpreadPct;
      if (netProfitUsd !== null) {
        current.quoteCount++;
        current._hasNumeric = true;
        if (current.bestObservedNetProfitUsd === null || netProfitUsd > current.bestObservedNetProfitUsd) {
          current.bestObservedNetProfitUsd = netProfitUsd;
          current.bestObservedInputUsd = quote ? num(quote.inputUsd) : null;
        }
      }
    }

    if (netProfitUsd !== null) {
      paperPnl.push({ timestampMs: row.timestamp_ms, netProfitUsd, key: row.observation_key });
      if (netProfitUsd > 0 && (!latestPositiveRow || row.timestamp_ms > latestPositiveRow.row.timestamp_ms)) {
        latestPositiveRow = { row, payload };
      }
    }
  }

  const opportunities = [...groups.values()]
    .map(({ _hasNumeric, ...item }) => {
      if (_hasNumeric) item.status = (item.bestObservedNetProfitUsd ?? 0) > 0 ? 'positive' : 'nonpositive';
      return item;
    })
    .sort((a,b)=>b.timestampMs-a.timestampMs);

  let latestPositiveOpportunity: OpportunitySummary | null = null;
  if (latestPositiveRow) {
    const { row, payload } = latestPositiveRow;
    const quote = payload.quote as Record<string,unknown> | undefined;
    const fields = routeFields(payload);
    const netProfitUsd = num(payload.netProfitUsd);
    latestPositiveOpportunity = {
      key: row.observation_key,
      timestampMs: row.timestamp_ms,
      status: 'positive',
      token: fields.token,
      buyMarket: fields.buyMarket,
      sellMarket: fields.sellMarket,
      grossSpreadPct: fields.grossSpreadPct,
      latestInputUsd: quote ? num(quote.inputUsd) : null,
      latestNetProfitUsd: netProfitUsd,
      bestObservedInputUsd: quote ? num(quote.inputUsd) : null,
      bestObservedNetProfitUsd: netProfitUsd,
      quoteCount: 1,
      blockNumber: quote?.blockNumber ?? row.block_number,
      source: row.source,
      reason: null,
    };
  }

  return {
    opportunities,
    paperPnl: paperPnl.sort((a,b)=>a.timestampMs-b.timestampMs).slice(-120),
    latestPositiveOpportunity,
  };
}

export function buildDashboardSnapshot(
  path = 'data/radar.sqlite',
  limit = 100,
  nowMs = Date.now(),
  recentWindowMs = DEFAULT_WINDOW_MS,
): DashboardSnapshot {
  const generatedAtMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const durationMs = Number.isFinite(recentWindowMs) && recentWindowMs > 0
    ? Math.min(15 * 60_000, Math.max(10_000, Math.floor(recentWindowMs)))
    : DEFAULT_WINDOW_MS;
  const fromMs = generatedAtMs - durationMs;

  const emptyBase = {
    paperOnly: true as const,
    generatedAtMs,
    database: { path, exists: false, lastObservationAtMs: null, ageMs: null, freshness: 'empty' as Freshness },
    window: {
      durationMs,
      fromMs,
      toMs: generatedAtMs,
      analysisRowCap: ANALYSIS_ROW_CAP,
      truncated: { routeScreens:false,executableQuotes:false,lifecycleRows:false,rpcSamples:false },
    },
    counts: { launches:0,marketSnapshots:0,routeScreens:0,executableQuotes:0,lifecycleRows:0,rpcSamples:0 },
    radar: {
      qualifyingScreens:0,quoteBackedCandidates:0,positiveExecutableQuotes:0,nonpositiveExecutableQuotes:0,
      unavailableQuotes:0,positiveRatePct:null,uniqueTokens:0,medianRpcLatencyMs:null,p95RpcLatencyMs:null,
      medianFirstQuoteMs:null,p95FirstQuoteMs:null,medianSizingMs:null,p95SizingMs:null,
      lifecycleDeadlineSamples:0,missedLifecycleDeadlines:0,missedDeadlineRatePct:null,p95DeadlineMissMs:null,
      latestPositiveOpportunity:null,
    },
    opportunities: [] as OpportunitySummary[],
    timings: [] as Array<Record<string,unknown>>,
    rpcLatency: [] as Array<Record<string,unknown>>,
    paperPnl: [] as Array<{timestampMs:number;netProfitUsd:number;key:string}>,
    runtime: { lastTickAtMs:null,tickDurationMs:null,queued:0,droppedStale:0,probesStarted:0,probesCompleted:0,sizingStarted:0,sizingCompleted:0,maxActiveProbes:0,maxActiveSizing:0,probeConcurrency:null,sizingConcurrency:null,candidateMaxQueueMs:null,valuationFetches:0 },
  };

  if (!existsSync(path)) return emptyBase;

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const recentCounts = {
      routeScreens: countSince(db,'route_screens',fromMs),
      executableQuotes: countSince(db,'executable_quotes',fromMs),
      lifecycleRows: countSince(db,'opportunity_lifecycle',fromMs),
      rpcSamples: countSince(db,'rpc_latency_samples',fromMs),
    };
    const screens = rowsSince(db,'route_screens',fromMs);
    const quoteRows = rowsSince(db,'executable_quotes',fromMs);
    const lifecycle = rowsSince(db,'opportunity_lifecycle',fromMs);
    const rpc = rowsSince(db,'rpc_latency_samples',fromMs);
    const runtimeRows = rowsSince(db,'radar_runtime',fromMs,20);
    let runtime = emptyBase.runtime;
    for (const row of runtimeRows) {
      const payload=parsePayload(row.payload);
      const scheduler=payload?.scheduler as Record<string,unknown> | undefined;
      if (!payload || !scheduler) continue;
      runtime = {
        lastTickAtMs: row.timestamp_ms,
        tickDurationMs: num(payload.durationMs),
        queued: num(scheduler.queued) ?? 0,
        droppedStale: num(scheduler.droppedStale) ?? 0,
        probesStarted: num(scheduler.probesStarted) ?? 0,
        probesCompleted: num(scheduler.probesCompleted) ?? 0,
        sizingStarted: num(scheduler.sizingStarted) ?? 0,
        sizingCompleted: num(scheduler.sizingCompleted) ?? 0,
        maxActiveProbes: num(scheduler.maxActiveProbes) ?? 0,
        maxActiveSizing: num(scheduler.maxActiveSizing) ?? 0,
        probeConcurrency: num(payload.probeConcurrency),
        sizingConcurrency: num(payload.sizingConcurrency),
        candidateMaxQueueMs: num(payload.candidateMaxQueueMs),
        valuationFetches: num(payload.valuationFetches) ?? 0,
      };
      break;
    }

    const qualifyingScreens = screens.reduce((total,row)=>{
      const payload=parsePayload(row.payload);
      const screen=payload?.screen as Record<string,unknown> | null | undefined;
      return total + (screen?.passesFeeFloor === true ? 1 : 0);
    },0);

    const tokens = new Set<string>();
    for (const row of screens) {
      const payload=parsePayload(row.payload);
      const route=payload?.route as Record<string,unknown> | undefined;
      if (typeof route?.token === 'string') tokens.add(route.token.toLowerCase());
    }

    const { opportunities: allOpportunities, paperPnl, latestPositiveOpportunity } = summarizeOpportunities(quoteRows);
    for (const item of allOpportunities) if (typeof item.token === 'string') tokens.add(item.token.toLowerCase());

    const quoteBackedCandidates = allOpportunities.filter(x=>x.quoteCount > 0).length;
    const positiveExecutableQuotes = allOpportunities.filter(x=>x.status === 'positive' && x.quoteCount > 0).length;
    const nonpositiveExecutableQuotes = allOpportunities.filter(x=>x.status === 'nonpositive' && x.quoteCount > 0).length;
    const unavailableQuotes = allOpportunities.filter(x=>x.status === 'unavailable').length;

    const timings: Array<Record<string,unknown>> = [];
    const firstQuoteDurations: number[] = [];
    const sizingDurations: number[] = [];
    const deadlineMisses: number[] = [];
    let lifecycleDeadlineSamples = 0;
    let missedLifecycleDeadlines = 0;
    const seenTimingKeys = new Set<string>();

    for (const row of lifecycle) {
      const payload=parsePayload(row.payload);
      if (!payload) continue;
      const timing=payload.measurementTiming as Record<string,unknown> | undefined;
      if (timing && !seenTimingKeys.has(row.observation_key)) {
        seenTimingKeys.add(row.observation_key);
        const firstQuote=num(timing.discoveryToFirstQuoteCompletedMs);
        const sizing=num(timing.sizingDurationMs);
        if (firstQuote !== null) firstQuoteDurations.push(firstQuote);
        if (sizing !== null) sizingDurations.push(sizing);
        timings.push({
          key:row.observation_key,
          timestampMs:row.timestamp_ms,
          discoveryToFirstQuoteStartedMs:num(timing.discoveryToFirstQuoteStartedMs),
          discoveryToFirstQuoteCompletedMs:firstQuote,
          sizingDurationMs:sizing,
          discoveryToPostSizingLifecycleMs:num(timing.discoveryToPostSizingLifecycleMs),
          firstExecutableQuoteSucceeded:timing.firstExecutableQuoteSucceeded === true,
          captureCapability:timing.captureCapability ?? null,
        });
      }
      const miss=num(payload.deadlineMissedByMs);
      const target=num(payload.targetMs);
      if (miss !== null && target !== null) {
        lifecycleDeadlineSamples++;
        deadlineMisses.push(miss);
        if (miss > 0) missedLifecycleDeadlines++;
      }
    }

    const rpcLatency = rpc.flatMap(row => {
      const payload=parsePayload(row.payload);
      const duration=num(payload?.durationMs);
      if (duration === null) return [];
      return [{ timestampMs:row.timestamp_ms,method:row.observation_key,durationMs:duration,status:payload?.status ?? null }];
    });
    const durations=rpcLatency.map(x=>x.durationMs as number);

    const lastObservationAtMs=latestTimestamp(db);
    const fresh=freshness(lastObservationAtMs,generatedAtMs);

    return {
      paperOnly:true,
      generatedAtMs,
      database:{path,exists:true,lastObservationAtMs,...fresh},
      window:{
        durationMs,fromMs,toMs:generatedAtMs,analysisRowCap:ANALYSIS_ROW_CAP,
        truncated:{
          routeScreens:recentCounts.routeScreens>ANALYSIS_ROW_CAP,
          executableQuotes:recentCounts.executableQuotes>ANALYSIS_ROW_CAP,
          lifecycleRows:recentCounts.lifecycleRows>ANALYSIS_ROW_CAP,
          rpcSamples:recentCounts.rpcSamples>ANALYSIS_ROW_CAP,
        },
      },
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
        quoteBackedCandidates,
        positiveExecutableQuotes,
        nonpositiveExecutableQuotes,
        unavailableQuotes,
        positiveRatePct:pct(positiveExecutableQuotes,quoteBackedCandidates),
        uniqueTokens:tokens.size,
        medianRpcLatencyMs:percentile(durations,0.5),
        p95RpcLatencyMs:percentile(durations,0.95),
        medianFirstQuoteMs:percentile(firstQuoteDurations,0.5),
        p95FirstQuoteMs:percentile(firstQuoteDurations,0.95),
        medianSizingMs:percentile(sizingDurations,0.5),
        p95SizingMs:percentile(sizingDurations,0.95),
        lifecycleDeadlineSamples,
        missedLifecycleDeadlines,
        missedDeadlineRatePct:pct(missedLifecycleDeadlines,lifecycleDeadlineSamples),
        p95DeadlineMissMs:percentile(deadlineMisses,0.95),
        latestPositiveOpportunity,
      },
      opportunities:allOpportunities.slice(0,clampLimit(limit)),
      timings:timings.sort((a,b)=>(b.timestampMs as number)-(a.timestampMs as number)).slice(0,clampLimit(limit)),
      rpcLatency:rpcLatency.slice(0,clampLimit(limit)),
      paperPnl,
      runtime,
    };
  } finally {
    db.close();
  }
}
