import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import {
  editorialEmailDiscoverSchema,
  editorialEmailDiscoverBatchSchema,
  type EditorialEmailDiscover,
  type EditorialEmailDiscoverBatch,
} from "../schemas";
import {
  discoverEditorialEmails,
  discoverEditorialEmailsBatch,
} from "../services/editorial-emails";
import { createChildRun, closeRun } from "../services/runs";

const router = Router();

// POST /orgs/outlets/editorial-emails/discover — resolve editorial emails for one outlet
router.post(
  "/discover",
  validateBody(editorialEmailDiscoverSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const input = req.body as EditorialEmailDiscover;

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("editorial-email-discover", ctx);
      const result = await discoverEditorialEmails(input, ctx);
      await closeRun(childRunId, "completed", ctx);
      res.json(result);
    } catch (err) {
      if (childRunId) {
        await closeRun(childRunId, "failed", ctx).catch((closeErr) =>
          console.error("[outlets-service] Failed to close run:", closeErr)
        );
      }
      console.error("[outlets-service] Error in /editorial-emails/discover:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") || message.includes("timed out") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

// POST /orgs/outlets/editorial-emails/discover-batch — resolve for many outlets (pool of 8)
router.post(
  "/discover-batch",
  validateBody(editorialEmailDiscoverBatchSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { outlets } = req.body as EditorialEmailDiscoverBatch;

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("editorial-email-discover-batch", ctx);
      const results = await discoverEditorialEmailsBatch(outlets, ctx);
      await closeRun(childRunId, "completed", ctx);
      res.json({ results });
    } catch (err) {
      if (childRunId) {
        await closeRun(childRunId, "failed", ctx).catch((closeErr) =>
          console.error("[outlets-service] Failed to close run:", closeErr)
        );
      }
      console.error("[outlets-service] Error in /editorial-emails/discover-batch:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") || message.includes("timed out") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
