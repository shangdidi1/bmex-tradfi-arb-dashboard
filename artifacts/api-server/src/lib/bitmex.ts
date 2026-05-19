import { logger } from "./logger";

export const BITMEX_INTERVALS_PER_DAY = 3;
export const DAYS_LOOKBACK = 365;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchBitmexFundingHistory(
  symbol: string,
): Promise<Array<{ ts: number; apr: number }>> {
  const result: Array<{ ts: number; apr: number }> = [];
  const endTime = Date.now();
  const startTime = endTime - DAYS_LOOKBACK * 24 * 60 * 60 * 1000;
  let currentStart = new Date(startTime).toISOString();

  while (true) {
    try {
      const url = `https://www.bitmex.com/api/v1/funding?symbol=${encodeURIComponent(symbol)}&count=500&startTime=${encodeURIComponent(currentStart)}&reverse=false`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ symbol, status: res.status, statusText: res.statusText }, "BitMEX funding returned non-OK status");
        break;
      }
      const history = (await res.json()) as Array<{ timestamp: string; fundingRate?: number }>;
      if (!history.length) break;

      for (const item of history) {
        const ts = new Date(item.timestamp).getTime();
        const rawRate = item.fundingRate ?? 0;
        const apr = rawRate * BITMEX_INTERVALS_PER_DAY * 365 * 100;
        result.push({ ts, apr });
      }

      if (history.length < 500) break;
      const lastDt = new Date(history[history.length - 1].timestamp).getTime() + 1000;
      currentStart = new Date(lastDt).toISOString();
      await sleep(600);
    } catch (err) {
      logger.warn({ symbol, err }, "BitMEX funding request failed");
      break;
    }
  }
  return result;
}

export async function fetchBitmexLatestFundingAPR(symbol: string): Promise<number> {
  try {
    const url = `https://www.bitmex.com/api/v1/funding?symbol=${encodeURIComponent(symbol)}&count=1&reverse=true`;
    const res = await fetch(url);
    if (!res.ok) return 0;
    const data = (await res.json()) as Array<{ fundingRate?: number }>;
    const rate = data[0]?.fundingRate ?? 0;
    return rate * BITMEX_INTERVALS_PER_DAY * 365 * 100;
  } catch {
    return 0;
  }
}
