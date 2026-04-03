import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import { discoverSchema } from "../schemas";
import { discoverOutlets } from "./buffer";
import { createChildRun, closeRun } from "../services/runs";

const BATCH_SIZE = 15;

const router = Router();

// POST /outlets/discover — on-demand outlet discovery for a campaign
router.post(
  "/discover",
  validateBody(discoverSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { count } = req.body as { count: number };

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("discover", ctx);

      const batches = Math.ceil(count / BATCH_SIZE);
      let totalDiscovered = 0;

      for (let i = 0; i < batches; i++) {
        const remaining = count - totalDiscovered;
        const batchTarget = Math.min(remaining, BATCH_SIZE);
        const queryCount = Math.max(3, Math.ceil(batchTarget / 5));
        const resultsPerQuery = Math.min(10, Math.ceil(batchTarget / queryCount));

        const discovered = await discoverOutlets(ctx, {
          queryCount,
          resultsPerQuery,
          runId: childRunId,
        });

        totalDiscovered += discovered;
        if (discovered === 0) break;
      }

      await closeRun(childRunId, "completed", ctx);
      res.json({ runId: childRunId, discovered: totalDiscovered });
    } catch (err) {
      if (childRunId) {
        await closeRun(childRunId, "failed", ctx).catch((closeErr) =>
          console.error("[outlets-service] Failed to close run:", closeErr)
        );
      }
      console.error("[outlets-service] Error in /outlets/discover:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
