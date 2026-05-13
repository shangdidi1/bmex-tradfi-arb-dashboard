import { Router, type IRouter } from "express";
import { db, pairSnapshots, tradingPairs } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type PairDetail = { summary: PairSummary; timeSeries: TimeSeriesPoint[] };
type PairConfig = { name: string; bitmex: string; hl: string };

const DAYS_LOOKBACK = 30;
const BITMEX_INTERVALS_PER_DAY = 3;

// Default pair set seeded into the trading_pairs table on first server start
// if the table is empty. After seeding, this list is no longer authoritative —
// the table is. Users can add/remove via POST/DELETE /api/arb/pairs.
const DEFAULT_PAIRS: Record<string, PairConfig> = {
  "1": { name: "WTI Crude Oil", bitmex: "WTIUSDT", hl: "xyz:CL" },
  "2": { name: "Brent Crude Oil", bitmex: "BRENTUSDT", hl: "xyz:BRENTOIL" },
  "3": { name: "CRCL (Circle)", bitmex: "CRCLUSDT", hl: "xyz:CRCL" },
  "4": { name: "Silver", bitmex: "XAGUSDT", hl: "xyz:SILVER" },
  "5": { name: "Gold", bitmex: "XAUTUSDT", hl: "xyz:GOLD" },
  "6": { name: "S&P 500 (SPY)", bitmex: "SPYUSDT", hl: "xyz:SP500" },
  "7": { name: "Nasdaq 100 (QQQ)", bitmex: "QQQUSDT", hl: "xyz:XYZ100" },
  "8": { name: "Coinbase (COIN)", bitmex: "COINUSDT", hl: "xyz:COIN" },
  "9": { name: "Robinhood (HOOD)", bitmex: "HOODUSDT", hl: "xyz:HOOD" },
  "10": { name: "Tesla", bitmex: "TSLAUSDT", hl: "xyz:TSLA" },
  "11": { name: "NVIDIA", bitmex: "NVDAUSDT", hl: "xyz:NVDA" },
  "12": { name: "Meta", bitmex: "METAUSDT", hl: "xyz:META" },
  "13": { name: "Apple", bitmex: "AAPLUSDT", hl: "xyz:AAPL" },
  "14": { name: "Amazon", bitmex: "AMZNUSDT", hl: "xyz:AMZN" },
  "15": { name: "Microsoft", bitmex: "MSFTUSDT", hl: "xyz:MSFT" },
  "16": { name: "Google", bitmex: "GOOGLUSDT", hl: "xyz:GOOGL" },
  "17": { name: "Palantir", bitmex: "PLTRUSDT", hl: "xyz:PLTR" },
  "18": { name: "Intel", bitmex: "INTCUSDT", hl: "xyz:INTC" },
  "19": { name: "Oracle", bitmex: "ORCLUSDT", hl: "xyz:ORCL" },
  "20": { name: "MicroStrategy", bitmex: "MSTRUSDT", hl: "xyz:MSTR" },
  "21": { name: "Netflix", bitmex: "NFLXUSDT", hl: "xyz:NFLX" },
  "22": { name: "EUR/USD", bitmex: "EURUSD", hl: "xyz:EUR" },
};

// Dynamic pair list, loaded from trading_pairs on first access and invalidated
// on every mutation. Used instead of a hardcoded dict across all endpoints.
let pairsCache: Record<string, PairConfig> | null = null;
async function loadPairs(): Promise<Record<string, PairConfig>> {
  if (pairsCache) return pairsCache;
  const rows = await db.select().from(tradingPairs);
  if (rows.length === 0) {
    // First run — seed defaults.
    logger.info({ count: Object.keys(DEFAULT_PAIRS).length }, "Seeding trading_pairs with defaults");
    await db.insert(tradingPairs).values(
      Object.entries(DEFAULT_PAIRS).map(([pairId, p]) => ({
        pairId,
        name: p.name,
        bitmexSymbol: p.bitmex,
        hlSymbol: p.hl,
      })),
    );
    pairsCache = { ...DEFAULT_PAIRS };
    return pairsCache;
  }
  pairsCache = {};
  for (const row of rows) {
    pairsCache[row.pairId] = { name: row.name, bitmex: row.bitmexSymbol, hl: row.hlSymbol };
  }
  return pairsCache;
}
function invalidatePairsCache() { pairsCache = null; }

interface TimeSeriesPoint {
  timestamp: string;
  bitmexAPR: number;
  hlAPR: number;
  fundingSpread: number;
  bitmexPrice: number;
  hlPrice: number;
  priceSpreadPct: number;
}

interface WindowMetrics {
  consistencyScore: number;
  cumulativeYield: number;
  annualizedYield: number;
}

interface PairSummary {
  pairId: string;
  name: string;
  bitmexSymbol: string;
  hlSymbol: string;
  bitmexCurrentAPR: number;
  hlCurrentAPR: number;
  fundingSpread: number;
  priceSpreadPct: number;
  bitmexOpenInterestUsdt: number;
  // 14-day (legacy, kept for detail view)
  consistencyScore: number;
  cumulativeYield: number;
  // Multi-window metrics
  consistency7d: number;
  consistency14d: number;
  consistency30d: number;
  annYield7d: number;
  annYield14d: number;
  annYield30d: number;
  suggestion: "LONG_BITMEX_SHORT_HL" | "LONG_HL_SHORT_BITMEX" | "NEUTRAL";
  lastUpdated: string;
  // Execution economics — orderbook-based, relevant for real-time actionability
  bmexBid: number | null;
  bmexAsk: number | null;
  hlBid: number | null;
  hlAsk: number | null;
  bmexBidSize: number | null;
  bmexAskSize: number | null;
  hlBidSize: number | null;
  hlAskSize: number | null;
  bmexBids: BookLevel[] | null;
  bmexAsks: BookLevel[] | null;
  hlBids: BookLevel[] | null;
  hlAsks: BookLevel[] | null;
  crossingCostPct: number | null;
  feeCostPct: number;
  priceBasisPct: number | null;
  favorableBasisPct: number | null;
  totalCostPct: number | null;
  netAPR1d: number | null;
  netAPR7d: number | null;
  netAPR30d: number | null;
  breakevenHours: number | null;
}

