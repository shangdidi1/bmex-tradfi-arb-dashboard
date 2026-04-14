import { useState, useEffect, useMemo } from "react";
import { useGetArbSummary, useGetArbDetail, getGetArbSummaryQueryKey, getGetArbDetailQueryKey } from "@workspace/api-client-react";
import type { ArbPairSummary } from "@workspace/api-client-react";
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

function formatDate(dateStr: string, fmt = "MMM d, HH:mm"): string {
  if (!dateStr) return "";
  return format(new Date(dateStr), fmt);
}

function CustomTooltip({ active, payload, label }: any) {
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
      {payload.map((entry: any, index: number) => {
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
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useGetArbSummary({
    query: { queryKey: getGetArbSummaryQueryKey(), refetchInterval: 300_000 }
  });
  const summaryData = data?.pairs || [];

  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "consistencyScore", desc: true }
  ]);

  const columns = useMemo<ColumnDef<ArbPairSummary>[]>(() => [
    {
      accessorKey: "name",
      header: "Asset Name",
      cell: ({ row }) => (
        <div>
          <div className="font-semibold text-gray-100">{row.original.name}</div>
          <div className="text-xs text-gray-500">{row.original.bitmexSymbol} / {row.original.hlSymbol}</div>
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
      accessorKey: "fundingSpread",
      header: "Funding Spread",
      cell: ({ row }) => {
        const val = row.original.fundingSpread;
        const colorClass = val < 0 ? "text-green-500" : (val > 0 ? "text-red-500" : "text-gray-400");
        return <span className={`font-mono ${colorClass}`}>{formatPercent(val)}</span>;
      }
    },
    {
      accessorKey: "priceSpreadPct",
      header: "Price Basis %",
      cell: ({ row }) => <span className="font-mono">{formatPercent(row.original.priceSpreadPct)}</span>
    },
    {
      accessorKey: "consistencyScore",
      header: "Consistency",
      cell: ({ row }) => <span className="font-mono">{row.original.consistencyScore.toFixed(1)}%</span>
    },
    {
      accessorKey: "cumulativeYield",
      header: "Ann. Yield",
      cell: ({ row }) => {
        const annualizedYield = row.original.cumulativeYield * (365 / 14);
        return <span className="font-mono">{formatPercent(annualizedYield)}</span>;
      }
    },
    {
      accessorKey: "suggestion",
      header: "Suggestion",
      cell: ({ row }) => {
        const sugg = row.original.suggestion;
        if (sugg === "LONG_BITMEX_SHORT_HL") {
          return <Badge className="bg-green-500/20 text-green-400 hover:bg-green-500/30 border-green-500/50">LONG BITMEX / SHORT HL</Badge>;
        } else if (sugg === "LONG_HL_SHORT_BITMEX") {
          return <Badge className="bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border-yellow-500/50">LONG HL / SHORT BITMEX</Badge>;
        }
        return <Badge variant="outline" className="text-gray-400">NEUTRAL</Badge>;
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

  const totalLongBitmex = summaryData.filter(d => d.suggestion === "LONG_BITMEX_SHORT_HL").length;
  const avgSpread = summaryData.length ? summaryData.reduce((acc, d) => acc + d.fundingSpread, 0) / summaryData.length : 0;
  const avgConsistency = summaryData.length ? summaryData.reduce((acc, d) => acc + d.consistencyScore, 0) / summaryData.length : 0;

  const lastRefreshed = dataUpdatedAt
    ? (() => {
        const d = new Date(dataUpdatedAt);
        return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false });
      })()
    : null;

  const [isSpinning, setIsSpinning] = useState(false);
  const loading = isLoading || isFetching;

  useEffect(() => {
    if (loading) {
      setIsSpinning(true);
      return;
    }
    const t = setTimeout(() => setIsSpinning(false), 600);
    return () => clearTimeout(t);
  }, [loading]);

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
            <p className="text-gray-400 mt-1.5 text-[14px]">Compare TradFi perpetual contracts with Hyperliquid to find low-cost funding venues.</p>
          </div>
          <div className="flex flex-col items-end gap-2 pt-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">Updates every 5 min</span>
              <button
                onClick={() => refetch()}
                disabled={loading}
                className="flex items-center gap-1 px-3 py-1.5 h-[32px] rounded border border-gray-700 bg-gray-800 text-sm hover:bg-gray-700 transition-colors disabled:opacity-50 text-gray-300"
              >
                <RefreshCw className={`w-4 h-4 ${isSpinning ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {lastRefreshed && <p className="text-[12px] text-gray-500">Last update: {lastRefreshed}</p>}
          </div>
        </div>

        {/* Global KPI Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-6">
              <p className="text-sm text-gray-400">Pairs Favoring BitMEX</p>
              {loading && !summaryData.length ? (
                <Skeleton className="h-8 w-16 mt-1 bg-gray-700" />
              ) : (
                <p className="text-3xl font-bold mt-1 text-green-400">{totalLongBitmex} <span className="text-lg text-gray-500 font-normal">/ {summaryData.length}</span></p>
              )}
            </CardContent>
          </Card>
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-6">
              <p className="text-sm text-gray-400">Average Funding Spread</p>
              {loading && !summaryData.length ? (
                <Skeleton className="h-8 w-24 mt-1 bg-gray-700" />
              ) : (
                <p className={`text-3xl font-bold mt-1 ${avgSpread < 0 ? 'text-green-400' : 'text-red-400'}`}>{formatPercent(avgSpread)}</p>
              )}
            </CardContent>
          </Card>
          <Card className="bg-[#1a1f2e] border-gray-800">
            <CardContent className="p-6">
              <p className="text-sm text-gray-400">Average Consistency</p>
              {loading && !summaryData.length ? (
                <Skeleton className="h-8 w-24 mt-1 bg-gray-700" />
              ) : (
                <p className="text-3xl font-bold mt-1 text-gray-100">{avgConsistency.toFixed(1)}%</p>
              )}
            </CardContent>
          </Card>
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
                      {[...Array(8)].map((_, j) => (
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
                    <TableCell colSpan={8} className="h-24 text-center text-gray-500">
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

  const annualizedYield = detailSummary ? detailSummary.cumulativeYield * (365 / 14) : 0;

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
                    <div className="mt-2 space-y-1 text-sm text-gray-300">
                      <p>Expected Annualized Yield: <span className="font-mono font-bold text-gray-100">{formatPercent(annualizedYield)}</span></p>
                      <p>14-Day Cumulative Yield: <span className="font-mono font-bold text-gray-100">{formatPercent(detailSummary.cumulativeYield)}</span></p>
                      <p>Consistency Score: <span className="font-mono font-bold text-gray-100">{detailSummary.consistencyScore.toFixed(1)}%</span></p>
                      {detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" && (
                        <p className="text-green-400 mt-2">
                          BitMEX has been the lower-cost venue {detailSummary.consistencyScore.toFixed(1)}% of the time over the last 14 days.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Promote BitMEX Banner */}
          {detailSummary && detailSummary.consistencyScore > 60 && detailSummary.suggestion === "LONG_BITMEX_SHORT_HL" && (
            <div className="bg-[#FF6D00]/10 border border-[#FF6D00]/30 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#FF6D00] shrink-0 mt-0.5" />
              <p className="text-sm text-[#FF6D00]">
                <strong className="font-semibold">BitMEX Advantage:</strong> BitMEX has been the consistent low-cost venue for {detailSummary.consistencyScore.toFixed(1)}% of the last 14 days — use BitMEX as your long leg to capture this spread.
              </p>
            </div>
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
                  <CardTitle className="text-base font-medium text-gray-200">14-Day Funding Rate Comparison (APR)</CardTitle>
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
                    Funding Spread (BitMEX − HL) <span className="text-xs font-normal text-gray-500 ml-2">Green = BitMEX cheaper · Red = BitMEX pricier</span>
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
                        name="BitMEX Cheaper"
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
                        name="BitMEX Pricier"
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
