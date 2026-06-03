import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import { discoverSchema } from "../schemas";
import { discoverCycle } from "../services/category-discovery";
import { createChildRun, closeRun } from "../services/runs";
import { triggerDrCompute } from "../services/ahref";
import { traceEvent } from "../lib/trace-event";

const router = Router();

// POST /org/outlets/discover — on-demand outlet discovery for a campaign
router.post(
  "/discover",
  validateBody(discoverSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { count } = req.body as { count: number };

    let childRunId: string | undefined;
    try {
      childRunId = await createChildRun("discover", ctx);

      if (ctx.runId) {
        traceEvent(ctx.runId, {
          service: "outlets-service",
          event: "discover-start",
          detail: `count=${count}, campaignId=${ctx.campaignId}`,
          data: { count, campaignId: ctx.campaignId },
        }, req.headers).catch(() => {});
      }

      let totalDiscovered = 0;
      const discoveredDomains: string[] = [];
      while (totalDiscovered < count) {
        const { inserted, domains } = await discoverCycle(ctx);
        totalDiscovered += inserted;
        discoveredDomains.push(...domains);
        if (inserted === 0) break;
      }

      // Trigger ahref-service to compute DR for the freshly-discovered domains.
      // Fire-and-forget: the scrape is paid + slow, and ahref owns the spend;
      // discover must not block on it or fail if it errors. DR is served live
      // on GET /orgs/outlets once ahref has scraped.
      const uniqueDomains = [...new Set(discoveredDomains)];
      if (uniqueDomains.length > 0) {
        triggerDrCompute(uniqueDomains, ctx).catch((err) =>
          console.error(
            "[outlets-service] ahref dr-compute trigger failed:",
            err instanceof Error ? err.message : err
          )
        );
      }

      if (ctx.runId) {
        traceEvent(ctx.runId, {
          service: "outlets-service",
          event: "discover-complete",
          detail: `discovered=${totalDiscovered}/${count}`,
          data: { totalDiscovered, requested: count },
        }, req.headers).catch(() => {});
      }

      await closeRun(childRunId, "completed", ctx);
      res.json({ runId: childRunId, discovered: totalDiscovered });
    } catch (err) {
      if (ctx.runId) {
        traceEvent(ctx.runId, {
          service: "outlets-service",
          event: "discover-error",
          detail: err instanceof Error ? err.message : "Unknown error",
          level: "error",
        }, req.headers).catch(() => {});
      }
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