// Taker fees (percent of notional, per trade). Env-overridable.
// Round-trip = 2 × (BMEX + HL) = 4 taker crossings total.
const BMEX_TAKER_FEE_PCT = parseFloat(process.env["BMEX_TAKER_FEE_PCT"] ?? "0.05");
const HL_TAKER_FEE_PCT = parseFloat(process.env["HL_TAKER_FEE_PCT"] ?? "0.008");
const FEE_COST_ROUNDTRIP_PCT = 2 * (BMEX_TAKER_FEE_PCT + HL_TAKER_FEE_PCT);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Shared Hyperliquid rate limiter. HL's /info endpoint uses weight-based per-IP
// limits (fundingHistory and candleSnapshot each cost 20 of a 1200/min budget →
// ~1 heavy req/sec sustained, with burst tolerance). We serialize all HL request
// starts through a single chain with a min interval, and retry 429s with
// exponential backoff (respecting Retry-After when present).
const HL_MIN_INTERVAL_MS = 250;
const HL_MAX_RETRIES = 4;
let hlLastStart = 0;
let hlGate: Promise<void> = Promise.resolve();

async function hlAcquire(): Promise<void> {
  const prev = hlGate;
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  hlGate = next;
  await prev;
  const now = Date.now();
  const wait = Math.max(0, HL_MIN_INTERVAL_MS - (now - hlLastStart));
  if (wait > 0) await sleep(wait);
  hlLastStart = Date.now();
  // Release the gate so the next caller can advance.
  release();
}

async function hlFetch(body: object): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await hlAcquire();
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= HL_MAX_RETRIES) return res;
    const retryAfterSec = parseInt(res.headers.get("retry-after") ?? "0", 10);
    const backoff = retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(8000, 500 * Math.pow(2, attempt));
    await sleep(backoff);
  }
}

async function fetchBitmexInstrument(symbol: string): Promise<{ openInterest?: number; openValueUsdt?: number; underlyingToPositionMultiplier?: number } | null> {
  try {
    const url = `https://www.bitmex.com/api/v1/instrument?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ symbol, status: res.status, statusText: res.statusText }, "BitMEX instrument returned non-OK status");
      return null;
    }
    const data = await res.json() as Array<{ openInterest?: number; openValue?: number; quoteToSettleMultiplier?: number; underlyingToPositionMultiplier?: number }>;
    const item = data[0];
    if (!item) return null;
    const multiplier = item.quoteToSettleMultiplier ?? 1_000_000;
    return {
      openInterest: item.openInterest,
      openValueUsdt: item.openValue ? item.openValue / multiplier : 0,
      underlyingToPositionMultiplier: item.underlyingToPositionMultiplier ?? 1,
    };
  } catch (err) {
    logger.warn({ symbol, err }, "BitMEX instrument request failed");
    return null;
  }
}

type BookLevel = { px: number; size: number };
type BookTop = { bid: number; ask: number; bidSize: number; askSize: number; bids: BookLevel[]; asks: BookLevel[] };

const ORDERBOOK_DEPTH = 5;

function normalizeBookSizes(book: BookTop | null, divisor: number): BookTop | null {
  if (!book || divisor === 1 || divisor <= 0) return book;
  return {
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize / divisor,
    askSize: book.askSize / divisor,
    bids: book.bids.map((l) => ({ px: l.px, size: l.size / divisor })),
    asks: book.asks.map((l) => ({ px: l.px, size: l.size / divisor })),
  };
}

async function fetchBitmexOrderbookTop(symbol: string, positionMultiplier = 1): Promise<BookTop | null> {
  try {
    const url = `https://www.bitmex.com/api/v1/orderBook/L2?symbol=${encodeURIComponent(symbol)}&depth=${ORDERBOOK_DEPTH}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ symbol, status: res.status }, "BitMEX orderbook returned non-OK status");
      return null;
    }
    const data = await res.json() as Array<{ side: "Buy" | "Sell"; price: number; size?: number }>;
    // BitMEX `size` is in CONTRACTS. Convert to base-coin units by dividing by
    // `underlyingToPositionMultiplier` (fetched per-instrument). e.g. BRENTUSDT
    // has multiplier=10, so 10 contracts = 1 barrel. Crypto perps often have
    // multiplier=1 (1 contract = 1 coin).
    const toBaseUnits = (contracts: number) => contracts / (positionMultiplier || 1);
    const bids: BookLevel[] = data
      .filter((d) => d.side === "Buy")
      .map((d) => ({ px: d.price, size: toBaseUnits(d.size ?? 0) }))
      .sort((a, b) => b.px - a.px);
    const asks: BookLevel[] = data
      .filter((d) => d.side === "Sell")
      .map((d) => ({ px: d.price, size: toBaseUnits(d.size ?? 0) }))
      .sort((a, b) => a.px - b.px);
    if (!bids[0] || !asks[0] || bids[0].px <= 0 || asks[0].px <= 0) return null;
    return {
      bid: bids[0].px,
      ask: asks[0].px,
      bidSize: bids[0].size,
      askSize: asks[0].size,
      bids,
      asks,
    };
  } catch (err) {
    logger.warn({ symbol, err }, "BitMEX orderbook request failed");
    return null;
  }
}

async function fetchHyperliquidOrderbookTop(coin: string): Promise<BookTop | null> {
  try {
    const res = await hlFetch({ type: "l2Book", coin });
    if (!res.ok) {
      logger.warn({ coin, status: res.status }, "Hyperliquid l2Book returned non-OK status");
      return null;
    }
    const data = await res.json() as { levels?: Array<Array<{ px: string; sz: string }>> };
    // levels[0] = bids (highest first), levels[1] = asks (lowest first). Take top N.
    const bids: BookLevel[] = (data.levels?.[0] ?? [])
      .slice(0, ORDERBOOK_DEPTH)
      .map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }));
    const asks: BookLevel[] = (data.levels?.[1] ?? [])
      .slice(0, ORDERBOOK_DEPTH)
      .map((l) => ({ px: parseFloat(l.px), size: parseFloat(l.sz) }));
    if (!bids[0] || !asks[0] || !(bids[0].px > 0 && asks[0].px > 0)) return null;
    return {
      bid: bids[0].px,
      ask: asks[0].px,
      bidSize: bids[0].size,
      askSize: asks[0].size,
      bids,
      asks,
    };
  } catch (err) {
    logger.warn({ coin, err }, "Hyperliquid l2Book request failed");
    return null;
  }
}

