import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { quoteCostBreakdown, type QuoteCostBreakdown } from '../research/costs.js';

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
  firstProbeTimestampMs: number | null;
  firstProbeInputUsd: number | null;
  firstProbeNetProfitUsd: number | null;
  firstProbeCostBreakdown: QuoteCostBreakdown | null;
  firstProbeProfile: Record<string, number> | null;
  latestInputUsd: number | null;
  latestNetProfitUsd: number | null;
  latestCostBreakdown: QuoteCostBreakdown | null;
  latestProfile: Record<string, number> | null;
  bestObservedInputUsd: number | null;
  bestObservedNetProfitUsd: number | null;
  bestObservedCostBreakdown: QuoteCostBreakdown | null;
  bestObservedProfile: Record<string, number> | null;
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
  pnlTraces: {
    firstProbe: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
    bestObserved: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
  };
  pipeline: {
    phases: Record<string, { medianMs: number | null; p95Ms: number | null; samples: number }>;
    dominantPhase: { key: string; medianMs: number } | null;
    simulation: Record<string, { medianMs: number | null; p95Ms: number | null; samples: number }>;
    dominantSimulationStep: { key: string; medianMs: number } | null;
  };
  run: {
    mode: 'current' | 'specific' | 'all';
    selectedRunId: string | null;
    currentRunId: string | null;
    engineVersion: string | null;
    recentRuns: Array<{ runId: string; engineVersion: string; runStartedAtMs: number }>;
  };
  runComparison: {
    current: { runId: string; engineVersion: string; lastTickDurationMs: number | null } | null;
    previous: { runId: string; engineVersion: string; lastTickDurationMs: number | null } | null;
  };
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
    sizingQuoteConcurrency: number | null;
    candidateMaxQueueMs: number | null;
    valuationFetches: number;
  };
}

const tableNames = ['launches','market_snapshots','route_screens','executable_quotes','opportunity_lifecycle','rpc_latency_samples','radar_runtime','radar_runs'] as const;
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


function recentRunRows(db: DatabaseSync, limit = 8): Array<{ runId:string; engineVersion:string; runStartedAtMs:number }> {
  if (!hasTable(db,'radar_runs')) return [];
  const rows=db.prepare(`SELECT payload FROM radar_runs ORDER BY timestamp_ms DESC,id DESC LIMIT ?`).all(limit) as unknown as Array<{payload:string}>;
  return rows.flatMap(row=>{
    const payload=parsePayload(row.payload);
    const runId=typeof payload?.runId==='string'?payload.runId:null;
    const engineVersion=typeof payload?.engineVersion==='string'?payload.engineVersion:null;
    const runStartedAtMs=num(payload?.runStartedAtMs);
    return runId&&engineVersion&&runStartedAtMs!==null?[{runId,engineVersion,runStartedAtMs}]:[];
  });
}

function runIdOf(payload: Record<string,unknown> | null): string | null {
  return typeof payload?.runId === 'string' ? payload.runId : null;
}

function rowsSinceForRun(db: DatabaseSync, table: TableName, sinceMs: number, runId: string | null, limit = ANALYSIS_ROW_CAP): ObservationRow[] {
  if (!hasTable(db, table)) return [];
  const safeLimit=Math.min(ANALYSIS_ROW_CAP,Math.max(1,Math.floor(limit)));
  if (runId === null) return rowsSince(db,table,sinceMs,safeLimit);
  return db.prepare(`SELECT id,timestamp_ms,block_number,source,observation_key,payload
    FROM ${table}
    WHERE timestamp_ms >= ? AND json_valid(payload)=1 AND json_extract(payload,'$.runId') = ?
    ORDER BY timestamp_ms DESC,id DESC LIMIT ?`)
    .all(sinceMs,runId,safeLimit) as unknown as ObservationRow[];
}

