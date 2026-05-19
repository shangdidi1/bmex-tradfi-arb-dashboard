import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { fetchStrcSummary } from "../lib/strc";

const router: IRouter = Router();

router.get("/strc/summary", async (_req, res): Promise<void> => {
  try {
    const summary = await fetchStrcSummary();
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "Error building STRC summary");
    res.status(500).json({ error: "Failed to fetch STRC summary" });
  }
});

export default router;
