import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DAYS_LOOKBACK = 14;
const BITMEX_INTERVALS_PER_DAY = 3;

const PAIRS: Record<string, { name: string; bitmex: string; hl: string }> = {
  "1": { name: "WTI Crude Oil", bitmex: "WTIUSDT", hl: "xyz:CL" },
  "2": { name: "Brent Crude Oil", bitmex: "BRENTUSDT", hl: "xyz:BRENTOIL" },
  "3": { name: "CRCL (Circle)", bitmex: "CRCLUSDT", hl: "CRCL" },
  "4": { name: "Silver", bitmex: "XAGUSDT", hl: "xyz:SILVER" },
  "5": { name: "Gold", bitmex: "XAUTUSDT", hl: "xyz:GOLD" },
  "6": { name: "S&P 500 (SPY)", bitmex: "SPYUSDT", hl: "xyz:SPY" },
  "7": { name: "Nasdaq 100 (QQQ)", bitmex: "QQQUSDT", hl: "xyz:QQQ" },
  "8": { name: "Coinbase (COIN)", bitmex: "COINUSDT", hl: "xyz:COIN" },
  "9": { name: "Robinhood (HOOD)", bitmex: "HOODUSDT", hl: "xyz:HOOD" },
};

interface TimeSeriesPoint {
  timestamp: string;
  bitmexAPR: number;
  hlAPR: number;
  fundingSpread: number;
  bitmexPrice: number;
  hlPrice: number;
  priceSpreadPct: number;
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
  consistencyScore: number;
  cumulativeYield: number;
  suggestion: "LONG_BITMEX_SHORT_HL" | "LONG_HL_SHORT_BITMEX" | "NEUTRAL";
  lastUpdated: string;
}

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const summaryCache: Map<string, CacheEntry<PairSummary>> = new Map();
const detailCache: Map<string, CacheEntry<{ summary: PairSummary; timeSeries: TimeSeriesPoint[] }>> = new Map();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchBitmexFundingHistory(symbol: string): Promise<Array<{ ts: number; apr: number }>> {
  const result: Array<{ ts: number; apr: number }> = [];
  const endTime = Date.now();
  const startTime = endTime - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startTime).toISOString();

  while (true) {
    try {
      const url = `https://www.bitmex.com/api/v1/funding?symbol=${encodeURIComponent(symbol)}&count=500&startTime=${encodeURIComponent(currentStart)}&reverse=false`;
      const res = await fetch(url);
      if (!res.ok) break;
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
    } catch {
      break;
    }
  }
  return result;
}

async function fetchHyperliquidFundingHistory(coin: string): Promise<Array<{ ts: number; apr: number }>> {
  const result: Array<{ ts: number; apr: number }> = [];
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  const chunkMs = 3 * 24 * 60 * 60 * 1000;

  let cur = startTimeMs;
  while (cur < endTimeMs) {
    const chunkEnd = Math.min(endTimeMs, cur + chunkMs);
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "fundingHistory", coin, startTime: cur, endTime: chunkEnd }),
      });
      if (res.ok) {
        const data = await res.json() as Array<{ time: number; fundingRate: string }>;
        if (Array.isArray(data)) {
          for (const item of data) {
            const ts = Math.floor(item.time / (5 * 60000)) * (5 * 60000);
            const apr = parseFloat(item.fundingRate) * 24 * 365 * 100;
            result.push({ ts, apr });
          }
        }
      }
    } catch {
      // ignore
    }
    cur = chunkEnd;
    await sleep(150);
  }
  return result;
}

async function fetchBitmexPriceHistory(symbol: string): Promise<Array<{ ts: number; price: number }>> {
  const result: Array<{ ts: number; price: number }> = [];
  const endTime = Date.now();
  const startTime = endTime - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startTime).toISOString();

  while (true) {
    try {
      const url = `https://www.bitmex.com/api/v1/trade/bucketed?binSize=5m&symbol=${encodeURIComponent(symbol)}&count=500&startTime=${encodeURIComponent(currentStart)}&reverse=false&partial=false`;
      const res = await fetch(url);
      if (!res.ok) break;
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
    } catch {
      break;
    }
  }
  return result;
}

