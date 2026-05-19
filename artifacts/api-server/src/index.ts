import "dotenv/config";  // Load .env into process.env BEFORE anything imports @workspace/db
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "3000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startLocalScheduler(port);
});

// Local scheduler — keeps the time series fresh in long-running deployments
// (Replit, bare VPS, local dev). On Vercel serverless, this is skipped because
// (a) lambdas are ephemeral and intervals don't survive across invocations,
// and (b) Vercel Cron already hits /api/arb/refresh every 10 min.
//
// On startup, fires one tick immediately if the last refresh is > 10 min old,
// so coming back to a stale dev server self-heals. Then ticks every 10 min.
function startLocalScheduler(port: number): void {
  if (process.env["VERCEL"] || process.env["DISABLE_LOCAL_SCHEDULER"]) {
    logger.info("Local scheduler disabled (VERCEL or DISABLE_LOCAL_SCHEDULER set)");
    return;
  }
  const secret = process.env["CRON_SECRET"];
  if (!secret) {
    logger.warn("Local scheduler not started — CRON_SECRET unset");
    return;
  }

  const intervalMs = 10 * 60 * 1000;
  // Single-flight guard: the full refresh can take ~9 min (21 HL pairs × 20
  // 3-day chunks × 1.1s gate). Without this, every 10-min tick fires while
  // the previous is still in flight, doubling the global HL queue each cycle
  // and producing permanent backlog.
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) {
      logger.warn("Skipping local scheduler tick — previous refresh still in flight");
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    try {
      // Default Node fetch headersTimeout is 5 min, shorter than our refresh.
      // Explicit 15-min budget covers a slow run + the BMEX/HL response
      // tail without prematurely aborting (which used to leave the
      // server-side handler running unsupervised).
      const res = await fetch(`http://127.0.0.1:${port}/api/arb/refresh`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      const ms = Date.now() - startedAt;
      if (res.ok) {
        logger.info({ ms }, "Local scheduler tick complete");
      } else {
        logger.warn({ status: res.status, ms }, "Local scheduler tick non-OK");
      }
    } catch (err) {
      logger.error({ err }, "Local scheduler tick threw");
    } finally {
      inFlight = false;
    }
  };

  // Fire once on boot so a server resumed after days of inactivity catches up
  // immediately. Wrapped in a delay so the listen() event loop is fully ready.
  setTimeout(() => { void tick(); }, 2_000);
  setInterval(() => { void tick(); }, intervalMs);
  logger.info({ intervalMs }, "Local refresh scheduler started");
}
