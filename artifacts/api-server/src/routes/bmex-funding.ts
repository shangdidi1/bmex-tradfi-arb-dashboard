import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { fetchBitmexFundingHistory, fetchBitmexLatestFundingAPR } from "../lib/bitmex";

const router: IRouter = Router();

const BTC_SYMBOL = "XBTUSD";    // inverse, BTC-margined
const USDT_SYMBOL = "XBTUSDT";  // linear, USDT-margined

// |spread| below this APR threshold is treated as NEUTRAL (not actionable
// after fees and execution slippage). Picked to filter normal cross-funding
// noise; tune from observation.
const NEUTRAL_SPREAD_APR = 5;

type Suggestion = "SHORT_BTC_LONG_USDT" | "LONG_BTC_SHORT_USDT" | "NEUTRAL";

function suggestionFor(spreadAPR: number): Suggestion {
  if (Math.abs(spreadAPR) < NEUTRAL_SPREAD_APR) return "NEUTRAL";
  return spreadAPR > 0 ? "SHORT_BTC_LONG_USDT" : "LONG_BTC_SHORT_USDT";
}

router.get("/bmex-funding/summary", async (_req, res): Promise<void> => {
  try {
    const [btcHistory, usdtHistory, btcCurrent, usdtCurrent] = await Promise.all([
      fetchBitmexFundingHistory(BTC_SYMBOL),
      fetchBitmexFundingHistory(USDT_SYMBOL),
      fetchBitmexLatestFundingAPR(BTC_SYMBOL),
      fetchBitmexLatestFundingAPR(USDT_SYMBOL),
    ]);

    const spreadAPR = parseFloat((btcCurrent - usdtCurrent).toFixed(4));

    res.json({
      btc:  { symbol: BTC_SYMBOL,  currentAPR: parseFloat(btcCurrent.toFixed(4)),  history: btcHistory },
      usdt: { symbol: USDT_SYMBOL, currentAPR: parseFloat(usdtCurrent.toFixed(4)), history: usdtHistory },
      spreadAPR,
      suggestion: suggestionFor(spreadAPR),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Error building bmex-funding summary");
    res.status(500).json({ error: "Failed to fetch BMEX funding summary" });
  }
});

export default router;
