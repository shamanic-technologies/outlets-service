import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import { requireFullOrgContext } from "../middleware/org-context";
import type { FullOrgContext } from "../middleware/org-context";
import { discoverSchema } from "../schemas";
import { discoverCycle } from "../services/category-discovery";
import { createChildRun, closeRun } from "../services/runs";

const router = Router();

// POST /outlets/discover — on-demand outlet discovery for a campaign
router.post(
  "/discover",
  requireFullOrgContext,
  validateBody(discoverSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext! as FullOrgContext;
    const { count } = req.body as { count: number };

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("discover", ctx);

      let totalDiscovered = 0;
      while (totalDiscovered < count) {
        const discovered = await discoverCycle(ctx);
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