function exactFunnelCounts(db: DatabaseSync, fromMs:number, toMs:number, runId:string|null) {
  if (!hasTable(db,'route_screens') || !hasTable(db,'executable_quotes')) {
    return {qualifyingScreens:0,quoteBackedCandidates:0,positiveExecutableQuotes:0,unavailableQuotes:0};
  }
  const runScreen = runId===null ? '' : " AND json_extract(payload,'$.runId') = ?";
  const runQuote = runId===null ? '' : " AND json_extract(payload,'$.runId') = ?";
  const screenArgs = runId===null ? [fromMs,toMs] : [fromMs,toMs,runId];
  const quoteArgs = runId===null ? [fromMs,toMs] : [fromMs,toMs,runId];

  const qualifying=(db.prepare(`SELECT COUNT(DISTINCT observation_key) AS count
    FROM route_screens
    WHERE timestamp_ms BETWEEN ? AND ? AND json_valid(payload)=1
      AND json_extract(payload,'$.screen.passesFeeFloor') = 1${runScreen}`).get(...screenArgs) as {count?:number}|undefined)?.count ?? 0;

  const backed=(db.prepare(`SELECT COUNT(DISTINCT observation_key) AS count
    FROM executable_quotes
    WHERE json_valid(payload)=1
      AND COALESCE(CAST(json_extract(payload,'$.discoveredAtMs') AS REAL), timestamp_ms) BETWEEN ? AND ?
      AND json_type(payload,'$.netProfitUsd') IN ('integer','real')${runQuote}`).get(...quoteArgs) as {count?:number}|undefined)?.count ?? 0;

  const positive=(db.prepare(`SELECT COUNT(DISTINCT observation_key) AS count
    FROM executable_quotes
    WHERE json_valid(payload)=1
      AND COALESCE(CAST(json_extract(payload,'$.discoveredAtMs') AS REAL), timestamp_ms) BETWEEN ? AND ?
      AND json_type(payload,'$.netProfitUsd') IN ('integer','real')
      AND CAST(json_extract(payload,'$.netProfitUsd') AS REAL) > 0${runQuote}`).get(...quoteArgs) as {count?:number}|undefined)?.count ?? 0;

  const unavailable=(db.prepare(`SELECT COUNT(DISTINCT observation_key) AS count
    FROM executable_quotes
    WHERE json_valid(payload)=1
      AND COALESCE(CAST(json_extract(payload,'$.discoveredAtMs') AS REAL), timestamp_ms) BETWEEN ? AND ?
      AND json_extract(payload,'$.status') = 'unavailable'${runQuote}`).get(...quoteArgs) as {count?:number}|undefined)?.count ?? 0;

  return {
    qualifyingScreens:Number(qualifying),
    quoteBackedCandidates:Number(backed),
    positiveExecutableQuotes:Number(positive),
    unavailableQuotes:Number(unavailable),
  };
}

