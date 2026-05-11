import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetArbSummary, useGetArbDetail, getArbLive, getArbSummaryLive, getGetArbSummaryQueryKey, getGetArbDetailQueryKey } from "@workspace/api-client-react";
import type { ArbPairSummary, ArbLiveResponse, BookLevel } from "@workspace/api-client-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Area, ReferenceLine
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, TrendingUp, AlertTriangle, Info, X } from "lucide-react";
import { format } from "date-fns";

const CHART_COLORS = {
  bitmex: "#FF6D00",
  hl: "#2962FF",
  spreadGreen: "#16a34a",
  spreadRed: "#dc2626",
  purple: "#9C27B0"
};

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value / 100);
}

function formatPercent2(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);
}

function formatBreakeven(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !isFinite(hours)) return "∞";
  if (hours < 1) return `${(hours * 60).toFixed(0)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function netEdgeColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-gray-500";
  if (v > 30) return "text-green-400";
  if (v > 0) return "text-green-300";
  if (v > -20) return "text-yellow-400";
  return "text-red-400";
}

function formatUsdCompact(v: number): string {
  if (!isFinite(v) || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v).toLocaleString()}`;
}

function OrderbookPanel({
  venue, symbol, bids, asks, accentColor, priceDecimals = 4,
}: {
  venue: string;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  accentColor: string;
  priceDecimals?: number;
}) {
  // Cumulative totals in USD notional, summed from best outward (closest-to-spread first).
  const bidsWithTotal = useMemo(() => {
    let cum = 0;
    return bids.map((l) => { cum += l.px * l.size; return { ...l, totalUsd: cum, sizeUsd: l.px * l.size }; });
  }, [bids]);
  const asksWithTotal = useMemo(() => {
    let cum = 0;
    return asks.map((l) => { cum += l.px * l.size; return { ...l, totalUsd: cum, sizeUsd: l.px * l.size }; });
  }, [asks]);

  // Max USD size on either side — used to scale the depth bar width.
  const maxSizeUsd = useMemo(() => {
    const all = [...bidsWithTotal, ...asksWithTotal].map((l) => l.sizeUsd);
    return all.length ? Math.max(...all) : 1;
  }, [bidsWithTotal, asksWithTotal]);

  const fmtPrice = (px: number) => px.toLocaleString(undefined, { maximumFractionDigits: priceDecimals });
  const bestAsk = asks[0]?.px ?? 0;
  const bestBid = bids[0]?.px ?? 0;
  const spreadPct = (bestAsk > 0 && bestBid > 0) ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100 : 0;

  // Render asks top-down with lowest (best) at the bottom, just above the spread line.
  const asksDisplay = [...asksWithTotal].reverse();

  const Row = ({ px, sizeUsd, totalUsd, isBid }: { px: number; sizeUsd: number; totalUsd: number; isBid: boolean }) => {
    const barPct = Math.min(100, (sizeUsd / maxSizeUsd) * 100);
    const barColor = isBid ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";
    const priceColor = isBid ? "text-green-400" : "text-red-400";
    return (
      <div className="relative grid grid-cols-3 gap-2 py-0.5 px-1 text-xs font-mono">
        <div className="absolute inset-y-0 right-0 pointer-events-none" style={{ width: `${barPct}%`, background: barColor }} />
        <span className={`relative z-10 ${priceColor}`}>{fmtPrice(px)}</span>
        <span className="relative z-10 text-right text-gray-300">{formatUsdCompact(sizeUsd)}</span>
        <span className="relative z-10 text-right text-gray-500">{formatUsdCompact(totalUsd)}</span>
      </div>
    );
  };

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: `${accentColor}33`, background: `${accentColor}08` }}>
      <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: accentColor }}>
        {venue} {symbol}
      </p>
      <div className="grid grid-cols-3 gap-2 text-[10px] text-gray-500 px-1 pb-1 border-b border-gray-800">
        <span>Price</span>
        <span className="text-right">Size (USD)</span>
        <span className="text-right">Total (USD)</span>
      </div>
      <div className="mt-1">
        {asksDisplay.map((l, i) => (
          <Row key={`a${i}`} px={l.px} sizeUsd={l.sizeUsd} totalUsd={l.totalUsd} isBid={false} />
        ))}
      </div>
      <div className="flex items-center justify-between my-1 px-1 py-1 border-y border-gray-800 text-[11px] font-mono">
        <span className="text-gray-400">Spread</span>
        <span className="text-gray-200">{(bestAsk - bestBid).toLocaleString(undefined, { maximumFractionDigits: priceDecimals })}</span>
        <span className="text-gray-400">{formatPercent2(spreadPct)}</span>
      </div>
      <div>
        {bidsWithTotal.map((l, i) => (
          <Row key={`b${i}`} px={l.px} sizeUsd={l.sizeUsd} totalUsd={l.totalUsd} isBid={true} />
        ))}
      </div>
    </div>
  );
}

