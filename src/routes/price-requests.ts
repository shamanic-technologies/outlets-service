import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import { priceRequestBatchSchema, type PriceRequestBatch } from "../schemas";
import { requestPricesForOutlets } from "../services/price-requests";
import { createChildRun, closeRun } from "../services/runs";

const router = Router();

// POST /orgs/outlets/price-requests — request pay-per-publish rate cards for
// 1..N outlets. For each owned outlet: resolve its editorial email, email the
// rate-card request via email-gateway (broadcast/Instantly), and record the
// request as awaiting a reply. Per-outlet failures are returned inline.
router.post(
  "/",
  validateBody(priceRequestBatchSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { outletIds } = req.body as PriceRequestBatch;

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("outlet-price-request", ctx);
      const results = await requestPricesForOutlets(outletIds, ctx);
      await closeRun(childRunId, "completed", ctx);
      res.json({ results });
    } catch (err) {
      if (childRunId) {
        await closeRun(childRunId, "failed", ctx).catch((closeErr) =>
          console.error("[outlets-service] Failed to close run:", closeErr)
        );
      }
      console.error("[outlets-service] Error in /price-requests:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") || message.includes("timed out") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
