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

  const pairToken = asAddress(row.pairToken) ?? "0x0000000000000000000000000000000000000000";
  const priceEth = asNumber(row.lastPriceEth ?? row.priceEth);
  if (!(priceEth && priceEth > 0)) return null;

  const poolIdString = asString(row.poolId);
  const poolId = poolIdString?.startsWith("0x") ? (poolIdString as `0x${string}`) : undefined;

  return {
    index: asNumber(row.index ?? row.market) ?? fallbackIndex,
    pairToken,
    quoteSymbol: asString(row.quoteSymbol) ?? `MARKET_${fallbackIndex}`,
    poolId,
    tokenPriceEth: priceEth,
    recentVolumeEth: asNumber(row.recentVolumeEth ?? row.totalVolumeEth),
  };
}

export function normalizeLaunch(raw: unknown): LaunchSnapshot | null {
  const row = asObject(raw);
  if (!row) return null;

  const token = asAddress(row.token);
  if (!token) return null;

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
    poolFeeUnits: asNumber(row.poolFee) ?? 10_000,
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