async function fetchHyperliquidPriceHistory(coin: string): Promise<Array<{ ts: number; price: number }>> {
  const result: Array<{ ts: number; price: number }> = [];
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  const chunkMs = 3 * 24 * 60 * 60 * 1000;

  let cur = startTimeMs;
  while (cur < endTimeMs) {
    const chunkEnd = Math.min(endTimeMs, cur + chunkMs);
    try {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: cur, endTime: chunkEnd } }),
      });
      if (res.ok) {
        const data = await res.json() as Array<{ t: number; c: string }>;
        if (Array.isArray(data)) {
          for (const c of data) {
            const ts = Math.floor(c.t / (5 * 60000)) * (5 * 60000);
            result.push({ ts, price: parseFloat(c.c) });
          }
        }
      }
    } catch {
      // ignore
    }
    cur = chunkEnd;
    await sleep(150);
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
  // Create maps
  const bmexFundingMap = new Map(dedup(bmexFunding).map((x) => [x.ts, x.apr]));
  const hlFundingMap = new Map(dedup(hlFunding).map((x) => [x.ts, x.apr]));
  const bmexPriceMap = new Map(dedup(bmexPrice).map((x) => [x.ts, x.price]));
  const hlPriceMap = new Map(dedup(hlPrice).map((x) => [x.ts, x.price]));

  // Build unified time index from price data (most granular)
  const allTs = new Set<number>();
  bmexPrice.forEach((x) => allTs.add(x.ts));
  hlPrice.forEach((x) => allTs.add(x.ts));

  const sortedTs = Array.from(allTs).sort((a, b) => a - b);

  // Forward-fill funding rates (they change every 8h)
  const points: TimeSeriesPoint[] = [];
  let lastBmexFunding = 0;
  let lastHlFunding = 0;

  for (const ts of sortedTs) {
    if (bmexFundingMap.has(ts)) lastBmexFunding = bmexFundingMap.get(ts)!;
    if (hlFundingMap.has(ts)) lastHlFunding = hlFundingMap.get(ts)!;

    const bmexPx = bmexPriceMap.get(ts) ?? 0;
    const hlPx = hlPriceMap.get(ts) ?? 0;
    if (!bmexPx || !hlPx) continue;

    const spread = lastBmexFunding - lastHlFunding;
    const priceSpread = hlPx !== 0 ? ((bmexPx - hlPx) / hlPx) * 100 : 0;

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

  // Limit to ~4000 points to keep payload manageable (downsample)
  const maxPoints = 4000;
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, i) => i % step === 0);
}

function computeSummary(
  pairId: string,
  timeSeries: TimeSeriesPoint[],
  currentBmexAPR: number,
  currentHlAPR: number,
  name: string,
  bitmexSymbol: string,
  hlSymbol: string,
): PairSummary {
  const spread = currentBmexAPR - currentHlAPR;

  // Consistency score: % of 5-min periods where BitMEX APR < HL APR (BitMEX is cheaper to hold long)
  const totalPeriods = timeSeries.length;
  const bmexLowerPeriods = timeSeries.filter((p) => p.fundingSpread < 0).length;
  const consistencyScore = totalPeriods > 0 ? parseFloat(((bmexLowerPeriods / totalPeriods) * 100).toFixed(1)) : 50;

  // Cumulative yield: sum of per-period spread returns
  // Per period return = (spread_apr) / (365 * 24 * 12) for 5-minute periods
  const cumulativeYield = timeSeries.reduce((sum, p) => sum + p.fundingSpread / (365 * 24 * 12), 0);

  // Determine the dominant direction from history
  // If mean spread < 0 (BitMEX cheaper), suggest Long BitMEX / Short HL
  const meanSpread = totalPeriods > 0
    ? timeSeries.reduce((sum, p) => sum + p.fundingSpread, 0) / totalPeriods
    : spread;

  let suggestion: PairSummary["suggestion"] = "NEUTRAL";
  if (Math.abs(meanSpread) > 0.1) {
    suggestion = meanSpread < 0 ? "LONG_BITMEX_SHORT_HL" : "LONG_HL_SHORT_BITMEX";
  }

  // Latest price spread
  const latestPoint = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1] : null;
  const priceSpreadPct = latestPoint?.priceSpreadPct ?? 0;

  return {
    pairId,
    name,
    bitmexSymbol,
    hlSymbol,
    bitmexCurrentAPR: parseFloat(currentBmexAPR.toFixed(4)),
    hlCurrentAPR: parseFloat(currentHlAPR.toFixed(4)),
    fundingSpread: parseFloat(spread.toFixed(4)),
    priceSpreadPct: parseFloat(priceSpreadPct.toFixed(4)),
    consistencyScore,
    cumulativeYield: parseFloat(cumulativeYield.toFixed(4)),
    suggestion,
    lastUpdated: new Date().toISOString(),
  };
}

