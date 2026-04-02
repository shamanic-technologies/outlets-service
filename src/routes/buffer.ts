import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { pool } from "../db/pool";
import { chatComplete } from "../services/chat";
import { searchBatch } from "../services/google";
import { extractFields, findField } from "../services/brand";
import { getFeatureInputs } from "../services/campaign";
import { isOutletBlocked } from "../services/journalists";
import {
  GENERATE_QUERIES_SYSTEM_PROMPT,
  SCORE_OUTLETS_SYSTEM_PROMPT,
  buildQueryGenerationMessage,
  buildScoringMessage,
  type BrandPromptContext,
} from "../prompts";
import { bufferNextSchema } from "../schemas";
import type { OrgContext } from "../middleware/org-context";

const MINI_DISCOVER_QUERY_COUNT = 3;
const MINI_DISCOVER_RESULTS_PER_QUERY = 5;
const MAX_CLAIM_ITERATIONS = 50;
const IDEMPOTENCY_TTL_DAYS = 60;

export interface DiscoverOptions {
  queryCount: number;
  resultsPerQuery: number;
  runId?: string;
}

const querySchema = z.object({
  queries: z.array(
    z.object({
      query: z.string(),
      type: z.enum(["web", "news"]),
      rationale: z.string(),
    })
  ),
});

const scoringSchema = z.object({
  outlets: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      domain: z.string(),
      relevanceScore: z.number().min(0).max(100),
      whyRelevant: z.string(),
      whyNotRelevant: z.string(),
      overallRelevance: z.string(),
    })
  ),
});

/** Fields we need from brand-service for mini-discover */
const BRAND_FIELDS = [
  { key: "brand_name", description: "The brand's display name" },
  { key: "elevator_pitch", description: "A concise elevator pitch describing what the brand does" },
  { key: "categories", description: "The brand's primary industry vertical or categories" },
  { key: "target_geo", description: "Priority geographic markets for outreach" },
  { key: "target_audience", description: "Target audience for the brand's products or services" },
  { key: "angles", description: "PR angles and editorial hooks the brand can leverage" },
];

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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

/**
 * Parameterized outlet discovery. Generates search queries, runs Google search,
 * scores results with LLM, and inserts into the campaign buffer.
 * Returns number of outlets inserted.
 */