async function fetchBitmexFundingHistory(symbol: string): Promise<Array<{ ts: number; apr: number }>> {
  const result: Array<{ ts: number; apr: number }> = [];
  const endTime = Date.now();
  const startTime = endTime - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startTime).toISOString();
  let hadError = false;

  while (true) {
    try {
      const url = `https://www.bitmex.com/api/v1/funding?symbol=${encodeURIComponent(symbol)}&count=500&startTime=${encodeURIComponent(currentStart)}&reverse=false`;
      const res = await fetch(url);
      if (!res.ok) {
        hadError = true;
        logger.warn({ symbol, status: res.status, statusText: res.statusText }, "BitMEX funding returned non-OK status");
        break;
      }
      const history = await res.json() as Array<{ timestamp: string; fundingRate?: number }>;
      if (!history.length) break;

      for (const item of history) {
        const ts = new Date(item.timestamp).getTime();
        const rawRate = item.fundingRate ?? 0;
        const apr = rawRate * BITMEX_INTERVALS_PER_DAY * 365 * 100;
        result.push({ ts: Math.floor(ts / (5 * 60000)) * (5 * 60000), apr });
      }

      if (history.length < 500) break;
      const lastDt = new Date(history[history.length - 1].timestamp).getTime() + 1000;
      currentStart = new Date(lastDt).toISOString();
      await sleep(600);
    } catch (err) {
      hadError = true;
      logger.warn({ symbol, err }, "BitMEX funding request failed");
      break;
    }
  }
  if (hadError && result.length === 0) {
    logger.warn({ symbol }, "BitMEX funding returned no data due to errors");
  }
  return result;
}

async function fetchHyperliquidFundingHistory(coin: string): Promise<Array<{ ts: number; apr: number }>> {
  const result: Array<{ ts: number; apr: number }> = [];
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  const chunkMs = 3 * 24 * 60 * 60 * 1000;

  let cur = startTimeMs;
  let hadError = false;
  while (cur < endTimeMs) {
    const chunkEnd = Math.min(endTimeMs, cur + chunkMs);
    try {
      const res = await hlFetch({ type: "fundingHistory", coin, startTime: cur, endTime: chunkEnd });
      if (res.ok) {
        const data = await res.json() as Array<{ time: number; fundingRate: string }>;
        if (Array.isArray(data)) {
          for (const item of data) {
            const ts = Math.floor(item.time / (5 * 60000)) * (5 * 60000);
            const apr = parseFloat(item.fundingRate) * 24 * 365 * 100;
            result.push({ ts, apr });
          }
        }
      } else {
        hadError = true;
        logger.warn({ coin, status: res.status, statusText: res.statusText }, "Hyperliquid fundingHistory returned non-OK status");
      }
    } catch (err) {
      hadError = true;
      logger.warn({ coin, err }, "Hyperliquid fundingHistory request failed");
    }
    cur = chunkEnd;
  }
  if (hadError && result.length === 0) {
    logger.warn({ coin }, "Hyperliquid fundingHistory returned no data due to errors");
  }
  return result;
}