function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function directionLabel(s: string): string {
  if (s === "LONG_BITMEX_SHORT_HL") return "LONG BITMEX / SHORT HL";
  if (s === "LONG_HL_SHORT_BITMEX") return "LONG HL / SHORT BITMEX";
  return "NEUTRAL";
}

function TopPickCard({
  title, subtitle, pair, loading, onClick, highlight, badge, emptyCopy,
}: {
  title: string;
  subtitle: string;
  pair: ArbPairSummary | null;
  loading: boolean;
  onClick: (pairId: string) => void;
  highlight?: "edge" | "consistency";
  badge?: string;
  emptyCopy: string;
}) {
  if (loading && !pair) {
    return (
      <Card className="bg-[#1a1f2e] border-gray-800">
        <CardContent className="p-6">
          <p className="text-sm text-gray-400">{title}</p>
          <Skeleton className="h-8 w-48 mt-2 bg-gray-700" />
          <Skeleton className="h-4 w-32 mt-2 bg-gray-700" />
        </CardContent>
      </Card>
    );
  }
  if (!pair) {
    return (
      <Card className="bg-[#1a1f2e] border-gray-800">
        <CardContent className="p-6">
          <p className="text-sm text-gray-400">{title}</p>
          <p className="text-sm text-gray-500 mt-3 italic">{emptyCopy}</p>
        </CardContent>
      </Card>
    );
  }
  const isEdge = highlight !== "consistency";
  const primaryValue = isEdge ? pair.netAPR7d : pair.consistency14d;
  const primaryLabel = isEdge ? "Net 7d APR" : "14d hit rate";
  return (
    <Card
      className="bg-[#1a1f2e] border-gray-800 cursor-pointer hover:bg-[#22283a] transition-colors"
      onClick={() => onClick(pair.pairId)}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-400">{title}</p>
              {badge && (
                <span className="text-[10px] font-semibold uppercase tracking-wider bg-green-500/20 text-green-400 border border-green-500/40 rounded px-1.5 py-0.5">
                  {badge}
                </span>
              )}
            </div>
            <p className="text-xl font-bold mt-1 truncate text-gray-100">{pair.name}</p>
            <p className="text-[11px] text-gray-500 mt-0.5 truncate">{directionLabel(pair.suggestion)}</p>
          </div>
          <div className="text-right shrink-0">
            <p className={`text-2xl font-bold font-mono ${isEdge ? netEdgeColor(primaryValue) : "text-gray-100"}`}>
              {isEdge
                ? (primaryValue === null || primaryValue === undefined ? "—" : formatPercent(primaryValue))
                : `${(primaryValue ?? 0).toFixed(1)}%`}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">{primaryLabel}</p>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800 text-xs text-gray-400">
          <span className="text-[11px] text-gray-500">{subtitle}</span>
          <span className="flex items-center gap-3 font-mono">
            {isEdge ? (
              <span>hit {(pair.consistency14d ?? 0).toFixed(0)}%</span>
            ) : (
              <span className={netEdgeColor(pair.netAPR7d)}>{pair.netAPR7d === null || pair.netAPR7d === undefined ? "—" : formatPercent(pair.netAPR7d)}</span>
            )}
            <span>b/e {formatBreakeven(pair.breakevenHours)}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(dateStr: string, fmt = "MMM d, HH:mm"): string {
  if (!dateStr) return "";
  return format(new Date(dateStr), fmt);
}

interface TooltipEntry {
  name?: string;
  value?: number | string | null;
  color?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        backgroundColor: "#1a1f2e",
        borderRadius: "6px",
        padding: "10px 14px",
        border: "1px solid #2a2f3e",
        color: "#f3f4f6",
        fontSize: "13px",
      }}
    >
      <div style={{ marginBottom: "6px", fontWeight: 500 }}>
        {label}
      </div>
      {payload.map((entry, index) => {
        if (entry.value === null || entry.value === undefined) return null;
        return (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" }}>
            {entry.color && entry.color !== "#ffffff" && (
              <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", backgroundColor: entry.color, flexShrink: 0 }} />
            )}
            <span style={{ color: "#9ca3af" }}>{entry.name}</span>
            <span style={{ marginLeft: "auto", fontWeight: 600 }}>
              {typeof entry.value === "number" ? formatPercent(entry.value) : entry.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, dataUpdatedAt } = useGetArbSummary({
    query: { queryKey: getGetArbSummaryQueryKey(), refetchInterval: 300_000 }
  });
  const summaryData = data?.pairs || [];

  // Main Refresh button: calls /api/arb/summary/live which fans out live fetches
  // for all pairs (fresh orderbooks + current funding) and returns recomputed summaries.
  // Historical fields (consistency/annYield/timeSeries) are carried over from the last
  // cron refresh — this endpoint only updates current-snapshot fields.
  const [refreshLive, setRefreshLive] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const onRefreshLive = async () => {
    if (refreshLive) return;
    setRefreshLive(true);
    setRefreshError(null);
    try {
      const fresh = await getArbSummaryLive();
      queryClient.setQueryData(getGetArbSummaryQueryKey(), fresh);
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      if (status === 429) {
        const retryAfter = (e as { headers?: Headers })?.headers?.get?.("retry-after");
        setRefreshError(`Rate limited — try again in ${retryAfter ? `${retryAfter}s` : "a few seconds"}.`);
      } else {
        setRefreshError(e instanceof Error ? e.message : "Refresh failed");
      }
    } finally {
      setRefreshLive(false);
    }
  };

  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "netAPR7d", desc: true }
  ]);

  const columns = useMemo<ColumnDef<ArbPairSummary>[]>(() => [
    {
      accessorKey: "name",
      header: "Asset Name",
      cell: ({ row }) => (
        <div>
          <div className="font-semibold text-gray-100">{row.original.name}</div>
          {row.original.bitmexOpenInterestUsdt > 0 && (
            <div className="text-[11px] text-gray-500 mt-0.5">
              OI ${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(row.original.bitmexOpenInterestUsdt)} USDT
            </div>
          )}
        </div>
      )
    },
    {
      accessorKey: "bitmexCurrentAPR",
      header: "BitMEX APR",
      cell: ({ row }) => <span className="font-mono text-orange-400">{formatPercent(row.original.bitmexCurrentAPR)}</span>
    },
    {
      accessorKey: "hlCurrentAPR",
      header: "HL APR",
      cell: ({ row }) => <span className="font-mono text-blue-400">{formatPercent(row.original.hlCurrentAPR)}</span>
    },
    {
      accessorKey: "totalCostPct",
      header: "Entry Cost",
      cell: ({ row }) => {
        const r = row.original;
        if (r.totalCostPct === null || r.totalCostPct === undefined) {
          return <span className="font-mono text-gray-500">—</span>;
        }
        const isPaidEntry = r.totalCostPct < 0;
        const mainColor = isPaidEntry ? "text-green-400" : "text-gray-100";
        const basis = r.favorableBasisPct;
        let breakdown: string;
        if (basis !== null && basis !== undefined) {
          const basisStr = basis >= 0
            ? `− basis ${formatPercent2(basis)}`
            : `+ basis ${formatPercent2(-basis)}`;
          breakdown = `spread ${formatPercent2(r.crossingCostPct ?? 0)} + fees ${formatPercent2(r.feeCostPct)} ${basisStr}`;
        } else {
          breakdown = `spread ${formatPercent2(r.crossingCostPct ?? 0)} + fees ${formatPercent2(r.feeCostPct)}`;
        }
        return (
          <div className="space-y-0.5 font-mono text-sm">
            <div className={`font-semibold ${mainColor}`}>
              {isPaidEntry ? `−${formatPercent2(-r.totalCostPct)}` : formatPercent2(r.totalCostPct)}
            </div>
            <div className="text-[10px] text-gray-500">{breakdown}</div>
            <div className="text-[11px] text-gray-400">
              {isPaidEntry ? "paid to enter" : `b/e ${formatBreakeven(r.breakevenHours)}`}
            </div>
          </div>
        );
      }
    },
    {
      accessorKey: "netAPR7d",
      header: "Net APR",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="space-y-0.5 font-mono text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 w-6">1d</span>
              <span className={netEdgeColor(r.netAPR1d)}>
                {r.netAPR1d === null || r.netAPR1d === undefined ? "—" : formatPercent(r.netAPR1d)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400 w-6">7d</span>
              <span className={`font-semibold ${netEdgeColor(r.netAPR7d)}`}>
                {r.netAPR7d === null || r.netAPR7d === undefined ? "—" : formatPercent(r.netAPR7d)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 w-6">30d</span>
              <span className={netEdgeColor(r.netAPR30d)}>
                {r.netAPR30d === null || r.netAPR30d === undefined ? "—" : formatPercent(r.netAPR30d)}
              </span>
            </div>
          </div>
        );
      }
    },
    {
      accessorKey: "consistency14d",
      header: "Hit Rate",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="space-y-0.5 font-mono text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 w-6">7d</span>
              <span>{(r.consistency7d ?? 0).toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-400 w-6">14d</span>
              <span className="font-semibold text-gray-100">{(r.consistency14d ?? r.consistencyScore ?? 0).toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 w-6">30d</span>
              <span>{(r.consistency30d ?? 0).toFixed(1)}%</span>
            </div>
          </div>
        );
      }
    },
    {
      accessorKey: "suggestion",
      header: "Suggestion",
      cell: ({ row }) => {
        const r = row.original;
        const sugg = r.suggestion;
        const flipped = sugg !== "NEUTRAL" && (r.consistency14d ?? 50) < 50;
        let badge;
        if (sugg === "LONG_BITMEX_SHORT_HL") {
          badge = <Badge className="bg-green-500/20 text-green-400 hover:bg-green-500/30 border-green-500/50">LONG BITMEX / SHORT HL</Badge>;
        } else if (sugg === "LONG_HL_SHORT_BITMEX") {
          badge = <Badge className="bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border-yellow-500/50">LONG HL / SHORT BITMEX</Badge>;
        } else {
          badge = <Badge variant="outline" className="text-gray-400">NEUTRAL</Badge>;
        }
        return (
          <div className="space-y-1">
            {badge}
            {flipped && (
              <div className="text-[10px] text-amber-400 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                recently flipped
              </div>
            )}
          </div>
        );
      }
    }
  ], []);

  const table = useReactTable({
    data: summaryData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const actionable = summaryData.filter(d => (d.netAPR7d ?? -Infinity) > 0);
  const actionablePairs = actionable.length;

  // Top Pick ranking: pairs with negative entry cost first (basis covers costs — pure arb,
  // you're paid to enter). Among those, pick the one with highest 7d net APR.
  // Otherwise fall back to highest net APR among tradeable.
  const paidEntryPairs = actionable.filter(d => (d.totalCostPct ?? 0) < 0);
  const topPickPair = paidEntryPairs.length
    ? paidEntryPairs.reduce((a, b) => ((b.netAPR7d ?? 0) > (a.netAPR7d ?? 0) ? b : a))
    : actionable.length
      ? actionable.reduce((a, b) => ((b.netAPR7d ?? 0) > (a.netAPR7d ?? 0) ? b : a))
      : null;
  const topPickIsPaidEntry = !!topPickPair && (topPickPair.totalCostPct ?? 0) < 0;

  const mostReliablePair = actionable.length
    ? actionable.reduce((a, b) => ((b.consistency14d ?? 0) > (a.consistency14d ?? 0) ? b : a))
    : null;
  const avgSpread = summaryData.length ? summaryData.reduce((acc, d) => acc + d.fundingSpread, 0) / summaryData.length : 0;
  const avgConsistency = summaryData.length ? summaryData.reduce((acc, d) => acc + d.consistencyScore, 0) / summaryData.length : 0;

  const lastRefreshed = dataUpdatedAt
    ? (() => {
        const d = new Date(dataUpdatedAt);
        return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false });
      })()
    : null;

  const loading = isLoading || isFetching;

  return (
    <div className="min-h-screen bg-[#0f111a] text-gray-200 px-5 py-4 pt-[32px] pb-[32px] pl-[24px] pr-[24px]">
      <div className="max-w-[1400px] mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="pt-2">
            <h1 className="font-bold text-[32px] flex items-center gap-3">
              <span className="text-[#FF6D00]">BitMEX</span>
              <span>TradFi Perps Arbitrage Monitor</span>
            </h1>
            <p className="text-gray-400 mt-1.5 text-[14px]">TradFi Arbitrage, Exclusively on BitMEX</p>
          </div>
          <div className="flex flex-col items-end gap-2 pt-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">Cron every 10 min · click to force-refresh now</span>
              <button
                onClick={onRefreshLive}
                disabled={refreshLive}
                className="flex items-center gap-1 px-3 py-1.5 h-[32px] rounded border border-gray-700 bg-gray-800 text-sm hover:bg-gray-700 transition-colors disabled:opacity-50 text-gray-300"
                title="Fan out live fetches across all pairs (orderbooks + current funding). Takes ~3 seconds. Rate-limited to one call every 15s server-wide."
              >
                <RefreshCw className={`w-4 h-4 ${refreshLive ? "animate-spin" : ""}`} />
                {refreshLive ? "Refreshing…" : "Refresh all"}
              </button>
            </div>
            {refreshError ? (
              <p className="text-[12px] text-amber-400">{refreshError}</p>
            ) : lastRefreshed ? (
              <p className="text-[12px] text-gray-500">Last update: {lastRefreshed}</p>
            ) : null}
          </div>
        </div>

        {/* Global KPI Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-6">
              <p className="text-sm text-gray-400">Tradeable Now</p>
              <p className="text-[11px] text-gray-500 -mt-0.5">net APR positive on 7-day hold</p>
              {loading && !summaryData.length ? (
                <Skeleton className="h-8 w-16 mt-1 bg-gray-700" />
              ) : (
                <p className="text-3xl font-bold mt-1 text-green-400">{actionablePairs} <span className="text-lg text-gray-500 font-normal">/ {summaryData.length}</span></p>
              )}
            </CardContent>
          </Card>
          <TopPickCard
            title="Top Pick"
            subtitle={topPickIsPaidEntry ? "paid to enter · basis covers entry + fees" : "highest net APR among tradeable"}
            pair={topPickPair}
            loading={loading}
            onClick={(id) => setSelectedPairId(id)}
            badge={topPickIsPaidEntry ? "Paid Entry" : undefined}
            emptyCopy="No pair is currently profitable on a 7-day hold"
          />
          <TopPickCard
            title="Most Reliable"
            subtitle="highest 14d hit rate among tradeable"
            pair={mostReliablePair}
            loading={loading}
            onClick={(id) => setSelectedPairId(id)}
            highlight="consistency"
            emptyCopy="No tradeable pair to rank by reliability"
          />
        </div>

        {/* Summary Table */}
        <Card className="bg-[#1a1f2e] border-gray-800">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} className="border-gray-800 hover:bg-transparent">
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} onClick={header.column.getToggleSortingHandler()} className="cursor-pointer select-none text-gray-400 font-semibold h-12 bg-[#141824]">
                        <div className="flex items-center gap-2">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? null}
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {loading && !summaryData.length ? (
                  [...Array(9)].map((_, i) => (
                    <TableRow key={i} className="border-gray-800">
                      {[...Array(7)].map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-5 w-full bg-gray-800" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className="border-gray-800 cursor-pointer hover:bg-[#22283a] transition-colors"
                      onClick={() => setSelectedPairId(row.original.pairId)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="py-3">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
                {!loading && summaryData.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-gray-500">
                      No arbitrage data available.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

      </div>

      {/* Detail View Slide-over */}
      {selectedPairId && (
        <DetailView
          pairId={selectedPairId}
          onClose={() => setSelectedPairId(null)}
          summary={summaryData.find(d => d.pairId === selectedPairId)}
        />
      )}
    </div>
  );
}

function DetailView({ pairId, onClose, summary }: { pairId: string, onClose: () => void, summary?: ArbPairSummary }) {
  const { data, isLoading, isFetching } = useGetArbDetail(pairId, {
    query: {
      enabled: !!pairId,
      queryKey: getGetArbDetailQueryKey(pairId),
      refetchInterval: 300_000,
    }
  });

  const loading = isLoading || isFetching;
  const detailSummary = data?.summary || summary;

  // Live refresh state — orderbook + current funding refetched on demand.
  // Backend rate-limits to 1 call per 10s per pair; UI shows the retry message on 429.
  const [liveData, setLiveData] = useState<ArbLiveResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  // Clear live overlay whenever the user switches pairs.
  useEffect(() => {
    setLiveData(null);
    setLiveError(null);
  }, [pairId]);

  const onRefreshPair = async () => {
    if (liveLoading) return;
    setLiveLoading(true);
    setLiveError(null);
    try {
      const fresh = await getArbLive(pairId);
      setLiveData(fresh);
    } catch (e) {
      const status = (e as { status?: number } | undefined)?.status;
      if (status === 429) {
        const retryAfter = (e as { headers?: Headers })?.headers?.get?.("retry-after");
        setLiveError(`Rate limited — try again in ${retryAfter ? `${retryAfter}s` : "a few seconds"}.`);
      } else {
        setLiveError(e instanceof Error ? e.message : "Refresh failed");
      }
    } finally {
      setLiveLoading(false);
    }
  };

  const rawSeries = data?.timeSeries || [];

  const timeSeries = useMemo(() => {
    const series = rawSeries.length <= 200
      ? rawSeries
      : rawSeries.filter((_, i) => i % Math.floor(rawSeries.length / 200) === 0);
    return series.map(pt => ({
      ...pt,
      spreadNeg: pt.fundingSpread < 0 ? pt.fundingSpread : null,
      spreadPos: pt.fundingSpread >= 0 ? pt.fundingSpread : null,
    }));
  }, [rawSeries]);

  const annualizedYield = detailSummary ? detailSummary.annYield14d : 0;

  const gridColor = "rgba(255,255,255,0.05)";
  const tickColor = "#6b7280";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-[800px] h-full bg-[#0f111a] border-l border-gray-800 flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-[#141824]">
          <div>
            <h2 className="text-2xl font-bold text-gray-100">
              {detailSummary?.name || "Asset Details"}
            </h2>
            <div className="text-sm text-gray-400 mt-1 flex items-center gap-4">
              <span><span className="text-[#FF6D00] font-medium">BitMEX:</span> {detailSummary?.bitmexSymbol}</span>
              <span><span className="text-[#2962FF] font-medium">HL:</span> {detailSummary?.hlSymbol}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full text-gray-400 hover:text-gray-100 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Current APR Side-by-Side */}
          {detailSummary && (
            <div className="grid grid-cols-2 gap-4">
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardContent className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "#FF6D00" }}>BitMEX APR</p>
                  <p className={`text-2xl font-bold font-mono mt-1 ${detailSummary.bitmexCurrentAPR < 0 ? "text-green-400" : detailSummary.bitmexCurrentAPR > 0 ? "text-red-400" : "text-gray-300"}`}>
                    {formatPercent(detailSummary.bitmexCurrentAPR)}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{detailSummary.bitmexSymbol}</p>
                </CardContent>
              </Card>
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardContent className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "#2962FF" }}>Hyperliquid APR</p>
                  <p className={`text-2xl font-bold font-mono mt-1 ${detailSummary.hlCurrentAPR < 0 ? "text-green-400" : detailSummary.hlCurrentAPR > 0 ? "text-red-400" : "text-gray-300"}`}>
                    {formatPercent(detailSummary.hlCurrentAPR)}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{detailSummary.hlSymbol}</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Suggestion Card */}
          {detailSummary && (
            <Card className={`border ${detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" ? "border-green-500/30 bg-green-500/5" : detailSummary.suggestion === "LONG_HL_SHORT_BITMEX" ? "border-yellow-500/30 bg-yellow-500/5" : "border-gray-800 bg-[#1a1f2e]"}`}>
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  {detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" ? (
                    <TrendingUp className="w-8 h-8 text-green-500 mt-1 shrink-0" />
                  ) : detailSummary.suggestion === "LONG_HL_SHORT_BITMEX" ? (
                    <TrendingUp className="w-8 h-8 text-yellow-500 mt-1 shrink-0" />
                  ) : (
                    <Info className="w-8 h-8 text-gray-500 mt-1 shrink-0" />
                  )}
                  <div>
                    <h3 className="text-lg font-bold text-gray-100">
                      {detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" ? "LONG BitMEX / SHORT Hyperliquid" :
                       detailSummary.suggestion === "LONG_HL_SHORT_BITMEX" ? "LONG Hyperliquid / SHORT BitMEX" :
                       "Wait for better entry"}
                    </h3>
                    {detailSummary.suggestion !== "NEUTRAL" && detailSummary.consistency14d < 50 && (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span>Direction flipped vs 14-day majority — higher regime-change risk</span>
                      </div>
                    )}
                    <div className="mt-3 space-y-2 text-sm text-gray-300">
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: "7-Day", yield: detailSummary.annYield7d, cons: detailSummary.consistency7d },
                          { label: "14-Day", yield: detailSummary.annYield14d, cons: detailSummary.consistency14d },
                          { label: "30-Day", yield: detailSummary.annYield30d, cons: detailSummary.consistency30d },
                        ].map(({ label, yield: y, cons }) => (
                          <div key={label} className="bg-black/20 rounded-lg p-3">
                            <p className="text-xs text-gray-500 mb-1">{label}</p>
                            <p className="font-mono font-bold text-green-400">{formatPercent(y)}</p>
                            <p className="text-xs text-gray-400 mt-1">Ann. Yield</p>
                            <p className="font-mono font-semibold text-gray-200 mt-1">{cons.toFixed(1)}%</p>
                            <p className="text-xs text-gray-500">Hit Rate</p>
                          </div>
                        ))}
                      </div>
                      {detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" && (
                        <p className="text-green-400 mt-2 text-xs">
                          BitMEX has been the lower-cost venue {detailSummary.consistency14d.toFixed(1)}% of the time over the last 14 days.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Promote BitMEX Banner */}
          {detailSummary && detailSummary.consistency14d > 60 && detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" && (
            <div className="bg-[#FF6D00]/10 border border-[#FF6D00]/30 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#FF6D00] shrink-0 mt-0.5" />
              <p className="text-sm text-[#FF6D00]">
                <strong className="font-semibold">BitMEX Advantage:</strong> BitMEX has been the consistent low-cost venue for {detailSummary.consistency14d.toFixed(1)}% of the last 14 days — use BitMEX as your long leg to capture this spread.
              </p>
            </div>
          )}

          {/* Orderbook (5 levels per side, live-refreshable) */}
          {detailSummary && ((liveData?.bmexBids ?? detailSummary.bmexBids) || (liveData?.hlBids ?? detailSummary.hlBids)) && (() => {
            const src = liveData ?? detailSummary;
            const bmexBids = (liveData ? liveData.bmexBids : detailSummary.bmexBids) ?? [];
            const bmexAsks = (liveData ? liveData.bmexAsks : detailSummary.bmexAsks) ?? [];
            const hlBids = (liveData ? liveData.hlBids : detailSummary.hlBids) ?? [];
            const hlAsks = (liveData ? liveData.hlAsks : detailSummary.hlAsks) ?? [];
            const asOf = liveData ? liveData.fetchedAt : detailSummary.lastUpdated;
            return (
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardHeader className="pb-2 px-4 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base font-medium text-gray-200">
                      Orderbook · {liveData ? "live" : "snapshot"}
                      <span className="text-xs font-normal text-gray-500 ml-2">
                        {asOf ? `as of ${formatTimeAgo(asOf)}` : ""} · prices differ between venues for ETF/index pairs (e.g. SPY vs SP500)
                      </span>
                    </CardTitle>
                    <button
                      onClick={onRefreshPair}
                      disabled={liveLoading}
                      className="flex items-center gap-1.5 px-3 py-1 h-[28px] rounded border border-gray-700 bg-gray-800 text-xs hover:bg-gray-700 transition-colors disabled:opacity-50 text-gray-300 shrink-0"
                      title="Fetch fresh orderbook + current funding for this pair. Rate-limited to one call per 10 seconds."
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${liveLoading ? "animate-spin" : ""}`} />
                      {liveLoading ? "Fetching…" : "Refresh this pair"}
                    </button>
                  </div>
                  {liveError && (
                    <p className="text-[11px] text-amber-400 mt-1">{liveError}</p>
                  )}
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="grid grid-cols-2 gap-4">
                    {bmexBids.length && bmexAsks.length ? (
                      <OrderbookPanel
                        venue="BitMEX"
                        symbol={src.bitmexSymbol}
                        bids={bmexBids}
                        asks={bmexAsks}
                        accentColor="#FF6D00"
                      />
                    ) : (
                      <div className="rounded-lg border border-gray-800 p-3 text-xs text-gray-500">BitMEX book unavailable</div>
                    )}
                    {hlBids.length && hlAsks.length ? (
                      <OrderbookPanel
                        venue="Hyperliquid"
                        symbol={src.hlSymbol}
                        bids={hlBids}
                        asks={hlAsks}
                        accentColor="#2962FF"
                      />
                    ) : (
                      <div className="rounded-lg border border-gray-800 p-3 text-xs text-gray-500">Hyperliquid book unavailable</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {detailSummary && detailSummary.totalCostPct !== null && detailSummary.totalCostPct !== undefined && (
            <Card className="bg-[#1a1f2e] border-gray-800">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-base font-medium text-gray-200 flex items-center gap-2">
                  Execution Economics
                  <div className="group relative">
                    <Info className="w-3.5 h-3.5 text-gray-500 cursor-help" />
                    <div className="absolute left-0 top-full mt-2 w-80 hidden group-hover:block bg-gray-900 text-gray-300 text-xs rounded-md px-3 py-2 border border-gray-700 shadow-lg z-10">
                      Round-trip cost = spread crossings (4 legs) + taker fees − favorable basis at entry.
                      Basis is the price gap between venues. When funding normalizes (the trade's thesis),
                      basis closes too — so the entry gap is captured as profit. For ETF vs index pairs
                      (SPY/SP500, QQQ/Nasdaq100) the basis isn't economically meaningful and is excluded.
                    </div>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-4 gap-3 text-sm">
                  <div className="bg-black/20 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">Spread cost</p>
                    <p className="font-mono font-bold text-gray-100">{formatPercent2(detailSummary.crossingCostPct ?? 0)}</p>
                    <p className="text-[10px] text-gray-500 mt-1">both venues, round-trip</p>
                  </div>
                  <div className="bg-black/20 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">Fees</p>
                    <p className="font-mono font-bold text-gray-100">{formatPercent2(detailSummary.feeCostPct)}</p>
                    <p className="text-[10px] text-gray-500 mt-1">4 taker crossings</p>
                  </div>
                  <div className="bg-black/20 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">Basis @ entry</p>
                    {detailSummary.favorableBasisPct === null || detailSummary.favorableBasisPct === undefined ? (
                      <>
                        <p className="font-mono font-bold text-gray-500">—</p>
                        <p className="text-[10px] text-gray-500 mt-1">scale-mismatched</p>
                      </>
                    ) : detailSummary.favorableBasisPct >= 0 ? (
                      <>
                        <p className="font-mono font-bold text-green-400">−{formatPercent2(detailSummary.favorableBasisPct)}</p>
                        <p className="text-[10px] text-green-500 mt-1">favorable</p>
                      </>
                    ) : (
                      <>
                        <p className="font-mono font-bold text-red-400">+{formatPercent2(-detailSummary.favorableBasisPct)}</p>
                        <p className="text-[10px] text-red-500 mt-1">unfavorable</p>
                      </>
                    )}
                  </div>
                  <div className={`rounded-lg p-3 border ${detailSummary.totalCostPct < 0 ? "bg-green-500/10 border-green-500/30" : "bg-black/20 border-transparent"}`}>
                    <p className="text-xs text-gray-500 mb-1">Total entry+exit</p>
                    <p className={`font-mono font-bold ${detailSummary.totalCostPct < 0 ? "text-green-400" : "text-gray-100"}`}>
                      {detailSummary.totalCostPct < 0 ? `−${formatPercent2(-detailSummary.totalCostPct)}` : formatPercent2(detailSummary.totalCostPct)}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-1">
                      {detailSummary.totalCostPct < 0 ? "paid to enter — profitable before any funding" : `b/e: ${formatBreakeven(detailSummary.breakevenHours)}`}
                    </p>
                  </div>
                </div>
                {detailSummary.favorableBasisPct !== null && detailSummary.favorableBasisPct !== undefined && (
                  <p className="text-xs text-gray-500 italic">
                    Assumes basis closes to ~0 at exit (correlated with funding normalization).
                    Conservative cost without this assumption: {formatPercent2((detailSummary.crossingCostPct ?? 0) + detailSummary.feeCostPct)}.
                  </p>
                )}
                <div>
                  <p className="text-xs text-gray-500 mb-2">Net APR (gross funding minus cost, amortized over hold period):</p>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "1-Day", val: detailSummary.netAPR1d, note: "close within 24h" },
                      { label: "7-Day", val: detailSummary.netAPR7d, note: "close within a week" },
                      { label: "30-Day", val: detailSummary.netAPR30d, note: "close within a month" },
                    ].map(({ label, val, note }) => (
                      <div key={label} className="bg-black/20 rounded-lg p-3">
                        <p className="text-xs text-gray-500 mb-1">{label}</p>
                        <p className={`font-mono font-bold text-lg ${netEdgeColor(val)}`}>
                          {val === null || val === undefined ? "—" : formatPercent(val)}
                        </p>
                        <p className="text-[10px] text-gray-500 mt-1">{note}</p>
                      </div>
                    ))}
                  </div>
                </div>
                {detailSummary.netAPR7d !== null && detailSummary.netAPR7d !== undefined && detailSummary.netAPR7d > 0 ? (
                  <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/30 rounded-lg p-2">
                    <TrendingUp className="w-4 h-4 shrink-0" />
                    <span>Actionable: current funding spread more than pays back entry+exit within a 7-day hold.</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Not actionable on a 7-day horizon — cost exceeds the expected funding earnings over a week.</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Charts */}
          {loading ? (
            <div className="space-y-6">
              <Skeleton className="w-full h-[300px] bg-gray-800" />
              <Skeleton className="w-full h-[300px] bg-gray-800" />
              <Skeleton className="w-full h-[300px] bg-gray-800" />
            </div>
          ) : timeSeries.length > 0 ? (
            <div className="space-y-6">

              {/* 1. Funding Rate Comparison */}
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardHeader className="pb-2 px-4 pt-4">
                  <CardTitle className="text-base font-medium text-gray-200">30-Day Funding Rate Comparison (APR)</CardTitle>
                </CardHeader>
                <CardContent className="px-2">
                  <ResponsiveContainer width="100%" height={300} debounce={0}>
                    <LineChart data={timeSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(d) => formatDate(d, "MMM d")}
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
                      <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ stroke: tickColor, strokeDasharray: '3 3' }} />
                      <Legend wrapperStyle={{ fontSize: '13px', paddingTop: '10px' }} />
                      <Line type="monotone" dataKey="bitmexAPR" name="BitMEX APR" stroke={CHART_COLORS.bitmex} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="hlAPR" name="HL APR" stroke={CHART_COLORS.hl} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* 2. Funding Spread — green when BitMEX cheaper (spread < 0), red when BitMEX pricier (spread > 0) */}
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardHeader className="pb-2 px-4 pt-4">
                  <CardTitle className="text-base font-medium text-gray-200">
                    Funding Spread (BitMEX − HL) <span className="text-xs font-normal text-gray-500 ml-2">Green = BMEX funding lower (LONG_BMEX pays) · Red = BMEX funding higher (LONG_HL pays)</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-2">
                  <ResponsiveContainer width="100%" height={300} debounce={0}>
                    <ComposedChart data={timeSeries}>
                      <defs>
                        <linearGradient id="gradGreen" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={CHART_COLORS.spreadGreen} stopOpacity={0.7}/>
                          <stop offset="95%" stopColor={CHART_COLORS.spreadGreen} stopOpacity={0.05}/>
                        </linearGradient>
                        <linearGradient id="gradRed" x1="0" y1="1" x2="0" y2="0">
                          <stop offset="5%" stopColor={CHART_COLORS.spreadRed} stopOpacity={0.7}/>
                          <stop offset="95%" stopColor={CHART_COLORS.spreadRed} stopOpacity={0.05}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(d) => formatDate(d, "MMM d")}
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
                      <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ stroke: tickColor, strokeDasharray: '3 3' }} />
                      <Legend wrapperStyle={{ fontSize: '13px', paddingTop: '10px' }} />
                      <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
                      <Area
                        type="step"
                        dataKey="spreadNeg"
                        name="BMEX funding lower (LONG_BMEX pays)"
                        stroke={CHART_COLORS.spreadGreen}
                        fill="url(#gradGreen)"
                        isAnimationActive={false}
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Area
                        type="step"
                        dataKey="spreadPos"
                        name="BMEX funding higher (LONG_HL pays)"
                        stroke={CHART_COLORS.spreadRed}
                        fill="url(#gradRed)"
                        isAnimationActive={false}
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* 3. Price Basis */}
              <Card className="bg-[#1a1f2e] border-gray-800">
                <CardHeader className="pb-2 px-4 pt-4">
                  <CardTitle className="text-base font-medium text-gray-200">Price Basis % (BitMEX vs HL)</CardTitle>
                  {(pairId === "6" || pairId === "7") && (
                    <p className="text-xs text-gray-500 mt-1">
                      Note: BitMEX trades the ETF while Hyperliquid tracks the underlying index. The spread shown is normalized to show deviation from the average structural difference.
                    </p>
                  )}
                </CardHeader>
                <CardContent className="px-2">
                  <ResponsiveContainer width="100%" height={300} debounce={0}>
                    <LineChart data={timeSeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={(d) => formatDate(d, "MMM d")}
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
                      <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ stroke: tickColor, strokeDasharray: '3 3' }} />
                      <Legend wrapperStyle={{ fontSize: '13px', paddingTop: '10px' }} />
                      <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="priceSpreadPct" name="Price Basis %" stroke={CHART_COLORS.purple} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

            </div>
          ) : (
            <div className="w-full h-40 flex items-center justify-center text-gray-500 border border-gray-800 rounded-lg">
              No historical data available.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
