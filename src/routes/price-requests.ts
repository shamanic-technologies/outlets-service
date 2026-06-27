import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import {
  priceRequestBatchSchema,
  priceRequestSendSchema,
  type PriceRequestBatch,
  type PriceRequestSend,
} from "../schemas";
import { requestPricesForOutlets, sendCuratedPriceRequests } from "../services/price-requests";
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

// POST /orgs/outlets/price-requests/send — SEND-ONLY: fire the rate-card sequence
// to 1..100 outlets whose editorial emails are ALREADY in the curated bronze.
// The mid-workflow "send" step: NO discovery/scrape/LLM, NO org-ownership gate.
// Outlets with no curated email are skipped inline (error result). Per-outlet
// failures are surfaced, never abort the batch.
router.post(
  "/send",
  validateBody(priceRequestSendSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { outletIds } = req.body as PriceRequestSend;

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("outlet-price-request-send", ctx);
      const results = await sendCuratedPriceRequests(outletIds, ctx);
      await closeRun(childRunId, "completed", ctx);
      res.json({ results });
    } catch (err) {
      if (childRunId) {
        await closeRun(childRunId, "failed", ctx).catch((closeErr) =>
          console.error("[outlets-service] Failed to close run:", closeErr)
        );
      }
      console.error("[outlets-service] Error in /price-requests/send:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") || message.includes("timed out") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
