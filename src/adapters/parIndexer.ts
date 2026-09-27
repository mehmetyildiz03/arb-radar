import type { HexAddress, LaunchSnapshot, MarketSnapshot } from "../domain.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asAddress(value: unknown): HexAddress | undefined {
  const s = asString(value);
  return s && /^0x[0-9a-fA-F]{40}$/.test(s) ? (s.toLowerCase() as HexAddress) : undefined;
}

function normalizeMarket(raw: unknown, fallbackIndex: number): MarketSnapshot | null {
  const row = asObject(raw);
  if (!row) return null;

  const pairToken = asAddress(row.pairToken);
  if (!pairToken) return null;
  const rawPriceEth = asNumber(row.lastPriceEth ?? row.priceEth);
  const priceEth = rawPriceEth !== undefined && rawPriceEth > 0 ? rawPriceEth : undefined;

  const poolIdString = asString(row.poolId);
  const poolId = poolIdString && /^0x[0-9a-fA-F]{64}$/.test(poolIdString) ? (poolIdString.toLowerCase() as `0x${string}`) : undefined;
  const index = asNumber(row.index ?? row.market) ?? fallbackIndex;
  const marketFee = asNumber(row.poolFee);
  if (!Number.isInteger(index) || index < 0 || (marketFee !== undefined && (!Number.isInteger(marketFee) || marketFee < 0 || marketFee >= 1_000_000))) return null;

  return {
    stale: row.lastPriceEthStale === true,
    priceAtMs: asNumber(row.lastTradeAt) === undefined ? undefined : asNumber(row.lastTradeAt)! * 1000,
    poolFeeUnits: marketFee,
    index,
    pairToken,
    quoteSymbol: asString(row.quoteSymbol) ?? `MARKET_${fallbackIndex}`,
    quoteDecimals: asNumber(row.quoteDecimals),
    poolId,
    tokenPriceEth: priceEth,
    phantomQuoteRaw: asString(row.phantomQuote),
    quoteRaisedRaw: asString(row.quoteRaised),
    tokensOnCurveRaw: asString(row.tokensOnCurve),
    recentVolumeEth: asNumber(row.recentVolumeEth ?? row.totalVolumeEth),
  };
}

export function normalizeLaunch(raw: unknown): LaunchSnapshot | null {
  const row = asObject(raw);
  if (!row) return null;

  const token = asAddress(row.token);
  if (!token) return null;
  const fee = asNumber(row.poolFee);
  if (fee === undefined || !Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) return null;

  const rawMarkets = Array.isArray(row.markets) ? row.markets : [];
  const markets = rawMarkets
    .map((market, index) => normalizeMarket(market, index))
    .filter((market): market is MarketSnapshot => market !== null);

  const marketCount = asNumber(row.marketCount) ?? markets.length;
  const kindRaw = asString(row.kind);
  const kind = kindRaw === "multi" || marketCount > 1 ? "multi" : "single";

  return {
    token,
    symbol: asString(row.symbol) ?? token.slice(0, 8),
    name: asString(row.name),
    kind,
    poolFeeUnits: fee,
    creatorTaxBps: asNumber(row.creatorTaxBps),
    marketCount,
    markets,
    createdAt: asNumber(row.createdAt),
    lastTradeAt: asNumber(row.lastTradeAt),
  };
}

export class ParIndexerClient {
  constructor(
    private readonly baseUrl = "https://api.par.family",
    private readonly userAgent = "arb-radar/0.1",
  ) {}

  async latestLaunches(limit = 100): Promise<LaunchSnapshot[]> {
    const url = new URL("/launches", this.baseUrl);
    url.searchParams.set("orderBy", "lastTradeAt");
    url.searchParams.set("orderDirection", "desc");
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 500)));

    const response = await fetch(url, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Par indexer ${response.status}: ${response.statusText}`);

    const body: unknown = await response.json();
    const obj = asObject(body);
    const rows = Array.isArray(body)
      ? body
      : (obj && Array.isArray(obj.launches) ? obj.launches : []);

    return (rows as unknown[])
      .map(normalizeLaunch)
      .filter((launch): launch is LaunchSnapshot => launch !== null)
      .filter((launch) => launch.kind === "multi" && launch.markets.length >= 2);
  }
}