async function fetchBitmexPriceHistory(symbol: string): Promise<Array<{ ts: number; price: number }>> {
  const result: Array<{ ts: number; price: number }> = [];
  const endTime = Date.now();
  const startTime = endTime - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startTime).toISOString();
  let hadError = false;

  while (true) {
    try {
      const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=5m&symbol=${encodeURIComponent(symbol)}&count=500&startTime=${encodeURIComponent(currentStart)}&reverse=false&partial=false`;
      const res = await fetch(url);
      if (!res.ok) {
        hadError = true;
        logger.warn({ symbol, status: res.status, statusText: res.statusText }, "BitMEX price history returned non-OK status");
        break;
      }
      const history = await res.json() as Array<{ timestamp: string; close?: number }>;
      if (!history.length) break;

      for (const item of history) {
        const ts = new Date(item.timestamp).getTime();
        result.push({ ts: Math.floor(ts / (5 * 60000)) * (5 * 60000), price: item.close ?? 0 });
      }

      if (history.length < 500) break;
      const lastDt = new Date(history[history.length - 1].timestamp).getTime() + 1000;
      currentStart = new Date(lastDt).toISOString();
      await sleep(600);
    } catch (err) {
      hadError = true;
      logger.warn({ symbol, err }, "BitMEX price history request failed");
      break;
    }
  }
  if (hadError && result.length === 0) {
    logger.warn({ symbol }, "BitMEX price history returned no data due to errors");
  }
  return result;
}

async function fetchHyperliquidPriceHistory(coin: string): Promise<Array<{ ts: number; price: number }>> {
  const result: Array<{ ts: number; price: number }> = [];
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  const chunkMs = 3 * 24 * 60 * 60 * 1000;

  let cur = startTimeMs;
  let hadError = false;
  while (cur < endTimeMs) {
    const chunkEnd = Math.min(endTimeMs, cur + chunkMs);
    try {
      const res = await hlFetch({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: cur, endTime: chunkEnd } });
      if (res.ok) {
        const data = await res.json() as Array<{ t: number; c: string }>;
        if (Array.isArray(data)) {
          for (const c of data) {
            const ts = Math.floor(c.t / (5 * 60000)) * (5 * 60000);
            result.push({ ts, price: parseFloat(c.c) });
          }
        }
      } else {
        hadError = true;
        logger.warn({ coin, status: res.status, statusText: res.statusText }, "Hyperliquid candleSnapshot returned non-OK status");
      }
    } catch (err) {
      hadError = true;
      logger.warn({ coin, err }, "Hyperliquid candleSnapshot request failed");
    }
    cur = chunkEnd;
  }
  if (hadError && result.length === 0) {
    logger.warn({ coin }, "Hyperliquid candleSnapshot returned no data due to errors");
  }
  return result;
}

function dedup<T extends { ts: number }>(arr: T[]): T[] {
  const seen = new Set<number>();
  return arr.filter((item) => {
    if (seen.has(item.ts)) return false;
    seen.add(item.ts);
    return true;
  });
}

function buildTimeSeries(
  bmexFunding: Array<{ ts: number; apr: number }>,
  hlFunding: Array<{ ts: number; apr: number }>,
  bmexPrice: Array<{ ts: number; price: number }>,
  hlPrice: Array<{ ts: number; price: number }>,
): TimeSeriesPoint[] {
  const bmexFundingMap = new Map(dedup(bmexFunding).map((x) => [x.ts, x.apr]));
  const hlFundingMap = new Map(dedup(hlFunding).map((x) => [x.ts, x.apr]));
  const bmexPriceMap = new Map(dedup(bmexPrice).map((x) => [x.ts, x.price]));
  const hlPriceMap = new Map(dedup(hlPrice).map((x) => [x.ts, x.price]));

  // When HL price data is unavailable (e.g. TradFi xyz: perps), fall back to using
  // funding-rate timestamps so consistency & yield can still be computed from funding data.
  const hasHlPrice = hlPrice.length > 0;
  const hasBmexPrice = bmexPrice.length > 0;

  const allTs = new Set<number>();
  if (hasHlPrice && hasBmexPrice) {
    // Prefer price timestamps (most granular) when available on both sides
    bmexPrice.forEach((x) => allTs.add(x.ts));
    hlPrice.forEach((x) => allTs.add(x.ts));
  } else if (hasBmexPrice) {
    // BitMEX price only — use BitMEX 5m candle timestamps, HL price set to 0
    bmexPrice.forEach((x) => allTs.add(x.ts));
  } else {
    // No price data at all — fall back to funding timestamps
    bmexFunding.forEach((x) => allTs.add(x.ts));
    hlFunding.forEach((x) => allTs.add(x.ts));
  }

  const sortedTs = Array.from(allTs).sort((a, b) => a - b);

  const points: TimeSeriesPoint[] = [];
  let lastBmexFunding = 0;
  let lastHlFunding = 0;

  for (const ts of sortedTs) {
    if (bmexFundingMap.has(ts)) lastBmexFunding = bmexFundingMap.get(ts)!;
    if (hlFundingMap.has(ts)) lastHlFunding = hlFundingMap.get(ts)!;

    const bmexPx = bmexPriceMap.get(ts) ?? 0;
    const hlPx = hlPriceMap.get(ts) ?? 0;

    // Require at least one price OR that we're in funding-only mode
    if (hasHlPrice && hasBmexPrice && (!bmexPx || !hlPx)) continue;
    if (hasBmexPrice && !hasHlPrice && !bmexPx) continue;

    const spread = lastBmexFunding - lastHlFunding;
    const priceSpread = (bmexPx && hlPx) ? ((bmexPx - hlPx) / hlPx) * 100 : 0;

    points.push({
      timestamp: new Date(ts).toISOString(),
      bitmexAPR: parseFloat(lastBmexFunding.toFixed(4)),
      hlAPR: parseFloat(lastHlFunding.toFixed(4)),
      fundingSpread: parseFloat(spread.toFixed(4)),
      bitmexPrice: parseFloat(bmexPx.toFixed(6)),
      hlPrice: parseFloat(hlPx.toFixed(6)),
      priceSpreadPct: parseFloat(priceSpread.toFixed(4)),
    });
  }

  const maxPoints = 4000;
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, i) => i % step === 0);
}

function computeWindowMetrics(
  timeSeries: TimeSeriesPoint[],
  windowDays: number,
  direction: PairSummary["suggestion"],
): WindowMetrics {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const pts = timeSeries.filter((p) => new Date(p.timestamp).getTime() >= cutoff);
  const total = pts.length;

  // Consistency = % of time the *suggested* direction was actually paying.
  //   LONG_BITMEX_SHORT_HL pays when spread < 0 (BMEX cheaper)
  //   LONG_HL_SHORT_BITMEX pays when spread > 0 (HL cheaper)
  //   NEUTRAL: no direction, default to 50
  let consistencyScore = 50;
  if (total > 0 && direction !== "NEUTRAL") {
    const paying = pts.filter((p) =>
      direction === "LONG_BITMEX_SHORT_HL" ? p.fundingSpread < 0 : p.fundingSpread > 0,
    ).length;
    consistencyScore = parseFloat(((paying / total) * 100).toFixed(1));
  }

  // Arb yield: absolute (assumes you took the favorable direction each tick — historical reference).
  const cumYield = pts.reduce((sum, p) => sum + Math.abs(p.fundingSpread) / (365 * 24 * 12), 0);
  const annualizedYield = total > 0 ? parseFloat((cumYield * (365 / windowDays)).toFixed(4)) : 0;

  return {
    consistencyScore,
    cumulativeYield: parseFloat(cumYield.toFixed(4)),
    annualizedYield,
  };
}

function computeSummary(
  pairId: string,
  timeSeries: TimeSeriesPoint[],
  currentBmexAPR: number,
  currentHlAPR: number,
  name: string,
  bitmexSymbol: string,
  hlSymbol: string,
  bitmexOpenInterestUsdt: number,
  bmexBook: BookTop | null,
  hlBook: BookTop | null,
): PairSummary {
  const spread = currentBmexAPR - currentHlAPR;

  // Suggestion: the direction that's paying RIGHT NOW. Historical mean is context but
  // shouldn't override current reality — a trader who sees "LONG_HL" on a pair where
  // current funding makes that direction lose money is getting a stale signal. Consistency
  // metrics below show how reliable the current direction has been historically.
  let suggestion: PairSummary["suggestion"] = "NEUTRAL";
  if (Math.abs(spread) > 0.1) {
    suggestion = spread < 0 ? "LONG_BITMEX_SHORT_HL" : "LONG_HL_SHORT_BITMEX";
  }

  const w7 = computeWindowMetrics(timeSeries, 7, suggestion);
  const w14 = computeWindowMetrics(timeSeries, 14, suggestion);
  const w30 = computeWindowMetrics(timeSeries, 30, suggestion);

  const latestPoint = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : null;
  const priceSpreadPct = latestPoint?.priceSpreadPct ?? 0;

  // Execution economics — modeled as a funding-arb trader would P&L the round trip.
  //
  // Three P&L components over the hold:
  //   1) Funding accrual (gross APR × hold / 365) — the reason for the trade
  //   2) Bid-ask crossing on 4 legs (entry long, entry short, exit long, exit short)
  //   3) Price basis at entry vs exit
  //
  // (2) is always a cost. (3) is usually IN FAVOR of the trade: the current basis exists
  // because funding is mispriced, and when funding normalizes (the thesis), the basis
  // closes too. If we assume exit at zero basis, we capture the entry basis as profit.
  // This matches the user's "close with no spread or improved spread" assumption.
  //
  // Formulas (all as % of notional):
  //   crossingCostPct = sum of each venue's own-mid bid-ask spread — scale-agnostic, correct
  //                     even for ETF-vs-index pairs where mids differ 10-40x
  //   priceBasisPct   = (bmexMid − hlMid) / avgMid × 100, signed (positive = BMEX pricier)
  //   favorableBasisPct = basis aligned to trade direction:
  //       LONG_BITMEX_SHORT_HL  → wants BMEX cheap  → favorable = −priceBasisPct
  //       LONG_HL_SHORT_BITMEX  → wants BMEX pricey → favorable = +priceBasisPct
  //       NEUTRAL / unknown     → 0
  //   totalCostPct    = crossingCostPct + feeCostPct − favorableBasisPct
  //
  // For scale-mismatched pairs (SPY vs SP500, QQQ vs Nasdaq100) the raw basis has no
  // economic meaning — the two venues track different references that won't converge.
  // In those cases priceBasisPct and favorableBasisPct are nulled out and totalCostPct
  // reduces to crossing + fees (conservative).
  let crossingCostPct: number | null = null;
  let priceBasisPct: number | null = null;
  let favorableBasisPct: number | null = null;
  if (bmexBook && hlBook) {
    const bmexMid = (bmexBook.ask + bmexBook.bid) / 2;
    const hlMid = (hlBook.ask + hlBook.bid) / 2;
    if (bmexMid > 0 && hlMid > 0) {
      const bmexCrossPct = ((bmexBook.ask - bmexBook.bid) / bmexMid) * 100;
      const hlCrossPct = ((hlBook.ask - hlBook.bid) / hlMid) * 100;
      crossingCostPct = bmexCrossPct + hlCrossPct;

      const avgMid = (bmexMid + hlMid) / 2;
      const rawBasis = ((bmexMid - hlMid) / avgMid) * 100;
      // Scale-match heuristic: venues within 20% of each other → same asset → basis converges.
      const isScaleMatched = Math.abs(rawBasis) < 20;
      if (isScaleMatched) {
        priceBasisPct = rawBasis;
        if (suggestion === "LONG_BITMEX_SHORT_HL") {
          favorableBasisPct = -rawBasis;
        } else if (suggestion === "LONG_HL_SHORT_BITMEX") {
          favorableBasisPct = rawBasis;
        } else {
          favorableBasisPct = 0;
        }
      }
    }
  }
  const totalCostPct =
    crossingCostPct !== null
      ? crossingCostPct + FEE_COST_ROUNDTRIP_PCT - (favorableBasisPct ?? 0)
      : null;
  const grossAPR = Math.abs(spread);
  const netFor = (days: number) =>
    totalCostPct !== null ? parseFloat((grossAPR - (totalCostPct * 365) / days).toFixed(4)) : null;
  // Breakeven: hours of funding accrual needed to recover totalCost.
  // If totalCost ≤ 0 (entry basis covers everything), trade is already profitable at entry — return 0.
  const breakevenHours =
    totalCostPct === null
      ? null
      : totalCostPct <= 0
        ? 0
        : grossAPR > 0
          ? parseFloat(((totalCostPct * 365 * 24) / grossAPR).toFixed(2))
          : null;

  return {
    pairId,
    name,
    bitmexSymbol,
    hlSymbol,
    bitmexCurrentAPR: parseFloat(currentBmexAPR.toFixed(4)),
    hlCurrentAPR: parseFloat(currentHlAPR.toFixed(4)),
    fundingSpread: parseFloat(spread.toFixed(4)),
    priceSpreadPct: parseFloat(priceSpreadPct.toFixed(4)),
    bitmexOpenInterestUsdt,
    // 14-day legacy fields (kept for detail view)
    consistencyScore: w14.consistencyScore,
    cumulativeYield: w14.cumulativeYield,
    // Windowed metrics
    consistency7d: w7.consistencyScore,
    consistency14d: w14.consistencyScore,
    consistency30d: w30.consistencyScore,
    annYield7d: w7.annualizedYield,
    annYield14d: w14.annualizedYield,
    annYield30d: w30.annualizedYield,
    suggestion,
    lastUpdated: new Date().toISOString(),
    // Execution economics (real-time orderbook-derived)
    bmexBid: bmexBook?.bid ?? null,
    bmexAsk: bmexBook?.ask ?? null,
    hlBid: hlBook?.bid ?? null,
    hlAsk: hlBook?.ask ?? null,
    bmexBidSize: bmexBook?.bidSize ?? null,
    bmexAskSize: bmexBook?.askSize ?? null,
    hlBidSize: hlBook?.bidSize ?? null,
    hlAskSize: hlBook?.askSize ?? null,
    bmexBids: bmexBook?.bids ?? null,
    bmexAsks: bmexBook?.asks ?? null,
    hlBids: hlBook?.bids ?? null,
    hlAsks: hlBook?.asks ?? null,
    crossingCostPct: crossingCostPct !== null ? parseFloat(crossingCostPct.toFixed(4)) : null,
    feeCostPct: parseFloat(FEE_COST_ROUNDTRIP_PCT.toFixed(4)),
    priceBasisPct: priceBasisPct !== null ? parseFloat(priceBasisPct.toFixed(4)) : null,
    favorableBasisPct: favorableBasisPct !== null ? parseFloat(favorableBasisPct.toFixed(4)) : null,
    totalCostPct: totalCostPct !== null ? parseFloat(totalCostPct.toFixed(4)) : null,
    netAPR1d: netFor(1),
    netAPR7d: netFor(7),
    netAPR30d: netFor(30),
    breakevenHours,
  };
}

async function buildPairDetail(pairId: string): Promise<{ summary: PairSummary; timeSeries: TimeSeriesPoint[] }> {
  const pairs = await loadPairs();
  const pair = pairs[pairId];
  if (!pair) throw new Error("Pair not found");

  logger.info({ pairId, symbol: pair.bitmex }, "Fetching detail data for pair");

  const [bmexFunding, hlFunding, bmexPrice, hlPrice, bmexInstrument, bmexBookRaw, hlBook] = await Promise.all([
    fetchBitmexFundingHistory(pair.bitmex),
    fetchHyperliquidFundingHistory(pair.hl),
    fetchBitmexPriceHistory(pair.bitmex),
    fetchHyperliquidPriceHistory(pair.hl),
    fetchBitmexInstrument(pair.bitmex),
    fetchBitmexOrderbookTop(pair.bitmex),
    fetchHyperliquidOrderbookTop(pair.hl),
  ]);
  // BitMEX returns orderbook `size` in CONTRACTS. Convert to base units
  // (barrels, shares, etc.) using the instrument's underlyingToPositionMultiplier
  // so it matches HL's convention and `size × price` yields correct USD notional.
  const bmexBook = normalizeBookSizes(bmexBookRaw, bmexInstrument?.underlyingToPositionMultiplier ?? 1);

  const hlFundingMissing = hlFunding.length === 0;
  const hlPriceMissing = hlPrice.length === 0;
  if (hlFundingMissing || hlPriceMissing) {
    logger.warn(
      { pairId, hlFunding: hlFunding.length, hlPrice: hlPrice.length, hlSymbol: pair.hl },
      hlFundingMissing && hlPriceMissing ? "Hyperliquid data unavailable for pair" : "Partial Hyperliquid data for pair",
    );
  }

  logger.info(
    { pairId, bmexFunding: bmexFunding.length, hlFunding: hlFunding.length, bmexPrice: bmexPrice.length, hlPrice: hlPrice.length },
    "Data fetched",
  );

  let timeSeries = buildTimeSeries(bmexFunding, hlFunding, bmexPrice, hlPrice);

  // For ETF/Index pairs, normalize price spread by subtracting the mean structural difference
  // so the chart shows deviation rather than the persistent ETF premium/discount.
  if (pairId === "6" || pairId === "7") {
    const validSpreads = timeSeries.map((p) => p.priceSpreadPct).filter((v) => v !== 0);
    if (validSpreads.length > 0) {
      const meanSpread = validSpreads.reduce((a, b) => a + b, 0) / validSpreads.length;
      timeSeries = timeSeries.map((p) => ({
        ...p,
        priceSpreadPct: parseFloat((p.priceSpreadPct - meanSpread).toFixed(4)),
      }));
    }
  }

  const currentBmexAPR = bmexFunding.length > 0 ? bmexFunding[bmexFunding.length - 1].apr : 0;
  const currentHlAPR = hlFunding.length > 0 ? hlFunding[hlFunding.length - 1].apr : 0;

  const summary = computeSummary(pairId, timeSeries, currentBmexAPR, currentHlAPR, pair.name, pair.bitmex, pair.hl, bmexInstrument?.openValueUsdt ?? 0, bmexBook, hlBook);
  return { summary, timeSeries };
}

// GET /api/arb/refresh — runs the heavy fetch for all pairs and UPSERTs to DB.
// Called by Vercel Cron (auto-sends Bearer CRON_SECRET when env var is set).
// GET (not POST) because Vercel Cron only issues GET requests.
router.get("/arb/refresh", async (req, res): Promise<void> => {
  const expected = process.env["CRON_SECRET"];
  if (!expected) {
    logger.error("CRON_SECRET not configured; refusing refresh");
    res.status(500).json({ error: "CRON_SECRET not configured" });
    return;
  }
  const provided = req.header("authorization") ?? "";
  if (provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const startedAt = Date.now();
  const refreshed: string[] = [];
  const failed: string[] = [];
  const pairs = await loadPairs();
  const pairIds = Object.keys(pairs);
  const BATCH_SIZE = 3;

  for (let i = 0; i < pairIds.length; i += BATCH_SIZE) {
    const batch = pairIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((id) => buildPairDetail(id)));
    for (let j = 0; j < batch.length; j++) {
      const pairId = batch[j];
      const result = results[j];
      if (result.status === "fulfilled") {
        try {
          await db
            .insert(pairSnapshots)
            .values({ pairId, data: result.value, fetchedAt: new Date() })
            .onConflictDoUpdate({
              target: pairSnapshots.pairId,
              set: { data: result.value, fetchedAt: new Date() },
            });
          refreshed.push(pairId);
        } catch (err) {
          logger.error({ pairId, err }, "Failed to UPSERT pair snapshot");
          failed.push(pairId);
        }
      } else {
        logger.error({ pairId, reason: result.reason }, "Failed to build pair detail during refresh");
        failed.push(pairId);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info({ refreshed: refreshed.length, failed: failed.length, durationMs }, "Refresh complete");
  res.json({ refreshed, failed, durationMs });
});

// GET /api/arb/summary — reads latest snapshots from DB.
router.get("/arb/summary", async (_req, res): Promise<void> => {
  try {
    const rows = await db.select().from(pairSnapshots);
    if (rows.length === 0) {
      res.json({ pairs: [], cachedAt: null, status: "bootstrapping" });
      return;
    }

    const summaries = rows
      .map((r) => (r.data as PairDetail).summary)
      .sort((a, b) => parseInt(a.pairId) - parseInt(b.pairId));
    const oldest = rows.reduce((min, r) => (r.fetchedAt < min ? r.fetchedAt : min), rows[0].fetchedAt);

    res.json({ pairs: summaries, cachedAt: oldest.toISOString() });
  } catch (err) {
    logger.error({ err }, "Error reading arb summary from DB");
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// GET /api/arb/summary/live — fans out per-pair live fetches for all pairs and
// recomputes summaries using cached time-series (history is refreshed by cron, not here).
// This is what the "Refresh" button in the summary header should call — unlike /summary
// which just re-reads DB, this actually pulls fresh orderbooks + current funding.
// Global cooldown: 15s between calls server-wide to avoid hammering exchanges.
const SUMMARY_LIVE_COOLDOWN_MS = 15_000;
let summaryLiveLastCallAt = 0;

router.get("/arb/summary/live", async (_req, res): Promise<void> => {
  const now = Date.now();
  if (now - summaryLiveLastCallAt < SUMMARY_LIVE_COOLDOWN_MS) {
    const retryAfter = Math.ceil((SUMMARY_LIVE_COOLDOWN_MS - (now - summaryLiveLastCallAt)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limited — try again in ${retryAfter}s` });
    return;
  }
  summaryLiveLastCallAt = now;

  try {
    const rows = await db.select().from(pairSnapshots);
    if (rows.length === 0) {
      res.json({ pairs: [], cachedAt: null, status: "bootstrapping" });
      return;
    }

    // Build map of cached details (for time-series re-use).
    const cached = new Map<string, PairDetail>();
    for (const row of rows) cached.set(row.pairId, row.data as PairDetail);

    // Fan out fresh fetches for every pair in parallel. Each pair's block calls:
    //   BMEX orderbook + HL orderbook + BMEX latest funding + HL latest funding + BMEX instrument.
    // ~5 × N outbound calls; HL rate-limiter and BMEX's own capacity absorb them easily.
    const pairConfigs = await loadPairs();
    const results = await Promise.allSettled(Object.keys(pairConfigs).map(async (pairId) => {
      const pair = pairConfigs[pairId];
      const prior = cached.get(pairId);
      if (!prior) return null;

      const [bmexBookRaw, hlBook, bmexAPR, hlAPR, bmexInstrument] = await Promise.all([
        fetchBitmexOrderbookTop(pair.bitmex),
        fetchHyperliquidOrderbookTop(pair.hl),
        fetchBitmexLatestFundingAPR(pair.bitmex),
        fetchHyperliquidLatestFundingAPR(pair.hl),
        fetchBitmexInstrument(pair.bitmex),
      ]);
      const bmexBook = normalizeBookSizes(bmexBookRaw, bmexInstrument?.underlyingToPositionMultiplier ?? 1);

      const summary = computeSummary(
        pairId,
        prior.timeSeries,
        bmexAPR,
        hlAPR,
        pair.name,
        pair.bitmex,
        pair.hl,
        bmexInstrument?.openValueUsdt ?? prior.summary.bitmexOpenInterestUsdt,
        bmexBook,
        hlBook,
      );
      return summary;
    }));

    const pairs: PairSummary[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) pairs.push(r.value);
    }
    pairs.sort((a, b) => parseInt(a.pairId) - parseInt(b.pairId));

    res.json({ pairs, cachedAt: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, "Error computing live summary");
    res.status(500).json({ error: "Failed to fetch live summary" });
  }
});

