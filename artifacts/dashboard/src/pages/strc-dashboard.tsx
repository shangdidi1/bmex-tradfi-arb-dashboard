import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStrcSummary,
  getGetStrcSummaryQueryKey,
} from "@workspace/api-client-react";
import type {
  StrcDividend,
  StrcPricePoint,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, ReferenceDot,
} from "recharts";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import TopNav from "@/components/top-nav";

const RANGE_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: "7D", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "All", days: null },
];

const PAR = 100;
const DEFAULT_CADENCE_DAYS = 30;

const COLORS = {
  brand: "#FF6D00",
  price: "#2962FF",
  par: "#16a34a",
  fair: "#9ca3af",
  exDiv: "#16a34a",
  discountZone: "rgba(255,200,100,0.08)",
};

function fmtUsd(v: number, digits = 2): string {
  return `$${v.toFixed(digits)}`;
}

function fmtPct(v: number, digits = 2): string {
  return `${v.toFixed(digits)}%`;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86_400_000);
}

function detectCadence(dividends: StrcDividend[]): number {
  if (dividends.length < 2) return DEFAULT_CADENCE_DAYS;
  const recent = dividends.slice(-6);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const a = new Date(recent[i - 1].exDivDate);
    const b = new Date(recent[i].exDivDate);
    gaps.push(daysBetween(a, b));
  }
  if (gaps.length === 0) return DEFAULT_CADENCE_DAYS;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return Math.round(median);
}

interface BacktestRow {
  buyDate: string;
  entry: number;
  discountPct: number;
  exitDate: string;
  exit: number;
  divsInWindow: number;
  returnPct: number;
  pnl: number;
}

function runBacktest(
  history: StrcPricePoint[],
  dividends: StrcDividend[],
  horizonDays: number,
  investment: number,
): BacktestRow[] {
  if (history.length === 0) return [];
  const histDates = history.map((p) => new Date(p.date).getTime());
  const rows: BacktestRow[] = [];

  for (let i = 0; i < history.length; i++) {
    const buy = history[i];
    if (buy.close >= PAR) continue;

    const buyTs = new Date(buy.date).getTime();
    const targetTs = buyTs + horizonDays * 86_400_000;
    // Find first trading day with timestamp >= targetTs
    const exitIdx = histDates.findIndex((t) => t >= targetTs);
    if (exitIdx === -1 || exitIdx <= i) continue;
    const exit = history[exitIdx];

    const divsSum = dividends
      .filter((d) => {
        const t = new Date(d.exDivDate).getTime();
        return t > buyTs && t <= new Date(exit.date).getTime();
      })
      .reduce((acc, d) => acc + d.amount, 0);

    const ret = (exit.close - buy.close + divsSum) / buy.close;
    const pnl = (investment / buy.close) * (exit.close - buy.close + divsSum);

    rows.push({
      buyDate: buy.date,
      entry: buy.close,
      discountPct: ((PAR - buy.close) / PAR) * 100,
      exitDate: exit.date,
      exit: exit.close,
      divsInWindow: divsSum,
      returnPct: ret * 100,
      pnl,
    });
  }

  rows.sort((a, b) => b.returnPct - a.returnPct);
  return rows;
}

interface ChartPoint {
  ts: number;
  close: number;
  divAmount: number | null;
}

function parseLocalDate(s: string): Date {
  // "2026-05-18" parsed as 2026-05-18 00:00 LOCAL (not UTC). Avoids "May 17"
  // showing for a US user when Yahoo's ISO date renders in PT.
  return new Date(`${s}T00:00:00`);
}

function buildChartData(
  history: StrcPricePoint[],
  dividends: StrcDividend[],
): ChartPoint[] {
  const divMap = new Map(dividends.map((d) => [d.exDivDate, d.amount]));
  return history.map((p) => ({
    ts: parseLocalDate(p.date).getTime(),
    close: p.close,
    divAmount: divMap.get(p.date) ?? null,
  }));
}

function freshnessLabel(fetchedAt: string): string {
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  const m = Math.max(0, Math.floor(ageMs / 60_000));
  return `Data fetched ${m}m ago · Yahoo Finance (~15m delayed)`;
}

