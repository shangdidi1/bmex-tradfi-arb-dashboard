import YahooFinance from "yahoo-finance2";
import { logger } from "./logger";

export const STRC_TICKER = "STRC";
// STRC IPO'd 2025-07-30 — start a few days earlier to avoid edge cases.
const HISTORY_FROM = "2025-07-01";

const yahooFinance = new YahooFinance();

export interface StrcPricePoint {
  date: string;     // ISO date "YYYY-MM-DD"
  close: number;
}

export interface StrcDividend {
  exDivDate: string;  // ISO date
  amount: number;
}

export interface StrcSummary {
  ticker: string;
  lastClose: number;
  lastCloseDate: string;            // ISO date
  lastDividend: number | null;
  lastExDivDate: string | null;     // ISO date
  history: StrcPricePoint[];
  dividends: StrcDividend[];
  fetchedAt: string;                // ISO datetime
}

function toDateOnly(d: Date): string {
  // Yahoo timestamps land at 13:30 UTC (NY market open). Render as the local NY trading date.
  return d.toISOString().slice(0, 10);
}

export async function fetchStrcSummary(): Promise<StrcSummary> {
  const out = await yahooFinance.chart(STRC_TICKER, {
    period1: HISTORY_FROM,
    interval: "1d",
    events: "div|split",
  });

  const quotes = (out.quotes ?? [])
    .filter((q) => q.close != null && q.date != null)
    .map((q) => ({
      date: toDateOnly(q.date as Date),
      close: parseFloat((q.close as number).toFixed(4)),
    }));

  type RawDiv = { amount: number; date: Date };
  const rawDivs = out.events?.dividends ?? [];
  const divList: RawDiv[] = Array.isArray(rawDivs)
    ? (rawDivs as RawDiv[])
    : (Object.values(rawDivs) as RawDiv[]);
  const dividends: StrcDividend[] = divList
    .map((d) => ({
      exDivDate: toDateOnly(d.date),
      amount: parseFloat(d.amount.toFixed(6)),
    }))
    .sort((a, b) => a.exDivDate.localeCompare(b.exDivDate));

  if (quotes.length === 0) {
    logger.warn({ ticker: STRC_TICKER }, "Yahoo returned no STRC quotes");
  }

  const lastQuote = quotes[quotes.length - 1];
  const lastDiv = dividends[dividends.length - 1];

  return {
    ticker: STRC_TICKER,
    lastClose: lastQuote?.close ?? 0,
    lastCloseDate: lastQuote?.date ?? toDateOnly(new Date()),
    lastDividend: lastDiv?.amount ?? null,
    lastExDivDate: lastDiv?.exDivDate ?? null,
    history: quotes,
    dividends,
    fetchedAt: new Date().toISOString(),
  };
}
