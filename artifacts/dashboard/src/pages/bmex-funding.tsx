import { useMemo, useState } from "react";
import {
  useGetBmexFundingSummary,
  getGetBmexFundingSummaryQueryKey,
  BmexFundingSummaryResponseSuggestion,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine,
} from "recharts";
import { format } from "date-fns";
import TopNav from "@/components/top-nav";

const COLORS = {
  btc:  "#FF6D00",  // BMEX BTC-margined inverse
  usdt: "#2962FF",  // BMEX USDT-margined linear
  spreadGreen: "#16a34a",
  spreadRed: "#dc2626",
};

function formatPercent(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(v / 100);
}

function suggestionLabel(s: BmexFundingSummaryResponseSuggestion): string {
  if (s === BmexFundingSummaryResponseSuggestion.SHORT_BTC_LONG_USDT) return "SHORT XBTUSD / LONG XBTUSDT";
  if (s === BmexFundingSummaryResponseSuggestion.LONG_BTC_SHORT_USDT) return "LONG XBTUSD / SHORT XBTUSDT";
  return "NEUTRAL";
}

const RANGE_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

const LEVERAGE_OPTIONS: number[] = [1, 2, 5, 10, 25];

export default function BmexFunding() {
  const { data, isLoading, isFetching } = useGetBmexFundingSummary({
    query: { queryKey: getGetBmexFundingSummaryQueryKey(), refetchInterval: 300_000 },
  });
  const loading = isLoading || isFetching;

  const [rangeDays, setRangeDays] = useState<number>(365);
  const [leverage, setLeverage] = useState<number>(1);

  // Merge both legs' history into one series keyed by timestamp.
  // Funding settles every 8h on both legs; timestamps usually align but we
  // forward-fill when one side is missing a point to keep the series dense.
  const series = useMemo(() => {
    if (!data) return [] as Array<{ ts: number; btcAPR: number; usdtAPR: number; spreadAPR: number }>;
    const btcMap = new Map<number, number>(data.btc.history.map((p) => [p.ts, p.apr]));
    const usdtMap = new Map<number, number>(data.usdt.history.map((p) => [p.ts, p.apr]));
    const allTs = Array.from(new Set<number>([...btcMap.keys(), ...usdtMap.keys()])).sort((a, b) => a - b);
    let lastBtc = 0, lastUsdt = 0;
    return allTs.map((ts) => {
      if (btcMap.has(ts)) lastBtc = btcMap.get(ts)!;
      if (usdtMap.has(ts)) lastUsdt = usdtMap.get(ts)!;
      return {
        ts,
        btcAPR: lastBtc,
        usdtAPR: lastUsdt,
        spreadAPR: parseFloat((lastBtc - lastUsdt).toFixed(4)),
      };
    });
  }, [data]);

  const visibleSeries = useMemo(() => {
    if (!series.length) return series;
    const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    return series.filter((p) => p.ts >= cutoff);
  }, [series, rangeDays]);

  // Strategy APR over the visible window: assumes the trader takes the
  // favorable direction each 8h settle (short the higher-funding leg,
  // long the lower one). That makes the per-tick carry equal to |spread|,
  // and the annualized strategy APR equals the mean of |spread_apr|.
  // Gross of taker fees and execution slippage.
  const windowStats = useMemo(() => {
    if (!visibleSeries.length) return { strategyAPR: 0, avgBtcAPR: 0, avgUsdtAPR: 0 };
    const n = visibleSeries.length;
    let absSum = 0, btcSum = 0, usdtSum = 0;
    for (const p of visibleSeries) {
      absSum += Math.abs(p.spreadAPR);
      btcSum += p.btcAPR;
      usdtSum += p.usdtAPR;
    }
    return {
      strategyAPR: parseFloat((absSum / n).toFixed(4)),
      avgBtcAPR: parseFloat((btcSum / n).toFixed(4)),
      avgUsdtAPR: parseFloat((usdtSum / n).toFixed(4)),
    };
  }, [visibleSeries]);

  const leveragedAPR = parseFloat((windowStats.strategyAPR * leverage).toFixed(4));
  const rangeLabel = RANGE_OPTIONS.find((r) => r.days === rangeDays)?.label ?? "1Y";

  function strategyAPRColor(apr: number): string {
    if (apr >= 10) return "text-green-400";
    if (apr >= 5) return "text-amber-400";
    return "text-gray-400";
  }

  const gridColor = "rgba(255,255,255,0.05)";
  const tickColor = "#6b7280";

  return (
    <div className="min-h-screen bg-[#0f111a] text-gray-200 px-5 py-4 pt-[32px] pb-[32px] pl-[24px] pr-[24px]">
      <div className="max-w-[1400px] mx-auto space-y-6">
        <TopNav />

        <div>
          <h1 className="font-bold text-[28px]">
            <span className="text-[#FF6D00]">BitMEX</span> Internal Funding Arb
          </h1>
          <p className="text-gray-400 mt-1.5 text-[14px]">
            Short the higher-funding leg, long the lower-funding leg. <span className="text-[#FF6D00] font-medium">XBTUSD</span> (BTC-margined inverse) and <span className="text-[#2962FF] font-medium">XBTUSDT</span> (USDT-margined linear) regularly diverge, and BitMEX multi-asset margin lets you collateralize both legs with USDT — delta-neutral, single venue.
          </p>
          <details className="mt-3 text-[13px] text-gray-400">
            <summary className="cursor-pointer text-gray-300 hover:text-gray-100 select-none">How does this work? →</summary>
            <div className="mt-3 space-y-3 leading-[1.7] pl-3 border-l border-gray-800">
              <p><strong className="text-gray-200">Why funding diverges:</strong> XBTUSD and XBTUSDT have different participant pools (BTC holders vs stablecoin holders). Their funding rates regularly drift apart even though the underlying is identical.</p>
              <p><strong className="text-gray-200">Why only on BitMEX:</strong> BitMEX's multi-asset margin lets one pile of USDT back both an inverse and a linear position. Other exchanges segregate inverse and linear margin pools — you'd need BTC to fund the inverse leg, defeating the trade.</p>
              <p><strong className="text-gray-200">The mechanics:</strong> when XBTUSD funding &gt; XBTUSDT (green bars), SHORT XBTUSD + LONG XBTUSDT in equal $ notional. You collect the higher funding while paying the lower. Net BTC delta ≈ 0. Flip when the spread inverts (red bars). PnL is funding differential × notional × time, less round-trip taker fees (~0.1% per round trip).</p>
            </div>
          </details>
        </div>

        {/* Hero metric: leveraged strategy APR over selected range, plus 3 small KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="md:col-span-1 bg-gradient-to-br from-[#1f2435] to-[#1a1f2e] border-gray-700">
            <CardContent className="p-6">
              <p className="text-sm text-gray-300 font-medium">Strategy APR</p>
              <p className="text-[11px] text-gray-500 -mt-0.5">past {rangeLabel} · {leverage}× leverage · gross of fees</p>
              {loading && !data ? (
                <Skeleton className="h-12 w-32 mt-2 bg-gray-700" />
              ) : (
                <>
                  <p className={`text-[44px] leading-none font-bold mt-3 font-mono ${strategyAPRColor(leveragedAPR)}`}>
                    {formatPercent(leveragedAPR)}
                  </p>
                  {leverage > 1 && (
                    <p className="text-[12px] text-gray-400 mt-1.5 font-mono">
                      {formatPercent(windowStats.strategyAPR)} base × {leverage}×
                    </p>
                  )}
                  <p className="text-[11px] text-gray-500 mt-2">
                    Mean |XBTUSD − XBTUSDT| × leverage. Assumes favorable side taken each 8h tick. Subtract ~0.1% × N(flips) for fees. Leverage scales PnL but also liquidation risk on individual legs.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-[#1a1f2e] border-gray-800 md:col-span-2">
            <CardContent className="p-6 grid grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-gray-400">XBTUSD Avg APR</p>
                <p className="text-[10px] text-gray-500">past {rangeLabel} · BTC-margined</p>
                {loading && !data ? (
                  <Skeleton className="h-7 w-20 mt-1 bg-gray-700" />
                ) : (
                  <>
                    <p className="text-2xl font-bold mt-1 font-mono" style={{ color: COLORS.btc }}>
                      {formatPercent(windowStats.avgBtcAPR)}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-1 font-mono">now {formatPercent(data?.btc.currentAPR ?? 0)}</p>
                  </>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-400">XBTUSDT Avg APR</p>
                <p className="text-[10px] text-gray-500">past {rangeLabel} · USDT-margined</p>
                {loading && !data ? (
                  <Skeleton className="h-7 w-20 mt-1 bg-gray-700" />
                ) : (
                  <>
                    <p className="text-2xl font-bold mt-1 font-mono" style={{ color: COLORS.usdt }}>
                      {formatPercent(windowStats.avgUsdtAPR)}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-1 font-mono">now {formatPercent(data?.usdt.currentAPR ?? 0)}</p>
                  </>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-400">Current Spread</p>
                <p className="text-[10px] text-gray-500">{loading && !data ? "…" : suggestionLabel(data?.suggestion ?? "NEUTRAL")}</p>
                {loading && !data ? (
                  <Skeleton className="h-7 w-20 mt-1 bg-gray-700" />
                ) : (
                  <p className={`text-2xl font-bold mt-1 font-mono ${(data?.spreadAPR ?? 0) > 0 ? "text-green-400" : (data?.spreadAPR ?? 0) < 0 ? "text-red-400" : "text-gray-300"}`}>
                    {formatPercent(data?.spreadAPR ?? 0)}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Time-range + leverage selectors */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 mr-2">Leverage</span>
            {LEVERAGE_OPTIONS.map((lev) => (
              <button
                key={lev}
                type="button"
                onClick={() => setLeverage(lev)}
                className={
                  "px-3 py-1 text-xs font-medium rounded border transition-colors " +
                  (leverage === lev
                    ? "bg-[#FF6D00] border-[#FF6D00] text-black"
                    : "bg-[#1a1f2e] border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500")
                }
              >
                {lev}×
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 mr-2">Range</span>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeDays(r.days)}
                className={
                  "px-3 py-1 text-xs font-medium rounded border transition-colors " +
                  (rangeDays === r.days
                    ? "bg-[#FF6D00] border-[#FF6D00] text-black"
                    : "bg-[#1a1f2e] border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500")
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Spread chart — primary view */}
        <Card className="bg-[#1a1f2e] border-gray-800">
          <CardHeader>
            <CardTitle className="text-base font-medium text-gray-200">
              Funding Spread (XBTUSD − XBTUSDT){" "}
              <span className="text-xs font-normal text-gray-500 ml-2">
                Green = SHORT XBTUSD / LONG XBTUSDT pays · Red = flip the legs
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2">
            {loading && !data ? (
              <Skeleton className="h-[300px] w-full bg-gray-700" />
            ) : (
              <ResponsiveContainer width="100%" height={300} debounce={0}>
                <BarChart data={visibleSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(t) => format(new Date(t), "MMM d")}
                    tick={{ fontSize: 12, fill: tickColor }}
                    stroke={tickColor}
                    minTickGap={50}
                  />
                  <YAxis
                    tickFormatter={(v) => formatPercent(v)}
                    tick={{ fontSize: 12, fill: tickColor }}
                    stroke={tickColor}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{ background: "#1a1f2e", border: "1px solid #374151", borderRadius: 6 }}
                    labelFormatter={(t) => format(new Date(t as number), "MMM d, HH:mm")}
                    formatter={(v: number) => [formatPercent(v), "Spread"]}
                    isAnimationActive={false}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
                  <Bar dataKey="spreadAPR" isAnimationActive={false}>
                    {visibleSeries.map((d) => (
                      <Cell key={d.ts} fill={d.spreadAPR >= 0 ? COLORS.spreadGreen : COLORS.spreadRed} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Raw funding APRs — secondary, collapsed by default */}
        <details className="group">
          <summary className="cursor-pointer select-none text-sm text-gray-400 hover:text-gray-200 px-1 py-1">
            ▸ Show raw funding rates for each leg
          </summary>
          <Card className="bg-[#1a1f2e] border-gray-800 mt-3">
            <CardHeader>
              <CardTitle className="text-base font-medium text-gray-200">
                Funding APR — XBTUSD vs XBTUSDT
              </CardTitle>
            </CardHeader>
            <CardContent className="px-2">
              {loading && !data ? (
                <Skeleton className="h-[300px] w-full bg-gray-700" />
              ) : (
                <ResponsiveContainer width="100%" height={300} debounce={0}>
                  <LineChart data={visibleSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                    <XAxis
                      dataKey="ts"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(t) => format(new Date(t), "MMM d")}
                      tick={{ fontSize: 12, fill: tickColor }}
                      stroke={tickColor}
                      minTickGap={50}
                    />
                    <YAxis
                      tickFormatter={(v) => formatPercent(v)}
                      tick={{ fontSize: 12, fill: tickColor }}
                      stroke={tickColor}
                      width={70}
                    />
                    <Tooltip
                      contentStyle={{ background: "#1a1f2e", border: "1px solid #374151", borderRadius: 6 }}
                      labelFormatter={(t) => format(new Date(t as number), "MMM d, HH:mm")}
                      formatter={(v: number, name: string) => [formatPercent(v), name]}
                      isAnimationActive={false}
                    />
                    <Legend wrapperStyle={{ fontSize: "13px", paddingTop: "10px" }} />
                    <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="btcAPR" name="XBTUSD APR" stroke={COLORS.btc} strokeWidth={1.8} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="usdtAPR" name="XBTUSDT APR" stroke={COLORS.usdt} strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </details>
      </div>
    </div>
  );
}
