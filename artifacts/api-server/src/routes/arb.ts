import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DAYS_LOOKBACK = 30;
const BITMEX_INTERVALS_PER_DAY = 3;

const PAIRS: Record<string, { name: string; bitmex: string; hl: string }> = {
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
  "22": { name: "EUR/USD", bitmex: "EURUSD", hl: "xyz:EURUSD" },
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

async function fetchBitmexInstrument(symbol: string): Promise<{ openInterest?: number; openValueUsdt?: number } | null> {
  try {
    const url = `https://www.bitmex.com/api/v1/instrument?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ symbol, status: res.status, statusText: res.statusText }, "BitMEX instrument returned non-OK status");
      return null;
    }
    const data = await res.json() as Array<{ openInterest?: number; openValue?: number; quoteToSettleMultiplier?: number }>;
    const item = data[0];
    if (!item) return null;
    const multiplier = item.quoteToSettleMultiplier ?? 1_000_000;
    return {
      openInterest: item.openInterest,
      openValueUsdt: item.openValue ? item.openValue / multiplier : 0,
    };
  } catch (err) {
    logger.warn({ symbol, err }, "BitMEX instrument request failed");
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
      } else {
        hadError = true;
        logger.warn({ coin, status: res.status, statusText: res.statusText }, "Hyperliquid fundingHistory returned non-OK status");
      }
    } catch (err) {
      hadError = true;
      logger.warn({ coin, err }, "Hyperliquid fundingHistory request failed");
    }
    cur = chunkEnd;
    await sleep(150);
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
      } else {
        hadError = true;
        logger.warn({ coin, status: res.status, statusText: res.statusText }, "Hyperliquid candleSnapshot returned non-OK status");
      }
    } catch (err) {
      hadError = true;
      logger.warn({ coin, err }, "Hyperliquid candleSnapshot request failed");
    }
    cur = chunkEnd;
    await sleep(150);
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

function computeWindowMetrics(timeSeries: TimeSeriesPoint[], windowDays: number): WindowMetrics {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const pts = timeSeries.filter((p) => new Date(p.timestamp).getTime() >= cutoff);
  const total = pts.length;

  const bmexLower = pts.filter((p) => p.fundingSpread < 0).length;
  const consistencyScore = total > 0 ? parseFloat(((bmexLower / total) * 100).toFixed(1)) : 50;

  // Arb yield: always positive — we always take the favorable direction
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
): PairSummary {
  const spread = currentBmexAPR - currentHlAPR;

  const w7 = computeWindowMetrics(timeSeries, 7);
  const w14 = computeWindowMetrics(timeSeries, 14);
  const w30 = computeWindowMetrics(timeSeries, 30);

  // Determine suggestion from 14d mean spread direction
  const pts14 = timeSeries.filter((p) => new Date(p.timestamp).getTime() >= Date.now() - 14 * 24 * 60 * 60 * 1000);
  const meanSpread14 = pts14.length > 0
    ? pts14.reduce((sum, p) => sum + p.fundingSpread, 0) / pts14.length
    : spread;

  let suggestion: PairSummary["suggestion"] = "NEUTRAL";
  if (Math.abs(meanSpread14) > 0.1) {
    suggestion = meanSpread14 < 0 ? "LONG_BITMEX_SHORT_HL" : "LONG_HL_SHORT_BITMEX";
  }

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
  };
}

async function buildPairDetail(pairId: string): Promise<{ summary: PairSummary; timeSeries: TimeSeriesPoint[] }> {
  const pair = PAIRS[pairId];
  if (!pair) throw new Error("Pair not found");

  logger.info({ pairId, symbol: pair.bitmex }, "Fetching detail data for pair");

  const [bmexFunding, hlFunding, bmexPrice, hlPrice, bmexInstrument] = await Promise.all([
    fetchBitmexFundingHistory(pair.bitmex),
    fetchHyperliquidFundingHistory(pair.hl),
    fetchBitmexPriceHistory(pair.bitmex),
    fetchHyperliquidPriceHistory(pair.hl),
    fetchBitmexInstrument(pair.bitmex),
  ]);

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

  const summary = computeSummary(pairId, timeSeries, currentBmexAPR, currentHlAPR, pair.name, pair.bitmex, pair.hl, bmexInstrument?.openValueUsdt ?? 0);
  return { summary, timeSeries };
}

// GET /api/arb/summary
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
    summaryCache.set(pairId, { data: detail.summary, cachedAt: now });

    res.json(detail);
  } catch (err) {
    logger.error({ err, pairId }, "Error fetching arb detail");
    res.status(500).json({ error: "Failed to fetch detail data" });
  }
});

export default router;
