# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Products

### BitMEX TradFi Perps Arbitrage Dashboard (`artifacts/dashboard`)
- URL: `/` (root)
- Dark-mode trading intelligence dashboard comparing BitMEX TradFi perpetuals vs Hyperliquid
- 22 asset pairs: WTI Crude, Brent Crude, Gold, Silver, SPY, QQQ, COIN, HOOD, CRCL, TSLA, NVDA, META, AAPL, AMZN, MSFT, GOOGL, PLTR, INTC, ORCL, MSTR, NFLX, EUR/USD
- Live funding rates, 30-day history charts, trade suggestions
- Execution economics (bid-ask + fees + basis → Net APR, breakeven)
- Multi-level orderbook (5 levels × 2 venues) with depth bars + per-pair live refresh
- Historical snapshots refreshed every 10 min via Vercel Cron; on-demand live refresh via /live endpoints

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
- `GET /api/arb/summary` — All 22 pair summaries. Served from `pair_snapshots` table in Postgres, ~50ms. Returns `{ pairs: [], status: "bootstrapping" }` before the first refresh has populated the DB.
- `GET /api/arb/:pairId` — 30-day time-series detail for one pair. Served from DB; 404 if that pair hasn't been refreshed yet.
- `GET /api/arb/summary/live` — Fans out orderbook + current-funding fetches for all 22 pairs in parallel and recomputes summaries using cached time-series. ~10-12s. Global 15s cooldown. What the main "Refresh" button hits.
- `GET /api/arb/:pairId/live` — On-demand per-pair refresh (orderbooks + current funding only, no 30-day history). ~1-2s. Rate-limited to 1/10s per pair. What the detail-view "Refresh this pair" button hits.
- `GET /api/arb/refresh` — Heavy full refresh: fetches 30-day funding+price history for all 22 pairs and UPSERTs to DB. ~3 min. Requires `Authorization: Bearer ${CRON_SECRET}` header. Called by Vercel Cron every 10 minutes.

## Required env vars

- `DATABASE_URL` — Postgres connection string (Neon recommended; one URL works both locally and on Vercel)
- `CRON_SECRET` — shared secret for the refresh endpoint. Generate with `openssl rand -hex 32`. Vercel Cron auto-sends this as `Authorization: Bearer ${CRON_SECRET}` when the env var is set on the project.
- `VITE_API_URL` (dashboard project only) — URL of the api-server in production, e.g. `https://your-api.vercel.app`. Leave unset in dev to use the Vite /api proxy.
- `BMEX_TAKER_FEE_PCT`, `HL_TAKER_FEE_PCT` (optional) — override default taker fees (0.05 / 0.008) for Net APR calculations.

## Local setup

```bash
# 1. Provision Postgres (local brew or point at a free Neon DB)
brew install postgresql@17 && brew services start postgresql@17 && createdb arb_dashboard
export DATABASE_URL='postgresql://workbrew@localhost:5432/arb_dashboard'
export CRON_SECRET="$(openssl rand -hex 32)"

# 2. Create the pair_snapshots table
pnpm --filter @workspace/db run push

# 3. Start both servers (separate terminals)
pnpm --filter @workspace/api-server run dev       # :3000
pnpm --filter @workspace/dashboard run dev        # :5173

# 4. Bootstrap the cache (one-off; subsequent refreshes run on cron every 10 min)
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/arb/refresh
# ~3 min. Returns { refreshed: [...22 ids], failed: [], durationMs }.

# 5. Open dashboard
open http://localhost:5173
```

## Production deploy (Vercel + Neon)

Two Vercel projects from the same GitHub repo:
1. **api-server project**
   - Root Directory: `artifacts/api-server`
   - Env vars: `DATABASE_URL`, `CRON_SECRET`
   - Cron is defined in `artifacts/api-server/vercel.json` (every 10 min → `/api/arb/refresh`)
2. **dashboard project**
   - Root Directory: `artifacts/dashboard`
   - Framework preset: Vite
   - Env vars: `VITE_API_URL` = the api-server project's public URL

Bootstrap sequence after first deploy:
```bash
# Push schema to prod Neon DB
DATABASE_URL='<neon-connection-string>' pnpm --filter @workspace/db run push

# Trigger first refresh (or wait 10 min for cron)
curl -H "Authorization: Bearer <CRON_SECRET>" https://<api-server-url>/api/arb/refresh
```

**Vercel plan note:** `/api/arb/refresh` takes ~3 min and `/api/arb/summary/live` takes ~11s. Vercel Hobby plan's default 10s function timeout will kill both. Pro plan allows up to 300s. If on Hobby, you can reduce scope (fewer pairs, incremental refresh) or upgrade.

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