// GET /api/arb/:pairId/live — lightweight on-demand refresh for one pair.
// Fetches fresh orderbooks + current funding (no 30-day history), bypassing the DB.
// Intended for the "Refresh this pair" button in the detail view.
// Rate-limited in-memory: 10s between calls per pair across all clients.
const LIVE_RATE_LIMIT_MS = 10_000;
const liveLastCallAt: Map<string, number> = new Map();

async function fetchBitmexLatestFundingAPR(symbol: string): Promise<number> {
  try {
    const url = `https://www.bitmex.com/api/v1/funding?symbol=${encodeURIComponent(symbol)}&count=1&reverse=true`;
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data = await res.json() as Array<{ fundingRate?: number }>;
    const rate = data[0]?.fundingRate ?? 0;
    return rate * BITMEX_INTERVALS_PER_DAY * 365 * 100;
  } catch {
    return 0;
  }
}

async function fetchHyperliquidLatestFundingAPR(coin: string): Promise<number> {
  try {
    const now = Date.now();
    const res = await hlFetch({ type: "fundingHistory", coin, startTime: now - 2 * 60 * 60 * 1000, endTime: now });
    if (!res.ok) return 0;
    const data = await res.json() as Array<{ fundingRate: string }>;
    if (!Array.isArray(data) || data.length === 0) return 0;
    const latest = parseFloat(data[data.length - 1].fundingRate);
    return latest * 24 * 365 * 100;
  } catch {
    return 0;
  }
}

