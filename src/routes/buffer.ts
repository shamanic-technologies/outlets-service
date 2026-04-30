import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import type { OrgContext } from "../middleware/org-context";
import { pool } from "../db/pool";
import { isOutletBlocked } from "../services/journalists";
import { reuseCycle, discoverCycle } from "../services/category-discovery";
import { bufferNextSchema } from "../schemas";
import { traceEvent } from "../lib/trace-event";

const MIN_RELEVANCE_SCORE = 30;
const IDEMPOTENCY_TTL_DAYS = 60;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface ClaimedOutlet {
  outletId: string;
  outletName: string;
  outletUrl: string;
  outletDomain: string;
  campaignId: string;
  brandIds: string[];
  relevanceScore: number;
  whyRelevant: string;
  whyNotRelevant: string;
  overallRelevance: string | null;
  runId: string | null;
}

/**
 * Try to claim the next open outlet from the buffer using FOR UPDATE SKIP LOCKED.
 * Returns the claimed outlet or null if buffer is empty.
 */
async function claimNext(campaignId: string): Promise<ClaimedOutlet | null> {
  const result = await pool.query(
    `UPDATE campaign_outlets co
     SET status = 'served', status_reason = 'buffer_claimed',
         status_detail = 'Claimed by buffer/next for campaign ' || $1,
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT co2.campaign_id, co2.outlet_id
       FROM campaign_outlets co2
       WHERE co2.campaign_id = $1 AND co2.status = 'open'
       ORDER BY co2.relevance_score DESC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     ) sub
     JOIN outlets o ON o.id = sub.outlet_id
     WHERE co.campaign_id = sub.campaign_id AND co.outlet_id = sub.outlet_id
     RETURNING o.id AS outlet_id, o.outlet_name, o.outlet_url, o.outlet_domain,
               co.campaign_id, co.brand_ids, co.relevance_score,
               co.why_relevant, co.why_not_relevant, co.overall_relevance, co.run_id`,
    [campaignId]
  );

  if (result.rows.length === 0) return null;

  const r = result.rows[0];
  return {
    outletId: r.outlet_id,
    outletName: r.outlet_name,
    outletUrl: r.outlet_url,
    outletDomain: r.outlet_domain,
    campaignId: r.campaign_id,
    brandIds: r.brand_ids,
    relevanceScore: Number(r.relevance_score),
    whyRelevant: r.why_relevant,
    whyNotRelevant: r.why_not_relevant,
    overallRelevance: r.overall_relevance,
    runId: r.run_id || null,
  };
}

const BLOCK_CACHE_DAYS = 30;

/**
 * Check if an outlet is blocked (contacted / in cooldown) via journalists-service.
 * Uses a local cache: if this outlet was already skipped for the same org + overlapping
 * brand within the last 30 days, skip without calling journalists-service.
 */
async function isBlocked(
  outletId: string,
  orgId: string,
  brandIds: string[],
  ctx: OrgContext
): Promise<boolean> {
  // Check local skip cache first (any campaign, same org + overlapping brands)
  const cached = await pool.query(
    `SELECT 1 FROM campaign_outlets
     WHERE org_id = $1 AND brand_ids && $2 AND outlet_id = $3
       AND status = 'skipped'
       AND updated_at >= CURRENT_TIMESTAMP - INTERVAL '${BLOCK_CACHE_DAYS} days'
     LIMIT 1`,
    [orgId, brandIds, outletId]
  );
  if (cached.rows.length > 0) return true;

  // No cache hit — ask journalists-service
  const result = await isOutletBlocked(outletId, ctx);
  return result.blocked;
}

/**
 * Mark an outlet as skipped with reason tracking.
 */
async function markSkipped(campaignId: string, outletId: string, statusReason: string, statusDetail: string): Promise<void> {
  await pool.query(
    `UPDATE campaign_outlets SET status = 'skipped', status_reason = $3, status_detail = $4, updated_at = CURRENT_TIMESTAMP
     WHERE campaign_id = $1 AND outlet_id = $2`,
    [campaignId, outletId, statusReason, statusDetail]
  );
}

const router = Router();

