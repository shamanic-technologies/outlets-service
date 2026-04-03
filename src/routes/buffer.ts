import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import { requireFullOrgContext } from "../middleware/org-context";
import type { FullOrgContext } from "../middleware/org-context";
import { pool } from "../db/pool";
import { isOutletBlocked } from "../services/journalists";
import { discoverCycle } from "../services/category-discovery";
import { bufferNextSchema } from "../schemas";
import type { OrgContext } from "../middleware/org-context";

const MAX_CLAIM_ITERATIONS = 50;
const MAX_DISCOVER_ATTEMPTS = 5;
const MIN_RELEVANCE_SCORE = 30;
const IDEMPOTENCY_TTL_DAYS = 60;

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
     SET status = 'served', updated_at = CURRENT_TIMESTAMP
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
 * Mark an outlet as skipped (e.g. cross-campaign duplicate).
 */
async function markSkipped(campaignId: string, outletId: string): Promise<void> {
  await pool.query(
    `UPDATE campaign_outlets SET status = 'skipped', updated_at = CURRENT_TIMESTAMP
     WHERE campaign_id = $1 AND outlet_id = $2`,
    [campaignId, outletId]
  );
}

const router = Router();

// POST /buffer/next — pull the next best outlet(s) from the buffer
router.post(
  "/next",
  requireFullOrgContext,
  validateBody(bufferNextSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext! as FullOrgContext;
    const { count, idempotencyKey } = req.body as { count: number; idempotencyKey?: string };

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
      let discoverAttempts = 0;

      for (let i = 0; i < MAX_CLAIM_ITERATIONS && collected.length < count; i++) {
        const claimed = await claimNext(ctx.campaignId);

        if (!claimed) {
          // Buffer empty — try category-based discovery
          if (discoverAttempts >= MAX_DISCOVER_ATTEMPTS) break;
          discoverAttempts++;

          console.log(`[outlets-service] buffer/next: buffer empty for campaign ${ctx.campaignId}, triggering discover cycle (attempt ${discoverAttempts}/${MAX_DISCOVER_ATTEMPTS})`);
          const filled = await discoverCycle(ctx);

          if (filled === 0) {
            console.log(`[outlets-service] buffer/next: discover cycle found 0 outlets for campaign ${ctx.campaignId}`);
            break;
          }
          continue; // retry claim from freshly filled buffer
        }

        // Skip low-relevance ("distant") outlets — score < 30 means no meaningful connection
        if (claimed.relevanceScore < MIN_RELEVANCE_SCORE) {
          console.log(`[outlets-service] buffer/next: skipping low-relevance outlet ${claimed.outletName} (${claimed.outletId}, score=${claimed.relevanceScore}) for campaign ${ctx.campaignId}`);
          await markSkipped(claimed.campaignId, claimed.outletId);
          continue;
        }

        // Check if outlet is blocked (contacted / in cooldown) via journalists-service
        const blocked = await isBlocked(claimed.outletId, ctx.orgId, ctx.brandIds, ctx);
        if (blocked) {
          console.log(`[outlets-service] buffer/next: skipping blocked outlet ${claimed.outletName} (${claimed.outletId}) for campaign ${ctx.campaignId}`);
          await markSkipped(claimed.campaignId, claimed.outletId);
          continue; // try next outlet
        }

        collected.push(claimed);
      }

      console.log(`[outlets-service] buffer/next: returning ${collected.length}/${count} outlets for campaign ${ctx.campaignId}`);

      const response = { outlets: collected };
      if (idempotencyKey) {
        await saveIdempotencyCache(idempotencyKey, response);
      }
      res.json(response);
    } catch (err) {
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