router.get("/arb/:pairId/live", async (req, res): Promise<void> => {
  const { pairId } = req.params;
  const pairs = await loadPairs();
  const pair = pairs[pairId];
  if (!pair) {
    res.status(404).json({ error: "Pair not found" });
    return;
  }

  const now = Date.now();
  const last = liveLastCallAt.get(pairId) ?? 0;
  if (now - last < LIVE_RATE_LIMIT_MS) {
    const retryAfter = Math.ceil((LIVE_RATE_LIMIT_MS - (now - last)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limited — try again in ${retryAfter}s` });
    return;
  }
  liveLastCallAt.set(pairId, now);

  try {
    const [bmexBookRaw, hlBook, bmexAPR, hlAPR, bmexInstrument] = await Promise.all([
      fetchBitmexOrderbookTop(pair.bitmex),
      fetchHyperliquidOrderbookTop(pair.hl),
      fetchBitmexLatestFundingAPR(pair.bitmex),
      fetchHyperliquidLatestFundingAPR(pair.hl),
      fetchBitmexInstrument(pair.bitmex),
    ]);
    const bmexBook = normalizeBookSizes(bmexBookRaw, bmexInstrument?.underlyingToPositionMultiplier ?? 1);
    res.json({
      pairId,
      name: pair.name,
      bitmexSymbol: pair.bitmex,
      hlSymbol: pair.hl,
      bitmexCurrentAPR: parseFloat(bmexAPR.toFixed(4)),
      hlCurrentAPR: parseFloat(hlAPR.toFixed(4)),
      bmexBids: bmexBook?.bids ?? null,
      bmexAsks: bmexBook?.asks ?? null,
      hlBids: hlBook?.bids ?? null,
      hlAsks: hlBook?.asks ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ pairId, err }, "Error in live refresh");
    res.status(500).json({ error: "Live refresh failed" });
  }
});

// GET /api/arb/:pairId — reads one pair's detail from DB.
router.get("/arb/:pairId", async (req, res): Promise<void> => {
  const { pairId } = req.params;
  const pairs = await loadPairs();
  if (!pairs[pairId]) {
    res.status(404).json({ error: "Pair not found" });
    return;
  }

  try {
    const rows = await db.select().from(pairSnapshots).where(eq(pairSnapshots.pairId, pairId));
    if (rows.length === 0) {
      res.status(404).json({ error: "Pair not yet refreshed" });
      return;
    }
    res.json(rows[0].data);
  } catch (err) {
    logger.error({ err, pairId }, "Error reading pair detail from DB");
    res.status(500).json({ error: "Failed to fetch detail data" });
  }
});

// POST /api/arb/pairs — add a new trading pair dynamically.
// Body: { name, bitmexSymbol, hlSymbol }. Symbols are validated by attempting an
// orderbook fetch on each venue; if either fails, the pair is rejected.
// Returns 201 with the created pair. The initial 30-day history fetch runs
// asynchronously in the background; the pair appears in /summary in
// "bootstrapping" state until that completes (~30-90s) and fully populates
// on the next cron tick.
//
// Abuse guards (no auth by design):
//   - Global 30s cooldown between adds
//   - Max 100 pairs total
//   - Symbols must resolve to real orderbooks on both venues
const ADD_PAIR_COOLDOWN_MS = 30_000;
const MAX_PAIRS = 100;
let addPairLastAt = 0;

router.post("/arb/pairs", async (req, res): Promise<void> => {
  const now = Date.now();
  if (now - addPairLastAt < ADD_PAIR_COOLDOWN_MS) {
    const retryAfter = Math.ceil((ADD_PAIR_COOLDOWN_MS - (now - addPairLastAt)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Too many pair adds — try again in ${retryAfter}s` });
    return;
  }

  const body = req.body as { name?: unknown; bitmexSymbol?: unknown; hlSymbol?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const bitmexSymbol = typeof body.bitmexSymbol === "string" ? body.bitmexSymbol.trim() : "";
  const hlSymbol = typeof body.hlSymbol === "string" ? body.hlSymbol.trim() : "";
  if (!name || !bitmexSymbol || !hlSymbol) {
    res.status(400).json({ error: "name, bitmexSymbol, and hlSymbol are required strings" });
    return;
  }
  if (name.length > 80 || bitmexSymbol.length > 40 || hlSymbol.length > 40) {
    res.status(400).json({ error: "Fields too long" });
    return;
  }

  const pairs = await loadPairs();
  if (Object.keys(pairs).length >= MAX_PAIRS) {
    res.status(400).json({ error: `Pair cap reached (${MAX_PAIRS})` });
    return;
  }
  for (const existing of Object.values(pairs)) {
    if (existing.bitmex === bitmexSymbol && existing.hl === hlSymbol) {
      res.status(409).json({ error: "Pair with this BitMEX + HL symbol pair already exists" });
      return;
    }
  }

  // Validate symbols exist on both venues before committing to DB.
  const [bmexBook, hlBook] = await Promise.all([
    fetchBitmexOrderbookTop(bitmexSymbol),
    fetchHyperliquidOrderbookTop(hlSymbol),
  ]);
  if (!bmexBook) {
    res.status(400).json({ error: `BitMEX symbol "${bitmexSymbol}" not found or has no orderbook` });
    return;
  }
  if (!hlBook) {
    // If user likely entered a BitMEX-style or raw ticker, suggest the xyz: form.
    // Strip common suffixes (USDC, USDT, -USDC, -USDT), uppercase, prefix xyz:.
    let suggestion: string | null = null;
    if (!hlSymbol.startsWith("xyz:")) {
      const stripped = hlSymbol.toUpperCase().replace(/[-_]?(USDC|USDT|PERP|USD)$/, "");
      if (stripped && stripped !== hlSymbol.toUpperCase()) {
        suggestion = `xyz:${stripped}`;
      } else if (stripped) {
        suggestion = `xyz:${stripped}`;
      }
      // Probe the suggestion — only include it in the error if it actually resolves.
      if (suggestion) {
        const probe = await fetchHyperliquidOrderbookTop(suggestion);
        if (!probe) suggestion = null;
      }
    }
    const hint = suggestion
      ? ` — did you mean "${suggestion}"? (Hyperliquid TradFi perps use the xyz: prefix.)`
      : ` — Hyperliquid TradFi perps use the format xyz:TICKER (e.g. xyz:EWY).`;
    res.status(400).json({ error: `Hyperliquid symbol "${hlSymbol}" not found${hint}` });
    return;
  }

  // Assign next pairId as max-existing + 1 (numeric).
  const nextId = String(
    Object.keys(pairs).reduce((max, id) => {
      const n = parseInt(id, 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1,
  );

  addPairLastAt = now;
  try {
    await db.insert(tradingPairs).values({ pairId: nextId, name, bitmexSymbol, hlSymbol });
    invalidatePairsCache();
  } catch (err) {
    logger.error({ err, nextId }, "Failed to insert trading pair");
    res.status(500).json({ error: "Failed to create pair" });
    return;
  }

  // Fire-and-forget initial history fetch so the pair fills in within ~30-90s.
  void (async () => {
    try {
      const detail = await buildPairDetail(nextId);
      await db
        .insert(pairSnapshots)
        .values({ pairId: nextId, data: detail, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: pairSnapshots.pairId,
          set: { data: detail, fetchedAt: new Date() },
        });
      logger.info({ pairId: nextId, name }, "Background bootstrap complete for new pair");
    } catch (err) {
      logger.error({ err, pairId: nextId }, "Background bootstrap failed for new pair");
    }
  })();

  res.status(201).json({ pairId: nextId, name, bitmexSymbol, hlSymbol });
});

// DELETE /api/arb/pairs/:pairId — remove a pair.
// Deletes from both trading_pairs and any existing pair_snapshot row.
router.delete("/arb/pairs/:pairId", async (req, res): Promise<void> => {
  const { pairId } = req.params;
  const pairs = await loadPairs();
  if (!pairs[pairId]) {
    res.status(404).json({ error: "Pair not found" });
    return;
  }
  try {
    await db.delete(pairSnapshots).where(eq(pairSnapshots.pairId, pairId));
    await db.delete(tradingPairs).where(eq(tradingPairs.pairId, pairId));
    invalidatePairsCache();
    res.status(204).end();
  } catch (err) {
    logger.error({ err, pairId }, "Failed to delete pair");
    res.status(500).json({ error: "Failed to delete pair" });
  }
});

export default router;