export async function discoverOutlets(ctx: OrgContext, options: DiscoverOptions): Promise<number> {
  const [extractedFields, featureInputs] = await Promise.all([
    extractFields(BRAND_FIELDS, ctx),
    getFeatureInputs(ctx.campaignId!, ctx),
  ]);

  const brandContext: BrandPromptContext = {
    brandName: findField(extractedFields, "brand_name") || "Unknown",
    brandDescription:
      findField(extractedFields, "elevator_pitch") ||
      "No description available",
    industry: findField(extractedFields, "categories") || "General",
    targetGeo: findField(extractedFields, "target_geo") || undefined,
    targetAudience: findField(extractedFields, "target_audience") || undefined,
    angles: (() => {
      const raw = findField(extractedFields, "angles");
      return raw ? raw.split(", ") : undefined;
    })(),
  };

  const featureInput = featureInputs ?? undefined;

  // Step 1: Generate a small set of search queries
  const queryGenResponse = await chatComplete(
    {
      provider: "google",
      model: "flash-lite",
      message: buildQueryGenerationMessage(brandContext, featureInput),
      systemPrompt:
        GENERATE_QUERIES_SYSTEM_PROMPT.replace(
          "Generate 8-12 queries",
          `Generate exactly ${options.queryCount} queries`
        ),
      responseFormat: "json",
      temperature: 0.7,
      maxTokens: 800,
    },
    ctx
  );

  const queryJson = queryGenResponse.json;
  if (queryJson && Array.isArray(queryJson.queries)) {
    queryJson.queries = (queryJson.queries as Array<Record<string, unknown>>)
      .filter((q) => q.query && q.type && q.rationale)
      .slice(0, options.queryCount);
  }

  const parsedQueries = querySchema.safeParse(queryJson);
  if (!parsedQueries.success || parsedQueries.data.queries.length === 0) {
    console.error("[outlets-service] Mini-discover: LLM returned invalid query format:", queryGenResponse.content);
    return 0;
  }

  // Step 2: Search with small result count
  const searchResponse = await searchBatch(
    {
      queries: parsedQueries.data.queries.map((q) => ({
        query: q.query,
        type: q.type,
        num: options.resultsPerQuery,
      })),
    },
    ctx
  );

  // Step 3: Score results
  const scoringResponse = await chatComplete(
    {
      provider: "google",
      model: "flash-lite",
      message: buildScoringMessage(
        brandContext,
        searchResponse.results.map((r) => ({
          query: r.query,
          results: r.results.map((sr) => ({
            title: sr.title,
            url: sr.url,
            snippet: sr.snippet,
            domain: sr.domain,
          })),
        })),
        featureInput
      ),
      systemPrompt: SCORE_OUTLETS_SYSTEM_PROMPT,
      responseFormat: "json",
      temperature: 0.3,
      maxTokens: 16000,
      thinkingBudget: 8000,
    },
    ctx
  );

  const parsedOutlets = scoringSchema.safeParse(scoringResponse.json);
  if (!parsedOutlets.success) {
    console.error("[outlets-service] Mini-discover: LLM returned invalid scoring format:", scoringResponse.content);
    return 0;
  }

  const outlets = parsedOutlets.data.outlets;
  if (outlets.length === 0) return 0;

  // Step 4: Bulk upsert into DB
  const featureSlug = ctx.featureSlug || null;
  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (const o of outlets) {
      const domain = extractDomain(o.url);
      const url = o.url.startsWith("http") ? o.url : `https://${o.url}`;

      const outletResult = await client.query(
        `INSERT INTO outlets (outlet_name, outlet_url, outlet_domain)
         VALUES ($1, $2, $3)
         ON CONFLICT (outlet_domain)
         DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_url = EXCLUDED.outlet_url, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [o.name, url, domain]
      );
      const outletId = outletResult.rows[0].id;

      // Only insert if not already in this campaign's buffer
      const insertResult = await client.query(
        `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11)
         ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
        [
          ctx.campaignId,
          outletId,
          ctx.orgId,
          ctx.brandIds,
          featureSlug,
          ctx.workflowSlug || null,
          o.whyRelevant,
          o.whyNotRelevant,
          o.relevanceScore,
          o.overallRelevance,
          options.runId || null,
        ]
      );
      if (insertResult.rowCount && insertResult.rowCount > 0) inserted++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`[outlets-service] Discover: inserted ${inserted} outlets into buffer for campaign ${ctx.campaignId}`);
  return inserted;
}

/** Mini-discover: lightweight wrapper around discoverOutlets with default params. */
async function miniDiscover(ctx: OrgContext): Promise<number> {
  return discoverOutlets(ctx, {
    queryCount: MINI_DISCOVER_QUERY_COUNT,
    resultsPerQuery: MINI_DISCOVER_RESULTS_PER_QUERY,
    runId: ctx.runId,
  });
}

const router = Router();

// POST /buffer/next — pull the next best outlet(s) from the buffer
router.post(
  "/next",
  validateBody(bufferNextSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    if (!ctx.campaignId || ctx.brandIds.length === 0) {
      res.status(400).json({ error: "x-campaign-id and x-brand-id headers are required" });
      return;
    }

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
      let didRefill = false;

      for (let i = 0; i < MAX_CLAIM_ITERATIONS && collected.length < count; i++) {
        const claimed = await claimNext(ctx.campaignId);

        if (!claimed) {
          // Buffer empty — try mini-discover once
          if (didRefill) break;

          const filled = await miniDiscover(ctx);
          didRefill = true;

          if (filled === 0) break;
          continue; // retry claim from freshly filled buffer
        }

        // Check if outlet is blocked (contacted / in cooldown) via journalists-service
        const blocked = await isBlocked(claimed.outletId, ctx.orgId, ctx.brandIds, ctx);
        if (blocked) {
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
