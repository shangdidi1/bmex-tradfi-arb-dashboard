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
- `GET /api/arb/summary` — Current funding rates + suggestions for all 22 pairs. Served from `pair_snapshots` table in Postgres; always instant. Returns `{ pairs: [], status: "bootstrapping" }` before the first refresh has populated the DB.
- `GET /api/arb/:pairId` — 30-day time-series data for a specific pair. Served from DB; 404 if that pair hasn't been refreshed yet.
- `GET /api/arb/refresh` — Heavy fetch + UPSERT of all pair snapshots. Requires `Authorization: Bearer ${CRON_SECRET}` header. Called by Vercel Cron every 10 minutes; returns `{ refreshed, failed, durationMs }`.

## Required env vars

- `DATABASE_URL` — Postgres connection string (Neon recommended; it works both locally and on Vercel with one URL)
- `CRON_SECRET` — shared secret for the refresh endpoint. Generate with `openssl rand -hex 32`. Vercel Cron auto-sends this as `Authorization: Bearer ${CRON_SECRET}` when the env var is set on the project.

## First-time setup / bootstrap

```bash
# 1. Create the pair_snapshots table
pnpm --filter @workspace/db run push

# 2. Start the API server
pnpm --filter @workspace/api-server run dev

# 3. Populate the DB (one-off; subsequent refreshes run on cron every 10 min)
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/arb/refresh
# Takes ~3 min on first run. Returns { refreshed: [...22 ids], failed: [], durationMs }.

# 4. Verify
curl http://localhost:3000/api/arb/summary | jq '.pairs | length'   # → 22
```

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