export default function StrcDashboard() {
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching } = useGetStrcSummary({
    query: {
      queryKey: getGetStrcSummaryQueryKey(),
      refetchInterval: 300_000,           // poll every 5 min
      refetchOnWindowFocus: true,         // refetch when the tab regains focus
      refetchOnMount: "always",           // refetch on every mount, never use stale
    },
  });
  const loading = isLoading || isFetching;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetStrcSummaryQueryKey() });
  };

  const [investment, setInvestment] = useState<number>(10_000);
  const [horizonDays, setHorizonDays] = useState<number>(30);
  // Strategy APR overrides — null means "use the auto-derived default"
  const [overrideDaysToNextExDiv, setOverrideDaysToNextExDiv] = useState<number | null>(null);
  const [overrideExpectedDiv, setOverrideExpectedDiv] = useState<number | null>(null);
  // Chart range: default to 1M so day-to-day volatility doesn't drown out
  // recent moves. User can opt into longer history.
  const [chartRangeDays, setChartRangeDays] = useState<number | null>(30);

  const chartData = useMemo(
    () => (data ? buildChartData(data.history, data.dividends) : []),
    [data],
  );

  const filteredChart = useMemo(() => {
    if (!chartData.length) return [] as ChartPoint[];
    if (chartRangeDays == null) return chartData;
    const cutoff = Date.now() - chartRangeDays * 86_400_000;
    return chartData.filter((p) => p.ts >= cutoff);
  }, [chartData, chartRangeDays]);

  const exDivMarkers = useMemo(
    () => filteredChart.filter((p) => p.divAmount !== null),
    [filteredChart],
  );

  const cadence = useMemo(
    () => (data ? detectCadence(data.dividends) : DEFAULT_CADENCE_DAYS),
    [data],
  );

  const backtest = useMemo(
    () => (data ? runBacktest(data.history, data.dividends, horizonDays, investment) : []),
    [data, horizonDays, investment],
  );

  const lastClose = data?.lastClose ?? 0;
  const lastDiv = data?.lastDividend ?? null;
  const lastExDiv = data?.lastExDivDate ?? null;
  const fair = lastDiv != null ? PAR - lastDiv : null;
  const discount = PAR - lastClose;
  const discountPct = (discount / PAR) * 100;
  const today = new Date();
  const daysSinceExDiv = lastExDiv ? daysBetween(new Date(lastExDiv), today) : null;
  const showFairNote = daysSinceExDiv != null && daysSinceExDiv >= 0 && daysSinceExDiv <= 5 && fair != null;

  // Y-axis bounds based on actual data IN THE VISIBLE RANGE so a flash crash
  // in November doesn't compress the May view into a thin strip.
  const yDomain = useMemo<[number, number]>(() => {
    if (filteredChart.length === 0) return [95, 101];
    const lows = filteredChart.map((p) => p.close);
    return [Math.floor(Math.min(...lows) - 0.5), Math.ceil(Math.max(...lows, PAR) + 0.5)];
  }, [filteredChart]);

  const latestPoint = filteredChart.length > 0 ? filteredChart[filteredChart.length - 1] : null;
  const nowTs = Date.now();
  const showNowLine =
    latestPoint != null && nowTs > latestPoint.ts + 12 * 3600_000 && nowTs <= (filteredChart[filteredChart.length - 1]?.ts ?? 0) + 7 * 86_400_000;

  // ── Strategy APR ──────────────────────────────────────────────────────
  // "If you buy now and hold to the next estimated ex-div, capturing one
  //  dividend and exiting at par, what's the annualised return?"
  // Inputs are overridable so cadence changes don't silently break this.
  const defaultDaysToNextExDiv = useMemo(() => {
    if (daysSinceExDiv == null) return cadence;
    return Math.max(1, cadence - daysSinceExDiv);
  }, [cadence, daysSinceExDiv]);

  const daysToNextExDiv = overrideDaysToNextExDiv ?? defaultDaysToNextExDiv;
  const expectedDiv = overrideExpectedDiv ?? lastDiv ?? 0;
  const nextExDivEstimate = lastExDiv
    ? new Date(new Date(lastExDiv).getTime() + cadence * 86_400_000).toISOString().slice(0, 10)
    : null;

  const strategySimpleReturn =
    lastClose > 0 && daysToNextExDiv > 0
      ? (PAR - lastClose + expectedDiv) / lastClose
      : 0;
  const strategyAPR = strategySimpleReturn * (365 / Math.max(1, daysToNextExDiv));
  const strategyProfit = (investment / Math.max(0.01, lastClose)) * (PAR - lastClose + expectedDiv);

  // Discount-type classification (informational, not a verdict)
  const discountType: { label: string; tone: "panic" | "post-ex-div" | "discount" | "fair" | "premium" } = useMemo(() => {
    if (lastClose >= PAR + 0.05) return { label: "Premium to par", tone: "premium" };
    if (Math.abs(lastClose - PAR) < 0.05) return { label: "At par — no discount", tone: "fair" };
    if (fair != null && lastClose < fair - 0.02) {
      // Trades below the post-ex-div fair value → not just the dividend drop
      return { label: "Panic / oversold (below post-ex-div fair)", tone: "panic" };
    }
    if (fair != null && daysSinceExDiv != null && daysSinceExDiv <= 5 && lastClose < PAR - 0.02) {
      return { label: "Post-ex-div mechanical drop", tone: "post-ex-div" };
    }
    return { label: "Discount to par", tone: "discount" };
  }, [lastClose, fair, daysSinceExDiv]);

  // Dividend history augmented with days-since-prior gap
  const dividendsWithGaps = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.dividends].sort((a, b) => a.exDivDate.localeCompare(b.exDivDate));
    return sorted.map((d, i) => ({
      ...d,
      daysSincePrior: i === 0 ? null : daysBetween(new Date(sorted[i - 1].exDivDate), new Date(d.exDivDate)),
    })).reverse(); // newest first for display
  }, [data]);

  const tickColor = "#6b7280";
  const gridColor = "rgba(255,255,255,0.05)";

  return (
    <div className="min-h-screen bg-[#0f111a] text-gray-200 px-5 py-4 pt-[32px] pb-[32px] pl-[24px] pr-[24px]">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <TopNav />

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-bold text-[28px]">
              <span className="text-[#FF6D00]">STRC</span> Discount
            </h1>
            <p className="text-gray-400 mt-1.5 text-[14px]">
              Strategy Inc <span className="text-[#FF6D00] font-medium">'Stretch'</span> (STRC) — perpetual preferred, $100 par. Buy below par for pull-to-par + dividend yield. Strategy APR assumes the auto-detected dividend cadence — override the inputs in the panel below if Strategy switches schedule.
            </p>
          </div>
          {data && (
            <div className="flex items-center gap-2 pt-2 whitespace-nowrap">
              <p className="text-[12px] text-gray-500">{freshnessLabel(data.fetchedAt)}</p>
              <button
                onClick={handleRefresh}
                disabled={isFetching}
                className="text-gray-400 hover:text-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh now"
              >
                <RefreshCw className={"w-3.5 h-3.5 " + (isFetching ? "animate-spin" : "")} />
              </button>
            </div>
          )}
        </div>

        {/* Status row: 4 metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-5">
              <p className="text-xs text-gray-400">Last close</p>
              {loading && !data ? (
                <Skeleton className="h-8 w-24 mt-2 bg-gray-700" />
              ) : (
                <>
                  <p className="text-[28px] leading-none font-bold mt-2 font-mono">{fmtUsd(lastClose)}</p>
                  <p className="text-[11px] text-gray-500 mt-1.5">as of {data?.lastCloseDate}</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-5">
              <p className="text-xs text-gray-400">Discount to par</p>
              {loading && !data ? (
                <Skeleton className="h-8 w-24 mt-2 bg-gray-700" />
              ) : (
                <>
                  <p className={`text-[28px] leading-none font-bold mt-2 font-mono ${discount > 0 ? "text-green-400" : "text-gray-300"}`}>
                    {fmtUsd(discount)}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-1.5 font-mono">{fmtPct(discountPct)}</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-5">
              <p className="text-xs text-gray-400">Last dividend</p>
              {loading && !data ? (
                <Skeleton className="h-8 w-24 mt-2 bg-gray-700" />
              ) : lastDiv != null ? (
                <>
                  <p className="text-[28px] leading-none font-bold mt-2 font-mono">${lastDiv.toFixed(4)}</p>
                  <p className="text-[11px] text-gray-500 mt-1.5">ex-div {lastExDiv}</p>
                </>
              ) : (
                <p className="text-2xl text-gray-500 mt-2">—</p>
              )}
            </CardContent>
          </Card>

          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-5">
              <p className="text-xs text-gray-400">Days since ex-div</p>
              {loading && !data ? (
                <Skeleton className="h-8 w-24 mt-2 bg-gray-700" />
              ) : daysSinceExDiv != null ? (
                <>
                  <p className="text-[28px] leading-none font-bold mt-2 font-mono">{daysSinceExDiv}d</p>
                  <p className="text-[11px] text-gray-500 mt-1.5">cadence ~{cadence}d</p>
                </>
              ) : (
                <p className="text-2xl text-gray-500 mt-2">—</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Strategy APR — the headline number for "buying the discount" */}
        <Card className="bg-gradient-to-br from-[#1f2435] to-[#1a1f2e] border-gray-700">
          <CardContent className="p-6">
            <div className="flex items-baseline justify-between gap-4 mb-1 flex-wrap">
              <div>
                <p className="text-sm text-gray-300 font-medium">Strategy APR — buying the discount</p>
                <p className="text-[11px] text-gray-500 -mt-0.5">
                  Hold to next ex-div, capture one dividend, exit at par. Annualised.
                </p>
              </div>
              {data && (
                <span className={"text-[11px] px-2 py-1 rounded font-medium " + (
                  discountType.tone === "panic" ? "bg-orange-900/40 text-orange-300 border border-orange-800/50"
                  : discountType.tone === "post-ex-div" ? "bg-blue-900/40 text-blue-300 border border-blue-800/50"
                  : discountType.tone === "discount" ? "bg-green-900/40 text-green-300 border border-green-800/50"
                  : discountType.tone === "premium" ? "bg-red-900/40 text-red-300 border border-red-800/50"
                  : "bg-gray-800 text-gray-400 border border-gray-700"
                )}>
                  {discountType.label}
                </span>
              )}
            </div>

            {loading && !data ? (
              <Skeleton className="h-12 w-40 mt-4 bg-gray-700" />
            ) : (
              <>
                <p className={"text-[44px] leading-none font-bold mt-3 font-mono " + (
                  strategyAPR * 100 >= 30 ? "text-green-400"
                  : strategyAPR * 100 >= 10 ? "text-amber-400"
                  : strategyAPR * 100 >= 0 ? "text-gray-300"
                  : "text-red-400"
                )}>
                  {strategyAPR > 0 ? "+" : ""}{(strategyAPR * 100).toFixed(1)}%
                </p>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
                  <div>
                    <p className="text-xs text-gray-400">Discount to par</p>
                    <p className={"text-lg font-mono mt-1 " + (discount > 0 ? "text-green-400" : "text-gray-300")}>
                      {discount >= 0 ? "+" : ""}${discount.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5 font-mono">{discountPct >= 0 ? "+" : ""}{discountPct.toFixed(2)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Days to next ex-div</p>
                    <p className="text-lg font-mono mt-1">{daysToNextExDiv}d</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">est. {nextExDivEstimate ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Expected dividend</p>
                    <p className="text-lg font-mono mt-1">${expectedDiv.toFixed(4)}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">last paid</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Profit on ${investment.toLocaleString()}</p>
                    <p className={"text-lg font-mono mt-1 " + (strategyProfit >= 0 ? "text-green-400" : "text-red-400")}>
                      {strategyProfit >= 0 ? "+" : ""}${Math.round(strategyProfit).toLocaleString()}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5 font-mono">{(strategySimpleReturn * 100).toFixed(2)}% over {daysToNextExDiv}d</p>
                  </div>
                </div>

                <p className="text-[12px] text-gray-400 mt-5 leading-relaxed">
                  <span className="text-gray-500">Math:</span>{" "}
                  ((${PAR.toFixed(0)} − ${lastClose.toFixed(2)} + ${expectedDiv.toFixed(4)}) ÷ ${lastClose.toFixed(2)}) × (365 / {daysToNextExDiv}) = <span className="text-gray-200 font-mono">{(strategyAPR * 100).toFixed(1)}%</span>.
                  {" "}Assumes price reverts to par by next ex-div. Auto-detected cadence: {cadence}d.
                </p>

                <details className="mt-4">
                  <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-300 select-none">
                    Override assumptions ↓ (use this when Strategy switches to twice-monthly)
                  </summary>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px]">
                    <label className="flex items-center gap-2 text-gray-400">
                      Days to next ex-div
                      <input
                        type="number"
                        min={1}
                        max={180}
                        value={overrideDaysToNextExDiv ?? defaultDaysToNextExDiv}
                        onChange={(e) => setOverrideDaysToNextExDiv(Math.max(1, Number(e.target.value) || 1))}
                        className="bg-[#0f111a] border border-gray-700 rounded px-2 py-1 w-20 text-gray-200 font-mono"
                      />
                      {overrideDaysToNextExDiv !== null && (
                        <button onClick={() => setOverrideDaysToNextExDiv(null)} className="text-[10px] text-gray-500 hover:text-gray-300">reset</button>
                      )}
                    </label>
                    <label className="flex items-center gap-2 text-gray-400">
                      Expected dividend
                      <input
                        type="number"
                        min={0}
                        max={5}
                        step={0.01}
                        value={overrideExpectedDiv ?? (lastDiv ?? 0)}
                        onChange={(e) => setOverrideExpectedDiv(Math.max(0, Number(e.target.value) || 0))}
                        className="bg-[#0f111a] border border-gray-700 rounded px-2 py-1 w-24 text-gray-200 font-mono"
                      />
                      {overrideExpectedDiv !== null && (
                        <button onClick={() => setOverrideExpectedDiv(null)} className="text-[10px] text-gray-500 hover:text-gray-300">reset</button>
                      )}
                    </label>
                    <label className="flex items-center gap-2 text-gray-400">
                      Investment
                      <input
                        type="number"
                        min={100}
                        step={1000}
                        value={investment}
                        onChange={(e) => setInvestment(Math.max(100, Number(e.target.value) || 0))}
                        className="bg-[#0f111a] border border-gray-700 rounded px-2 py-1 w-28 text-gray-200 font-mono"
                      />
                    </label>
                  </div>
                </details>
              </>
            )}
          </CardContent>
        </Card>

        {/* Post-ex-div fair value note */}
        {showFairNote && fair != null && (
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-4 flex items-baseline gap-3 text-[13px] text-gray-300">
              <span className="text-[#FF6D00] font-medium">Just past ex-div</span>
              <span className="text-gray-500">·</span>
              <span>
                Post-ex-div fair value = par − dividend = <span className="font-mono text-gray-100">{fmtUsd(fair)}</span>.
                Last close <span className="font-mono text-gray-100">{fmtUsd(lastClose)}</span> is{" "}
                <span className={`font-mono ${lastClose - fair < 0 ? "text-green-400" : "text-amber-400"}`}>
                  {(lastClose - fair >= 0 ? "+" : "") + (lastClose - fair).toFixed(2)}
                </span>{" "}
                vs fair.
              </span>
            </CardContent>
          </Card>
        )}

        {/* Price chart */}
        <Card className="bg-[#1a1f2e] border-gray-800">
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
            <div>
              <CardTitle className="text-base">Price history</CardTitle>
              {data && (
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Through {data.lastCloseDate} · {filteredChart.length} day{filteredChart.length === 1 ? "" : "s"} shown
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              {RANGE_OPTIONS.map((r) => {
                const active = chartRangeDays === r.days;
                return (
                  <button
                    key={r.label}
                    onClick={() => setChartRangeDays(r.days)}
                    className={
                      "px-2.5 py-1 text-[11px] rounded font-medium transition-colors " +
                      (active
                        ? "bg-[#FF6D00] text-white"
                        : "bg-[#0f111a] text-gray-400 hover:text-gray-200 border border-gray-700")
                    }
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <Skeleton className="h-[440px] w-full bg-gray-700" />
            ) : filteredChart.length === 0 ? (
              <p className="text-sm text-gray-500 py-12 text-center">No data in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height={440} debounce={0}>
                <ComposedChart data={filteredChart} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={gridColor} vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    scale="time"
                    tickFormatter={(t) => format(new Date(t), chartRangeDays != null && chartRangeDays <= 30 ? "MMM d" : "MMM d, yy")}
                    tick={{ fill: tickColor, fontSize: 11 }}
                    stroke="#374151"
                    minTickGap={60}
                  />
                  <YAxis
                    domain={yDomain}
                    tick={{ fill: tickColor, fontSize: 11 }}
                    stroke="#374151"
                    tickFormatter={(v: number) => `$${v}`}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{ background: "#0f111a", border: "1px solid #374151", borderRadius: 6, fontSize: 12 }}
                    labelFormatter={(t) => format(new Date(t as number), "yyyy-MM-dd (EEE)")}
                    formatter={(value: number, name: string, item: { payload?: ChartPoint }) => {
                      if (name === "Close") return [fmtUsd(value), "Close"];
                      if (name === "Ex-div") {
                        const div = item.payload?.divAmount;
                        return [`Close ${fmtUsd(value)} · div $${div?.toFixed(4)}`, "Ex-div"];
                      }
                      return [value, name];
                    }}
                  />
                  <ReferenceArea y1={yDomain[0]} y2={PAR} fill={COLORS.discountZone} stroke="none" />
                  <ReferenceLine
                    y={PAR}
                    stroke={COLORS.par}
                    strokeDasharray="4 4"
                    label={{ value: "Par $100", position: "insideTopRight", fill: COLORS.par, fontSize: 11 }}
                  />
                  {fair != null && (
                    <ReferenceLine
                      y={fair}
                      stroke={COLORS.fair}
                      strokeDasharray="2 4"
                      label={{ value: `Post-ex-div fair $${fair.toFixed(2)}`, position: "insideBottomRight", fill: COLORS.fair, fontSize: 11 }}
                    />
                  )}
                  {showNowLine && (
                    <ReferenceLine
                      x={nowTs}
                      stroke="rgba(255,109,0,0.5)"
                      strokeDasharray="2 4"
                      label={{ value: "now", position: "top", fill: "#FF6D00", fontSize: 10 }}
                    />
                  )}
                  <Line
                    type="linear"
                    dataKey="close"
                    name="Close"
                    stroke={COLORS.price}
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  <Scatter
                    data={exDivMarkers}
                    dataKey="close"
                    name="Ex-div"
                    fill={COLORS.exDiv}
                    shape="diamond"
                    isAnimationActive={false}
                  />
                  {latestPoint && (
                    <ReferenceDot
                      x={latestPoint.ts}
                      y={latestPoint.close}
                      r={4}
                      fill={COLORS.price}
                      stroke="#fff"
                      strokeWidth={1.5}
                      isFront
                      label={{
                        value: `${data?.lastCloseDate} $${latestPoint.close.toFixed(2)}`,
                        position: "top",
                        fill: "#9ca3af",
                        fontSize: 10,
                        offset: 8,
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Backtest controls + table */}
        <Card className="bg-[#1a1f2e] border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Historical sub-par opportunities</CardTitle>
            <p className="text-[12px] text-gray-400 mt-1">
              Every day STRC closed below par, with the realised return if held the chosen horizon
              (actual subsequent close + actual dividends paid in window). Sorted by Return %.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-4 mb-4 text-[13px]">
              <label className="flex items-center gap-2 text-gray-400">
                Holding horizon (days)
                <input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={horizonDays}
                  onChange={(e) => setHorizonDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                  className="bg-[#0f111a] border border-gray-700 rounded px-2 py-1 w-20 text-gray-200 font-mono"
                />
              </label>
              <span className="text-[11px] text-gray-500">Investment size: <span className="font-mono text-gray-300">${investment.toLocaleString()}</span> (change in Strategy APR panel)</span>
            </div>
            {loading && !data ? (
              <Skeleton className="h-48 w-full bg-gray-700" />
            ) : backtest.length === 0 ? (
              <p className="text-sm text-gray-500">
                Not enough forward history yet for a {horizonDays}d holding window, or STRC has not closed below par.
              </p>
            ) : (
              <div className="border border-gray-800 rounded">
                <Table>
                  <TableHeader>
                    <TableRow className="border-gray-800 hover:bg-transparent">
                      <TableHead className="text-gray-400">Buy date</TableHead>
                      <TableHead className="text-gray-400 text-right">Entry</TableHead>
                      <TableHead className="text-gray-400 text-right">Discount %</TableHead>
                      <TableHead className="text-gray-400 text-right">Exit date</TableHead>
                      <TableHead className="text-gray-400 text-right">Exit</TableHead>
                      <TableHead className="text-gray-400 text-right">Divs</TableHead>
                      <TableHead className="text-gray-400 text-right">Return %</TableHead>
                      <TableHead className="text-gray-400 text-right">P&amp;L on ${investment.toLocaleString()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {backtest.map((r) => (
                      <TableRow key={r.buyDate} className="border-gray-800 hover:bg-[#0f111a]/40">
                        <TableCell className="font-mono text-gray-300">{r.buyDate}</TableCell>
                        <TableCell className="font-mono text-right">{fmtUsd(r.entry)}</TableCell>
                        <TableCell className="font-mono text-right">{r.discountPct.toFixed(2)}%</TableCell>
                        <TableCell className="font-mono text-right text-gray-400">{r.exitDate}</TableCell>
                        <TableCell className="font-mono text-right">{fmtUsd(r.exit)}</TableCell>
                        <TableCell className="font-mono text-right">${r.divsInWindow.toFixed(4)}</TableCell>
                        <TableCell className={`font-mono text-right ${r.returnPct > 0 ? "text-green-400" : r.returnPct < 0 ? "text-red-400" : "text-gray-300"}`}>
                          {r.returnPct > 0 ? "+" : ""}{r.returnPct.toFixed(2)}%
                        </TableCell>
                        <TableCell className={`font-mono text-right ${r.pnl > 0 ? "text-green-400" : r.pnl < 0 ? "text-red-400" : "text-gray-300"}`}>
                          {r.pnl >= 0 ? "+" : ""}${Math.round(r.pnl).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dividend history */}
        <Card className="bg-[#1a1f2e] border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dividend history</CardTitle>
            <p className="text-[12px] text-gray-400 mt-1">
              Auto-detected cadence: <span className="font-mono text-gray-200">{cadence}d</span> (median of last 5 gaps).
              Watch the "Days since prior" column for cadence shifts.
            </p>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <Skeleton className="h-32 w-full bg-gray-700" />
            ) : dividendsWithGaps.length === 0 ? (
              <p className="text-sm text-gray-500">No dividend history available.</p>
            ) : (
              <div className="border border-gray-800 rounded">
                <Table>
                  <TableHeader>
                    <TableRow className="border-gray-800 hover:bg-transparent">
                      <TableHead className="text-gray-400">Ex-div date</TableHead>
                      <TableHead className="text-gray-400 text-right">Dividend</TableHead>
                      <TableHead className="text-gray-400 text-right">Days since prior</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dividendsWithGaps.map((d) => (
                      <TableRow key={d.exDivDate} className="border-gray-800 hover:bg-[#0f111a]/40">
                        <TableCell className="font-mono text-gray-300">{d.exDivDate}</TableCell>
                        <TableCell className="font-mono text-right">${d.amount.toFixed(4)}</TableCell>
                        <TableCell className="font-mono text-right text-gray-400">
                          {d.daysSincePrior == null ? "—" : `${d.daysSincePrior}d`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-gray-500 leading-relaxed">
          Information only. Not investment advice. Forward APR projections deliberately omitted —
          STRC is expected to switch from monthly to twice-monthly distributions, which would
          invalidate any calculation that assumes the current cadence. Data: Yahoo Finance via
          yahoo-finance2 (~15-20 min delayed). Historical ex-div dates are authoritative;
          verify any future schedule against Strategy IR / SEC 8-K.
        </p>
      </div>
    </div>
  );
}