function lastTickForRun(db: DatabaseSync, runId:string): number | null {
  if (!hasTable(db,'radar_runtime')) return null;
  const row=db.prepare(`SELECT payload FROM radar_runtime
    WHERE json_valid(payload)=1 AND json_extract(payload,'$.runId')=?
    ORDER BY timestamp_ms DESC,id DESC LIMIT 1`).get(runId) as {payload?:string}|undefined;
  const payload=row?.payload?parsePayload(row.payload):null;
  return num(payload?.durationMs);
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

function discoveryMs(payload: Record<string,unknown>, row: ObservationRow): number {
  const direct=num(payload.discoveredAtMs);
  if (direct !== null) return direct;
  const timing=payload.measurementTiming as Record<string,unknown> | undefined;
  const timingDiscovery=num(timing?.discoveredAtMs);
  if (timingDiscovery !== null) return timingDiscovery;
  const sampleDiscovery=num(payload.discoveredAtMs);
  if (sampleDiscovery !== null) return sampleDiscovery;
  const lastSegment=row.observation_key.split(':').at(-1);
  const fromKey=lastSegment === undefined ? NaN : Number(lastSegment);
  return Number.isFinite(fromKey) ? fromKey : row.timestamp_ms;
}

function discoveredInsideWindow(payload: Record<string,unknown>, row: ObservationRow, fromMs: number, toMs: number): boolean {
  const discovered=discoveryMs(payload,row);
  return discovered >= fromMs && discovered <= toMs;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function latencySummary(values: number[]): { medianMs: number | null; p95Ms: number | null; samples: number } {
  const finite = values.filter(Number.isFinite);
  return { medianMs: percentile(finite,0.5), p95Ms: percentile(finite,0.95), samples: finite.length };
}

function dominantLatency(summaries: Record<string,{ medianMs:number|null }>): { key:string; medianMs:number } | null {
  let best: { key:string; medianMs:number } | null = null;
  for (const [key,summary] of Object.entries(summaries)) {
    if (typeof summary.medianMs !== 'number' || !Number.isFinite(summary.medianMs)) continue;
    if (!best || summary.medianMs > best.medianMs) best={key,medianMs:summary.medianMs};
  }
  return best;
}

function quoteBreakdownFromPayload(payload: Record<string,unknown>, quote: Record<string,unknown> | undefined): QuoteCostBreakdown | null {
  const stored=payload.costBreakdown;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored as QuoteCostBreakdown;
  if (!quote) return null;
  try {
    return quoteCostBreakdown({
      inputUsd: Number(quote.inputUsd),
      outputUsd: Number(quote.outputUsd),
      gasUsd: Number(quote.gasUsd),
      extraCostsUsd: quote.extraCostsUsd === undefined ? 0 : Number(quote.extraCostsUsd),
      safetyMarginUsd: quote.safetyMarginUsd === undefined ? 0 : Number(quote.safetyMarginUsd),
    });
  } catch {
    return null;
  }
}

function quoteProfile(quote: Record<string,unknown> | undefined): Record<string,number> | null {
  const raw=quote?.profile;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const profile: Record<string,number>={};
  for (const [key,value] of Object.entries(raw as Record<string,unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) profile[key]=value;
  }
  return Object.keys(profile).length ? profile : null;
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

function summarizeOpportunities(rows: ObservationRow[], fromMs: number, toMs: number): {
  opportunities: OpportunitySummary[];
  paperPnl: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
  pnlTraces: {
    firstProbe: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
    bestObserved: Array<{ timestampMs: number; netProfitUsd: number; key: string }>;
  };
  latestPositiveOpportunity: OpportunitySummary | null;
} {
  type Mutable = OpportunitySummary & {
    _hasNumeric: boolean;
    _firstProbeId: number | null;
    _bestTimestampMs: number | null;
  };
  const groups = new Map<string, Mutable>();
  const paperPnl: Array<{ timestampMs: number; netProfitUsd: number; key: string }> = [];
  let latestPositiveRow: { row: ObservationRow; payload: Record<string,unknown> } | null = null;

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload || !discoveredInsideWindow(payload,row,fromMs,toMs)) continue;
    const fields = routeFields(payload);
    const quote = payload.quote as Record<string,unknown> | undefined;
    const netProfitUsd = num(payload.netProfitUsd);
    const breakdown = quoteBreakdownFromPayload(payload,quote);
    const profile = quoteProfile(quote);
    const isUnavailable = payload.status === 'unavailable';
    const current = groups.get(row.observation_key);

    if (!current) {
      groups.set(row.observation_key, {
        key: row.observation_key,
        timestampMs: discoveryMs(payload,row),
        status: isUnavailable ? 'unavailable' : (netProfitUsd !== null && netProfitUsd > 0 ? 'positive' : 'nonpositive'),
        token: fields.token,
        buyMarket: fields.buyMarket,
        sellMarket: fields.sellMarket,
        grossSpreadPct: fields.grossSpreadPct,
        firstProbeTimestampMs: netProfitUsd === null ? null : row.timestamp_ms,
        firstProbeInputUsd: quote ? num(quote.inputUsd) : null,
        firstProbeNetProfitUsd: netProfitUsd,
        firstProbeCostBreakdown: breakdown,
        firstProbeProfile: profile,
        latestInputUsd: quote ? num(quote.inputUsd) : null,
        latestNetProfitUsd: netProfitUsd,
        latestCostBreakdown: breakdown,
        latestProfile: profile,
        bestObservedInputUsd: quote ? num(quote.inputUsd) : null,
        bestObservedNetProfitUsd: netProfitUsd,
        bestObservedCostBreakdown: breakdown,
        bestObservedProfile: profile,
        quoteCount: netProfitUsd === null ? 0 : 1,
        blockNumber: quote?.blockNumber ?? row.block_number,
        source: row.source,
        reason: isUnavailable ? String(payload.reason ?? 'unavailable') : null,
        _hasNumeric: netProfitUsd !== null,
        _firstProbeId: netProfitUsd === null ? null : row.id,
        _bestTimestampMs: netProfitUsd === null ? null : row.timestamp_ms,
      });
    } else {
      if ((current.token === null || current.token === undefined) && fields.token !== null) current.token = fields.token;
      if ((current.buyMarket === null || current.buyMarket === undefined) && fields.buyMarket !== null) current.buyMarket = fields.buyMarket;
      if ((current.sellMarket === null || current.sellMarket === undefined) && fields.sellMarket !== null) current.sellMarket = fields.sellMarket;
      if (current.grossSpreadPct === null && fields.grossSpreadPct !== null) current.grossSpreadPct = fields.grossSpreadPct;

      // rows arrive newest-first, so the first numeric row retained above is the latest.
      if (netProfitUsd !== null) {
        current.quoteCount++;
        current._hasNumeric = true;
        const earlierThanFirst = current.firstProbeTimestampMs === null ||
          row.timestamp_ms < current.firstProbeTimestampMs ||
          (row.timestamp_ms === current.firstProbeTimestampMs && (current._firstProbeId === null || row.id < current._firstProbeId));
        if (earlierThanFirst) {
          current.firstProbeTimestampMs = row.timestamp_ms;
          current.firstProbeInputUsd = quote ? num(quote.inputUsd) : null;
          current.firstProbeNetProfitUsd = netProfitUsd;
          current.firstProbeCostBreakdown = breakdown;
          current.firstProbeProfile = profile;
          current._firstProbeId = row.id;
        }
        if (current.bestObservedNetProfitUsd === null || netProfitUsd > current.bestObservedNetProfitUsd) {
          current.bestObservedNetProfitUsd = netProfitUsd;
          current.bestObservedInputUsd = quote ? num(quote.inputUsd) : null;
          current.bestObservedCostBreakdown = breakdown;
          current.bestObservedProfile = profile;
          current._bestTimestampMs = row.timestamp_ms;
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

  const allMutable=[...groups.values()];
  const opportunities = allMutable
    .map(({ _hasNumeric, _firstProbeId, _bestTimestampMs, ...item }) => {
      if (_hasNumeric) item.status = (item.bestObservedNetProfitUsd ?? 0) > 0 ? 'positive' : 'nonpositive';
      return item;
    })
    .sort((a,b)=>b.timestampMs-a.timestampMs);

  const firstProbe = allMutable
    .filter(x=>x.firstProbeTimestampMs !== null && x.firstProbeNetProfitUsd !== null)
    .map(x=>({timestampMs:x.firstProbeTimestampMs!,netProfitUsd:x.firstProbeNetProfitUsd!,key:x.key}))
    .sort((a,b)=>a.timestampMs-b.timestampMs)
    .slice(-120);
  const bestObserved = allMutable
    .filter(x=>x.firstProbeTimestampMs !== null && x.bestObservedNetProfitUsd !== null)
    .map(x=>({timestampMs:x.firstProbeTimestampMs!,netProfitUsd:x.bestObservedNetProfitUsd!,key:x.key}))
    .sort((a,b)=>a.timestampMs-b.timestampMs)
    .slice(-120);

  let latestPositiveOpportunity: OpportunitySummary | null = null;
  if (latestPositiveRow) {
    const { row, payload } = latestPositiveRow;
    const quote = payload.quote as Record<string,unknown> | undefined;
    const fields = routeFields(payload);
    const netProfitUsd = num(payload.netProfitUsd);
    const breakdown=quoteBreakdownFromPayload(payload,quote);
    const profile=quoteProfile(quote);
    latestPositiveOpportunity = {
      key: row.observation_key,
      timestampMs: row.timestamp_ms,
      status: 'positive',
      token: fields.token,
      buyMarket: fields.buyMarket,
      sellMarket: fields.sellMarket,
      grossSpreadPct: fields.grossSpreadPct,
      firstProbeTimestampMs: row.timestamp_ms,
      firstProbeInputUsd: quote ? num(quote.inputUsd) : null,
      firstProbeNetProfitUsd: netProfitUsd,
      firstProbeCostBreakdown: breakdown,
      firstProbeProfile: profile,
      latestInputUsd: quote ? num(quote.inputUsd) : null,
      latestNetProfitUsd: netProfitUsd,
      latestCostBreakdown: breakdown,
      latestProfile: profile,
      bestObservedInputUsd: quote ? num(quote.inputUsd) : null,
      bestObservedNetProfitUsd: netProfitUsd,
      bestObservedCostBreakdown: breakdown,
      bestObservedProfile: profile,
      quoteCount: 1,
      blockNumber: quote?.blockNumber ?? row.block_number,
      source: row.source,
      reason: null,
    };
  }

  return {
    opportunities,
    paperPnl: paperPnl.sort((a,b)=>a.timestampMs-b.timestampMs).slice(-120),
    pnlTraces:{firstProbe,bestObserved},
    latestPositiveOpportunity,
  };
}

export function buildDashboardSnapshot(
  path = 'data/radar.sqlite',
  limit = 100,
  nowMs = Date.now(),
  recentWindowMs = DEFAULT_WINDOW_MS,
  runSelector: string = 'current',
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
    run:{mode:'all' as const,selectedRunId:null,currentRunId:null,engineVersion:null,recentRuns:[]},
    runComparison:{current:null,previous:null},
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
    pnlTraces:{firstProbe:[],bestObserved:[]},
    pipeline:{
      phases:{},
      dominantPhase:null,
      simulation:{},
      dominantSimulationStep:null,
    },
    runtime: { lastTickAtMs:null,tickDurationMs:null,queued:0,droppedStale:0,probesStarted:0,probesCompleted:0,sizingStarted:0,sizingCompleted:0,maxActiveProbes:0,maxActiveSizing:0,probeConcurrency:null,sizingConcurrency:null,sizingQuoteConcurrency:null,candidateMaxQueueMs:null,valuationFetches:0 },
  };

  if (!existsSync(path)) return emptyBase;

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const recentRuns=recentRunRows(db);
    const currentRun=recentRuns[0] ?? null;
    const mode: 'current'|'specific'|'all' = runSelector==='all' ? 'all' : runSelector==='current' ? 'current' : 'specific';
    const selectedRunId = mode==='all' ? null : mode==='current' ? currentRun?.runId ?? null : runSelector;
    const selectedMeta = selectedRunId ? recentRuns.find(x=>x.runId===selectedRunId) ?? null : null;
    const previousRun = currentRun ? recentRuns.find(x=>x.runId!==currentRun.runId) ?? null : null;
    const recentCounts = {
      routeScreens: countSince(db,'route_screens',fromMs),
      executableQuotes: countSince(db,'executable_quotes',fromMs),
      lifecycleRows: countSince(db,'opportunity_lifecycle',fromMs),
      rpcSamples: countSince(db,'rpc_latency_samples',fromMs),
    };
    const screens = rowsSinceForRun(db,'route_screens',fromMs,selectedRunId);
    const quoteRows = rowsSinceForRun(db,'executable_quotes',fromMs,selectedRunId);
    const lifecycle = rowsSinceForRun(db,'opportunity_lifecycle',fromMs,selectedRunId);
    const rpc = rowsSinceForRun(db,'rpc_latency_samples',fromMs,selectedRunId);
    const runtimeRows = rowsSinceForRun(db,'radar_runtime',fromMs,selectedRunId,20);
    let runtime: DashboardSnapshot['runtime'] = emptyBase.runtime;
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
        sizingQuoteConcurrency: num(payload.sizingQuoteConcurrency),
        candidateMaxQueueMs: num(payload.candidateMaxQueueMs),
        valuationFetches: num(payload.valuationFetches) ?? 0,
      };
      break;
    }

    const funnel=exactFunnelCounts(db,fromMs,generatedAtMs,selectedRunId);
    const qualifyingScreens=funnel.qualifyingScreens;

    const tokens = new Set<string>();
    for (const row of screens) {
      const payload=parsePayload(row.payload);
      const route=payload?.route as Record<string,unknown> | undefined;
      if (typeof route?.token === 'string') tokens.add(route.token.toLowerCase());
    }

    const { opportunities: allOpportunities, paperPnl, pnlTraces, latestPositiveOpportunity } = summarizeOpportunities(quoteRows,fromMs,generatedAtMs);
    for (const item of allOpportunities) if (typeof item.token === 'string') tokens.add(item.token.toLowerCase());

    const quoteBackedCandidates = selectedRunId === null
      ? allOpportunities.filter(x=>x.quoteCount>0).length
      : funnel.quoteBackedCandidates;
    const positiveExecutableQuotes = selectedRunId === null
      ? allOpportunities.filter(x=>x.status==='positive'&&x.quoteCount>0).length
      : funnel.positiveExecutableQuotes;
    const nonpositiveExecutableQuotes = Math.max(0,quoteBackedCandidates-positiveExecutableQuotes);
    const unavailableQuotes = selectedRunId === null
      ? allOpportunities.filter(x=>x.status==='unavailable').length
      : funnel.unavailableQuotes;

    const timings: Array<Record<string,unknown>> = [];
    const queueDelays: number[] = [];
    const preparationDurations: number[] = [];
    const discoveryToFirstQuoteDurations: number[] = [];
    const firstQuoteDurations: number[] = [];
    const sizingBarrierWaits: number[] = [];
    const sizingQueueWaits: number[] = [];
    const sizingDurations: number[] = [];
    const deadlineMisses: number[] = [];
    let lifecycleDeadlineSamples = 0;
    let missedLifecycleDeadlines = 0;
    const seenTimingKeys = new Set<string>();

    for (const row of lifecycle) {
      const payload=parsePayload(row.payload);
      if (!payload || !discoveredInsideWindow(payload,row,fromMs,generatedAtMs)) continue;
      const timing=payload.measurementTiming as Record<string,unknown> | undefined;
      if (timing && !seenTimingKeys.has(row.observation_key)) {
        seenTimingKeys.add(row.observation_key);
        const firstQuote=num(timing.discoveryToFirstQuoteCompletedMs);
        const sizing=num(timing.sizingDurationMs);
        const queueDelay=num(timing.queueDelayMs);
        const preparation=num(timing.preparationDurationMs);
        const firstQuoteDuration=num(timing.firstQuoteDurationMs);
        const sizingBarrierWait=num(timing.sizingBarrierWaitMs);
        const sizingQueueWait=num(timing.sizingQueueWaitMs);
        if (queueDelay !== null) queueDelays.push(queueDelay);
        if (preparation !== null) preparationDurations.push(preparation);
        if (firstQuote !== null) discoveryToFirstQuoteDurations.push(firstQuote);
        if (firstQuoteDuration !== null) firstQuoteDurations.push(firstQuoteDuration);
        if (sizingBarrierWait !== null) sizingBarrierWaits.push(sizingBarrierWait);
        if (sizingQueueWait !== null) sizingQueueWaits.push(sizingQueueWait);
        if (sizing !== null) sizingDurations.push(sizing);
        timings.push({
          key:row.observation_key,
          timestampMs:row.timestamp_ms,
          queueDelayMs:queueDelay,
          preparationDurationMs:preparation,
          discoveryToFirstQuoteStartedMs:num(timing.discoveryToFirstQuoteStartedMs),
          discoveryToFirstQuoteCompletedMs:firstQuote,
          firstQuoteDurationMs:firstQuoteDuration,
          sizingBarrierWaitMs:sizingBarrierWait,
          sizingQueueWaitMs:sizingQueueWait,
          sizingDurationMs:sizing,
          sizingTotalPhaseMs:num(timing.sizingTotalPhaseMs),
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

    const phaseSummaries = {
      queueDelay: latencySummary(queueDelays),
      preparation: latencySummary(preparationDurations),
      firstQuote: latencySummary(firstQuoteDurations),
      sizingBarrierWait: latencySummary(sizingBarrierWaits),
      sizingQueueWait: latencySummary(sizingQueueWaits),
      sizingExecution: latencySummary(sizingDurations),
    };

    const simulationValues: Record<string,number[]> = {
      blockRead:[],buySimulation:[],sellSimulation:[],buyGasEstimate:[],sellGasEstimate:[],gasPrice:[],blockConfirm:[],total:[]
    };
    for (const opportunity of allOpportunities) {
      const profile=opportunity.firstProbeProfile;
      if (!profile) continue;
      for (const [targetKey,sourceKey] of [
        ['blockRead','blockReadMs'],['buySimulation','buySimulationMs'],['sellSimulation','sellSimulationMs'],
        ['buyGasEstimate','buyGasEstimateMs'],['sellGasEstimate','sellGasEstimateMs'],['gasPrice','gasPriceMs'],
        ['blockConfirm','blockConfirmMs'],['total','totalMs']
      ] as const) {
        const value=profile[sourceKey];
        if (typeof value === 'number' && Number.isFinite(value)) simulationValues[targetKey].push(value);
      }
    }
    const simulationSummaries: Record<string,{medianMs:number|null;p95Ms:number|null;samples:number}>={};
    for (const [key,values] of Object.entries(simulationValues)) simulationSummaries[key]=latencySummary(values);

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
      run:{
        mode,
        selectedRunId,
        currentRunId:currentRun?.runId ?? null,
        engineVersion:selectedMeta?.engineVersion ?? (mode==='current'?currentRun?.engineVersion ?? null:null),
        recentRuns,
      },
      runComparison:{
        current:currentRun?{runId:currentRun.runId,engineVersion:currentRun.engineVersion,lastTickDurationMs:lastTickForRun(db,currentRun.runId)}:null,
        previous:previousRun?{runId:previousRun.runId,engineVersion:previousRun.engineVersion,lastTickDurationMs:lastTickForRun(db,previousRun.runId)}:null,
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
        medianFirstQuoteMs:percentile(discoveryToFirstQuoteDurations,0.5),
        p95FirstQuoteMs:percentile(discoveryToFirstQuoteDurations,0.95),
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
      pnlTraces,
      pipeline:{
        phases:phaseSummaries,
        dominantPhase:dominantLatency(phaseSummaries),
        simulation:simulationSummaries,
        dominantSimulationStep:dominantLatency(Object.fromEntries(Object.entries(simulationSummaries).filter(([key])=>key!=='total'))),
      },
      runtime,
    };
  } finally {
    db.close();
  }
}