async function buildPairDetail(pairId: string): Promise<{ summary: PairSummary; timeSeries: TimeSeriesPoint[] }> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error("Pair not found");

  logger.info({ pairId, symbol: pair.bitmex }, "Fetching detail data for pair");

  const [bmexFunding, hlFunding, bmexPrice, hlPrice] = await Promise.all([
    fetchBitmexFundingHistory(pair.bitmex),
    fetchHyperliquidFundingHistory(pair.hl),
    fetchBitmexPriceHistory(pair.bitmex),
    fetchHyperliquidPriceHistory(pair.hl),
  ]);

  logger.info(
    { pairId, bmexFunding: bmexFunding.length, hlFunding: hlFunding.length, bmexPrice: bmexPrice.length, hlPrice: hlPrice.length },
    "Data fetched",
  );

  const timeSeries = buildTimeSeries(bmexFunding, hlFunding, bmexPrice, hlPrice);

  // Get current rates from last known funding entries
  const currentBmexAPR = bmexFunding.length > 0 ? bmexFunding[bmexFunding.length - 1].apr : 0;
  const currentHlAPR = hlFunding.length > 0 ? hlFunding[hlFunding.length - 1].apr : 0;

  const summary = computeSummary(pairId, timeSeries, currentBmexAPR, currentHlAPR, pair.name, pair.bitmex, pair.hl);
  return { summary, timeSeries };
}

// GET /api/arb/summary
// Fetches full 14-day history for all stale pairs (batched 3 at a time) so that
// consistency scores and cumulative yield are always history-derived, not defaults.
router.get("/arb/summary", async (req, res): Promise<void> => {
  try {
    const now = Date.now();

    const cachedPairs: PairSummary[] = [];
    const stalePairIds: string[] = [];
    const cacheTimestamps: number[] = [];

    for (const pairId of Object.keys(PAIRS)) {
      const cached = summaryCache.get(pairId);
      if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
        cachedPairs.push(cached.data);
        cacheTimestamps.push(cached.cachedAt);
      } else {
        stalePairIds.push(pairId);
      }
    }

    // Fetch full 14-day detail for stale pairs (up to 3 in parallel to respect rate limits)
    if (stalePairIds.length > 0) {
      const BATCH_SIZE = 3;
      for (let i = 0; i < stalePairIds.length; i += BATCH_SIZE) {
        const batch = stalePairIds.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map((id) => buildPairDetail(id)));
        for (let j = 0; j < batch.length; j++) {
          const pairId = batch[j];
          const result = results[j];
          if (result.status === "fulfilled") {
            const detail = result.value;
            detailCache.set(pairId, { data: detail, cachedAt: now });
            summaryCache.set(pairId, { data: detail.summary, cachedAt: now });
            cachedPairs.push(detail.summary);
            cacheTimestamps.push(now);
          } else {
            logger.error({ pairId, reason: result.reason }, "Failed to build detail for pair during summary");
          }
        }
      }
    }

    // Sort by pairId
    cachedPairs.sort((a, b) => parseInt(a.pairId) - parseInt(b.pairId));
    const cachedAt = cacheTimestamps.length > 0 ? new Date(Math.min(...cacheTimestamps)).toISOString() : new Date().toISOString();

    res.json({ pairs: cachedPairs, cachedAt });
  } catch (err) {
    logger.error({ err }, "Error fetching arb summary");
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// GET /api/arb/:pairId
router.get("/arb/:pairId", async (req, res): Promise<void> => {
  const { pairId } = req.params;

  if (!PAIRS[pairId]) {
    res.status(404).json({ error: "Pair not found" });
    return;
  }

  try {
    const now = Date.now();
    const cached = detailCache.get(pairId);

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }

    const detail = await buildPairDetail(pairId);
    detailCache.set(pairId, { data: detail, cachedAt: now });

    // Also update the summary cache with accurate stats from history
    summaryCache.set(pairId, { data: detail.summary, cachedAt: now });

    res.json(detail);
  } catch (err) {
    logger.error({ err, pairId }, "Error fetching arb detail");
    res.status(500).json({ error: "Failed to fetch detail data" });
  }
});

export default router;
