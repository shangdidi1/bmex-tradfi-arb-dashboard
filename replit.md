# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Products

### BitMEX TradFi Perps Arbitrage Dashboard (`artifacts/dashboard`)
- URL: `/` (root)
- Dark-mode trading intelligence dashboard comparing BitMEX TradFi perpetuals vs Hyperliquid
- 9 asset pairs: WTI Crude, Brent Crude, Gold, Silver, SPY, QQQ, COIN, HOOD, CRCL
- Live funding rates, spread charts (14-day history), trade suggestions
- Summary table + per-pair detail view with Recharts time-series charts
- Auto-refreshes every 5 minutes

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Frontend**: React 19 + Vite + Tailwind v4 + shadcn/ui + Recharts
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key API Endpoints

- `GET /api/healthz` — Health check
- `GET /api/arb/summary` — Current funding rates + suggestions for all 9 pairs (5-min cache)
- `GET /api/arb/:pairId` — 14-day time-series data for a specific pair (5-min cache)

## External APIs Used

- **BitMEX**: `https://www.bitmex.com/api/v1/` — instrument data, funding history, 5m price candles
- **Hyperliquid**: `https://api.hyperliquid.xyz/info` — funding history, candle snapshots

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/dashboard run dev` — run dashboard locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