// POST /buffer/next — pull the next best outlet(s) from the buffer
router.post(
  "/next",
  validateBody(bufferNextSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const { count, idempotencyKey } = req.body as { count: number; idempotencyKey?: string };

    console.log(`[outlets-service] buffer/next: received request for campaign ${ctx.campaignId} (count=${count})`);

    if (ctx.runId) {
      traceEvent(ctx.runId, {
        service: "outlets-service",
        event: "buffer-next-start",
        detail: `count=${count}, campaignId=${ctx.campaignId}`,
        data: { count, campaignId: ctx.campaignId },
      }, req.headers).catch(() => {});
    }

    try {
      // Check idempotency cache
      if (idempotencyKey) {
        const cached = await pool.query(
          `SELECT response FROM idempotency_cache WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (cached.rows.length > 0) {
          res.json(cached.rows[0].response);
          return;
        }
      }

      const collected: ClaimedOutlet[] = [];
      let transientRetries = 0;

      while (collected.length < count) {
        try {
          const claimed = await claimNext(ctx.campaignId!);

          if (!claimed) {
            // Diagnostic: verify buffer is truly empty
            const openCount = await pool.query(
              `SELECT COUNT(*) AS cnt FROM campaign_outlets WHERE campaign_id = $1 AND status = 'open'`,
              [ctx.campaignId]
            );
            console.log(`[outlets-service] buffer/next: claimNext returned null for campaign ${ctx.campaignId}, open outlets in DB: ${openCount.rows[0].cnt}`);

            // Try reuse cycle first (recycle known outlets for this brand), then discover cycle
            const reused = await reuseCycle(ctx);
            if (reused > 0) {
              continue; // retry claim from reused outlets
            }

            const filled = await discoverCycle(ctx);
            if (filled === 0) {
              console.log(`[outlets-service] buffer/next: discover cycle exhausted (category cap) for campaign ${ctx.campaignId}`);
              break;
            }
            continue; // retry claim from freshly filled buffer
          }

          // Skip low-relevance ("distant") outlets — score < 30 means no meaningful connection
          if (claimed.relevanceScore < MIN_RELEVANCE_SCORE) {
            console.log(`[outlets-service] buffer/next: skipping low-relevance outlet ${claimed.outletName} (${claimed.outletId}, score=${claimed.relevanceScore}) for campaign ${ctx.campaignId}`);
            await markSkipped(claimed.campaignId, claimed.outletId, "low_relevance", `Relevance score ${claimed.relevanceScore} below minimum threshold ${MIN_RELEVANCE_SCORE}`);
            continue;
          }

          // Check if outlet is blocked (contacted / in cooldown) via journalists-service
          const blocked = await isBlocked(claimed.outletId, ctx.orgId, ctx.brandIds, ctx);
          if (blocked) {
            console.log(`[outlets-service] buffer/next: skipping blocked outlet ${claimed.outletName} (${claimed.outletId}) for campaign ${ctx.campaignId}`);
            await markSkipped(claimed.campaignId, claimed.outletId, "blocked", `Outlet ${claimed.outletName} (${claimed.outletDomain}) is blocked — already contacted or in cooldown for org ${ctx.orgId}`);
            continue; // try next outlet
          }

          collected.push(claimed);
          transientRetries = 0;
        } catch (err) {
          transientRetries++;
          if (transientRetries > MAX_TRANSIENT_RETRIES) {
            throw err;
          }
          const delay = RETRY_DELAY_MS * transientRetries;
          console.warn(`[outlets-service] buffer/next: transient error (retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}), retrying in ${delay}ms:`, err);
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      console.log(`[outlets-service] buffer/next: returning ${collected.length}/${count} outlets for campaign ${ctx.campaignId}`);

      if (ctx.runId) {
        traceEvent(ctx.runId, {
          service: "outlets-service",
          event: "buffer-next-served",
          detail: `served=${collected.length}/${count}, campaignId=${ctx.campaignId}`,
          data: { served: collected.length, requested: count, campaignId: ctx.campaignId },
        }, req.headers).catch(() => {});
      }

      const response = { outlets: collected };
      if (idempotencyKey) {
        await saveIdempotencyCache(idempotencyKey, response);
      }
      res.json(response);
    } catch (err) {
      if (ctx.runId) {
        traceEvent(ctx.runId, {
          service: "outlets-service",
          event: "buffer-next-error",
          detail: err instanceof Error ? err.message : "Unknown error",
          level: "error",
        }, req.headers).catch(() => {});
      }
      console.error("[outlets-service] Error in buffer/next:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

async function saveIdempotencyCache(
  key: string,
  response: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_cache (idempotency_key, response)
     VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, JSON.stringify(response)]
  );

  // Probabilistic cleanup (~1% of requests)
  if (Math.random() < 0.01) {
    pool
      .query(
        `DELETE FROM idempotency_cache WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${IDEMPOTENCY_TTL_DAYS} days'`
      )
      .catch((err) => console.warn("[outlets-service] Idempotency cache cleanup failed:", err));
  }
}

export default router;
