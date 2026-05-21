import { z } from "zod";
import { pool } from "../db/pool";
import { chatComplete } from "./chat";
import { validateOutletBatch } from "./google";
import { extractFields, findField } from "./brand";
import { getFeatureInputs } from "./campaign";
import {
  GENERATE_CATEGORIES_SYSTEM_PROMPT,
  GENERATE_OUTLETS_SYSTEM_PROMPT,
  SCORE_OUTLETS_SYSTEM_PROMPT,
  buildCategoryGenerationMessage,
  buildOutletGenerationMessage,
  buildReuseScoringMessage,
  type BrandPromptContext,
} from "../prompts";
import { isOutletBlocked } from "./journalists";
import type { OrgContext } from "../middleware/org-context";

const CATEGORY_BATCH_SIZE = 10;
const OUTLET_BATCH_SIZE = 10;
const CATEGORY_CAP = 100;
const MAX_CATEGORIES_PER_CAMPAIGN = 100;
const MAX_LLM_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 2000;

const BRAND_FIELDS = [
  { key: "brand_name", description: "The brand's display name" },
  { key: "elevator_pitch", description: "A concise elevator pitch describing what the brand does" },
  { key: "categories", description: "The brand's primary industry vertical or categories" },
  { key: "target_geo", description: "Priority geographic markets for outreach" },
  { key: "target_audience", description: "Target audience for the brand's products or services" },
  { key: "angles", description: "PR angles and editorial hooks the brand can leverage" },
];

const categoryGenerationSchema = z.object({
  categories: z.array(
    z.object({
      name: z.string(),
      geo: z.string(),
      rank: z.number(),
      rationale: z.string(),
    })
  ),
});

const outletGenerationSchema = z.object({
  outlets: z.array(
    z.object({
      name: z.string(),
      domain: z.string(),
      whyRelevant: z.string(),
      relevanceScore: z.number().int().min(1).max(100),
    })
  ),
});

const reuseScoringSchema = z.object({
  outlets: z.array(
    z.object({
      outletId: z.string(),
      relevanceScore: z.number().int().min(1).max(100),
      whyRelevant: z.string(),
    })
  ),
});

// JSON Schemas passed to chat-service /complete `responseSchema`. Forwarded to
// Gemini `generationConfig.responseSchema`, which enforces shape at decoding
// time and eliminates structural drift in long list outputs.
const categoryGenerationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          geo: { type: "string" },
          rank: { type: "integer" },
          rationale: { type: "string" },
        },
        required: ["name", "geo", "rank", "rationale"],
      },
    },
  },
  required: ["categories"],
};

const outletGenerationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    outlets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          domain: { type: "string" },
          whyRelevant: { type: "string" },
          relevanceScore: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["name", "domain", "whyRelevant", "relevanceScore"],
      },
    },
  },
  required: ["outlets"],
};

const reuseScoringJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    outlets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          outletId: { type: "string" },
          relevanceScore: { type: "integer", minimum: 1, maximum: 100 },
          whyRelevant: { type: "string" },
        },
        required: ["outletId", "relevanceScore", "whyRelevant"],
      },
    },
  },
  required: ["outlets"],
};

export interface CampaignCategory {
  id: string;
  campaignId: string;
  categoryName: string;
  categoryGeo: string;
  relevanceRank: number;
  status: "active" | "exhausted" | "capped";
  outletsFound: number;
  batchNumber: number;
}

async function buildBrandContext(ctx: OrgContext): Promise<{
  brandContext: BrandPromptContext;
  featureInput: Record<string, unknown> | undefined;
}> {
  const [extractedFields, featureInputs] = await Promise.all([
    extractFields(BRAND_FIELDS, ctx),
    getFeatureInputs(ctx.campaignId!, ctx),
  ]);

  const brandContext: BrandPromptContext = {
    brandName: findField(extractedFields, "brand_name") || "Unknown",
    brandDescription: findField(extractedFields, "elevator_pitch") || "No description available",
    industry: findField(extractedFields, "categories") || "General",
    targetGeo: findField(extractedFields, "target_geo") || undefined,
    targetAudience: findField(extractedFields, "target_audience") || undefined,
    angles: (() => {
      const raw = findField(extractedFields, "angles");
      return raw ? raw.split(", ") : undefined;
    })(),
  };

  return { brandContext, featureInput: featureInputs ?? undefined };
}

/**
 * Get all categories for a campaign (for passing to LLM as "already used").
 */
async function getAllCategories(campaignId: string): Promise<Array<{ name: string; geo: string }>> {
  const result = await pool.query(
    `SELECT category_name, category_geo FROM campaign_categories WHERE campaign_id = $1`,
    [campaignId]
  );
  return result.rows.map((r: { category_name: string; category_geo: string }) => ({
    name: r.category_name,
    geo: r.category_geo,
  }));
}

/**
 * Generate a batch of 10 categories via LLM and insert them.
 * Returns the number of categories inserted.
 */
export async function generateCategoryBatch(ctx: OrgContext): Promise<number> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);
  const alreadyUsed = await getAllCategories(ctx.campaignId!);

  // Determine batch number
  const batchResult = await pool.query(
    `SELECT COALESCE(MAX(batch_number), 0) AS max_batch FROM campaign_categories WHERE campaign_id = $1`,
    [ctx.campaignId]
  );
  const nextBatch = Number(batchResult.rows[0].max_batch) + 1;

  // Determine base rank (continue ranking from where we left off)
  const rankResult = await pool.query(
    `SELECT COALESCE(MAX(relevance_rank), 0) AS max_rank FROM campaign_categories WHERE campaign_id = $1`,
    [ctx.campaignId]
  );
  const baseRank = Number(rankResult.rows[0].max_rank);

  let parsedCategories: z.infer<typeof categoryGenerationSchema>["categories"] | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
    const response = await chatComplete(
      {
        provider: "google",
        model: "flash",
        message: buildCategoryGenerationMessage(brandContext, alreadyUsed, featureInput),
        systemPrompt: GENERATE_CATEGORIES_SYSTEM_PROMPT,
        responseFormat: "json",
        responseSchema: categoryGenerationJsonSchema,
        temperature: 0.7,
      },
      ctx
    );

    const parsed = categoryGenerationSchema.safeParse(response.json);
    if (parsed.success && parsed.data.categories.length > 0) {
      parsedCategories = parsed.data.categories;
      break;
    }

    if (retry < MAX_LLM_RETRIES) {
      console.warn(`[outlets-service] Category generation: LLM returned invalid format (attempt ${retry + 1}/${MAX_LLM_RETRIES + 1}), retrying in ${LLM_RETRY_DELAY_MS}ms:`, response.content);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    } else {
      console.error(`[outlets-service] Category generation: LLM failed after ${MAX_LLM_RETRIES + 1} attempts:`, response.content);
    }
  }

  if (!parsedCategories) return 0;

  // Dedup against already used
  const usedSet = new Set(alreadyUsed.map((c) => `${c.name}|||${c.geo}`));
  const newCategories = parsedCategories
    .filter((c) => !usedSet.has(`${c.name}|||${c.geo}`))
    .slice(0, CATEGORY_BATCH_SIZE);

  if (newCategories.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < newCategories.length; i++) {
    const c = newCategories[i];
    const result = await pool.query(
      `INSERT INTO campaign_categories (campaign_id, category_name, category_geo, relevance_rank, batch_number)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (campaign_id, category_name, category_geo) DO NOTHING`,
      [ctx.campaignId, c.name, c.geo, baseRank + i + 1, nextBatch]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  console.log(`[outlets-service] Generated ${inserted} categories (batch ${nextBatch}) for campaign ${ctx.campaignId}`);
  return inserted;
}

/**
 * Get the active category with the lowest relevance rank.
 */
export async function getActiveCategory(campaignId: string): Promise<CampaignCategory | null> {
  const result = await pool.query(
    `SELECT id, campaign_id, category_name, category_geo, relevance_rank, status, outlets_found, batch_number
     FROM campaign_categories
     WHERE campaign_id = $1 AND status = 'active'
     ORDER BY relevance_rank ASC
     LIMIT 1`,
    [campaignId]
  );

  if (result.rows.length === 0) return null;

  const r = result.rows[0];
  return {
    id: r.id,
    campaignId: r.campaign_id,
    categoryName: r.category_name,
    categoryGeo: r.category_geo,
    relevanceRank: Number(r.relevance_rank),
    status: r.status,
    outletsFound: Number(r.outlets_found),
    batchNumber: Number(r.batch_number),
  };
}

/**
 * Discover outlets within a specific category.
 * Asks LLM for 10 outlets, validates each via Google, inserts valid ones.
 * Returns number of new outlets inserted.
 * Marks category exhausted if 0 new validated outlets, or capped if >= CATEGORY_CAP.
 */
export async function discoverOutletsInCategory(
  category: CampaignCategory,
  ctx: OrgContext
): Promise<number> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);

  // Get already-known domains for this category (from the per-category tracking table)
  const knownResult = await pool.query(
    `SELECT o.outlet_domain FROM campaign_category_outlets cco
     JOIN outlets o ON o.id = cco.outlet_id
     WHERE cco.category_id = $1`,
    [category.id]
  );
  const knownDomains: string[] = knownResult.rows.map((r: { outlet_domain: string }) => r.outlet_domain);

  // Ask LLM for 10 outlets (with retry on invalid format)
  let parsedOutlets: z.infer<typeof outletGenerationSchema>["outlets"] | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
    const response = await chatComplete(
      {
        provider: "google",
        model: "flash",
        message: buildOutletGenerationMessage(
          brandContext,
          category.categoryName,
          category.categoryGeo,
          knownDomains,
          featureInput
        ),
        systemPrompt: GENERATE_OUTLETS_SYSTEM_PROMPT,
        responseFormat: "json",
        responseSchema: outletGenerationJsonSchema,
        temperature: 0.7,

      },
      ctx
    );

    const parsed = outletGenerationSchema.safeParse(response.json);
    if (parsed.success && parsed.data.outlets.length > 0) {
      parsedOutlets = parsed.data.outlets;
      break;
    }

    if (retry < MAX_LLM_RETRIES) {
      console.warn(`[outlets-service] Outlet generation: LLM returned invalid format (attempt ${retry + 1}/${MAX_LLM_RETRIES + 1}), retrying in ${LLM_RETRY_DELAY_MS}ms:`, response.content);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    } else {
      console.error(`[outlets-service] Outlet generation: LLM failed after ${MAX_LLM_RETRIES + 1} attempts for category "${category.categoryName} / ${category.categoryGeo}"`);
    }
  }

  if (!parsedOutlets) {
    // All LLM retries failed — mark category exhausted to avoid infinite loop
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (LLM failed) for campaign ${category.campaignId}`);
    return 0;
  }

  // Filter out already-known domains (LLM might repeat them despite instructions)
  const knownSet = new Set(knownDomains);
  const candidates = parsedOutlets
    .map((o) => ({
      ...o,
      domain: o.domain.replace(/^www\./, "").toLowerCase(),
    }))
    .filter((o) => !knownSet.has(o.domain));

  if (candidates.length === 0) {
    // All were duplicates — mark exhausted
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (all duplicates) for campaign ${category.campaignId}`);
    return 0;
  }

  // Split candidates: already in outlets table (previously validated) vs truly new
  const existingResult = await pool.query(
    `SELECT outlet_domain FROM outlets WHERE outlet_domain = ANY($1)`,
    [candidates.map((c) => c.domain)]
  );
  const existingDomains = new Set(
    existingResult.rows.map((r: { outlet_domain: string }) => r.outlet_domain)
  );
  const alreadyValidated = candidates.filter((c) => existingDomains.has(c.domain));
  const needsValidation = candidates.filter((c) => !existingDomains.has(c.domain));

  // Only validate truly new domains via Google
  let validOutlets: typeof candidates;
  if (needsValidation.length > 0) {
    console.log(`[outlets-service] Validating ${needsValidation.length} new outlet candidates via Google for category "${category.categoryName} / ${category.categoryGeo}" (${alreadyValidated.length} already known)`);
    const validated = await validateOutletBatch(needsValidation, ctx);
    const googleValid = validated.filter((o) => o.valid);
    console.log(`[outlets-service] Google validation: ${googleValid.length}/${needsValidation.length} validated for "${category.categoryName} / ${category.categoryGeo}"`);
    validOutlets = [...alreadyValidated, ...googleValid];
  } else {
    console.log(`[outlets-service] All ${alreadyValidated.length} outlet candidates already known for category "${category.categoryName} / ${category.categoryGeo}", skipping Google validation`);
    validOutlets = alreadyValidated;
  }

  if (validOutlets.length === 0) {
    // No valid outlets — mark exhausted
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (0 validated) for campaign ${category.campaignId}`);
    return 0;
  }

  // Sort by domain to ensure consistent lock ordering across concurrent transactions (prevents deadlocks)
  validOutlets.sort((a, b) => a.domain.localeCompare(b.domain));

  // Insert valid outlets
  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (const o of validOutlets) {
      const url = `https://${o.domain}`;

      const outletResult = await client.query(
        `INSERT INTO outlets (outlet_name, outlet_url, outlet_domain)
         VALUES ($1, $2, $3)
         ON CONFLICT (outlet_domain)
         DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_url = EXCLUDED.outlet_url, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [o.name, url, o.domain]
      );
      const outletId = outletResult.rows[0].id;

      // Track in per-category table (always succeeds for new category+outlet pair)
      const ccoResult = await client.query(
        `INSERT INTO campaign_category_outlets (campaign_id, category_id, outlet_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [ctx.campaignId, category.id, outletId]
      );
      const relevanceScore = o.relevanceScore;

      // Insert into campaign buffer (may conflict if outlet already in campaign from another category)
      const bufferResult = await client.query(
        `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, run_id, category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 'discovered', $10, $11, $12, $13)
         ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
        [
          ctx.campaignId,
          outletId,
          ctx.orgId,
          ctx.brandIds,
          ctx.featureSlug,
          ctx.workflowSlug,
          o.whyRelevant,
          `Category: ${category.categoryName} / ${category.categoryGeo}`,
          relevanceScore,
          `Discovered via category "${category.categoryName}" (${category.categoryGeo}), score=${relevanceScore}`,
          "high",
          ctx.runId,
          category.id,
        ]
      );
      if (bufferResult.rowCount && bufferResult.rowCount > 0) inserted++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Update category outlets_found counter
  if (inserted > 0) {
    await pool.query(
      `UPDATE campaign_categories SET outlets_found = outlets_found + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [inserted, category.id]
    );
  }

  // Check if category should be capped
  const updatedCategory = await pool.query(
    `SELECT outlets_found FROM campaign_categories WHERE id = $1`,
    [category.id]
  );
  const totalFound = Number(updatedCategory.rows[0].outlets_found);
  if (totalFound >= CATEGORY_CAP) {
    await markCategoryStatus(category.id, "capped");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" capped at ${totalFound} outlets for campaign ${category.campaignId}`);
  }

  console.log(`[outlets-service] Discovered ${inserted} outlets in category "${category.categoryName} / ${category.categoryGeo}" for campaign ${category.campaignId}`);
  return inserted;
}

async function markCategoryStatus(categoryId: string, status: "exhausted" | "capped"): Promise<void> {
  await pool.query(
    `UPDATE campaign_categories SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [status, categoryId]
  );
}

const REUSE_BATCH_SIZE = 10;

/**
 * Reuse cycle: recycle outlets already known for this brand but not yet in this campaign.
 * 1. Fetch 10 reusable outlets
 * 2. Check blocked via journalists-service (free call) → insert blocked as 'skipped'
 * 3. Score non-blocked via LLM → insert all with 'open'
 * Returns total inserted (blocked + scored). Returns 0 when no reusable outlets remain.
 */
export async function reuseCycle(ctx: OrgContext): Promise<number> {
  // Find outlets associated with this brand in other campaigns, not yet in this campaign
  const reusable = await pool.query(
    `SELECT DISTINCT o.id AS outlet_id, o.outlet_name, o.outlet_domain
     FROM campaign_outlets co
     JOIN outlets o ON o.id = co.outlet_id
     WHERE co.brand_ids && $1
       AND co.outlet_id NOT IN (
         SELECT outlet_id FROM campaign_outlets WHERE campaign_id = $2
       )
     LIMIT $3`,
    [ctx.brandIds, ctx.campaignId, REUSE_BATCH_SIZE]
  );

  if (reusable.rows.length === 0) {
    console.log(`[outlets-service] reuseCycle: no reusable outlets for campaign ${ctx.campaignId}`);
    return 0;
  }

  const outlets = reusable.rows.map((r: { outlet_id: string; outlet_name: string; outlet_domain: string }) => ({
    outletId: r.outlet_id,
    outletName: r.outlet_name,
    outletDomain: r.outlet_domain,
  }));

  console.log(`[outlets-service] reuseCycle: checking ${outlets.length} reusable outlets for campaign ${ctx.campaignId}`);

  // Step 1: Check blocked status (free call — no LLM cost)
  const blocked: typeof outlets = [];
  const available: typeof outlets = [];

  for (const o of outlets) {
    const result = await isOutletBlocked(o.outletId, ctx);
    if (result.blocked) {
      blocked.push(o);
    } else {
      available.push(o);
    }
  }

  let inserted = 0;

  // Step 2: Insert blocked outlets as 'skipped' (no LLM needed)
  for (const o of blocked) {
    const result = await pool.query(
      `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'skipped', 'blocked', $10, $11, $12)
       ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
      [
        ctx.campaignId,
        o.outletId,
        ctx.orgId,
        ctx.brandIds,
        ctx.featureSlug,
        ctx.workflowSlug,
        "Reused from previous campaign",
        "Blocked — journalist contacted in cooldown period",
        0,
        `Reuse cycle: outlet ${o.outletId} (${o.outletDomain}) blocked — journalist already contacted or in cooldown`,
        "low",
        ctx.runId,
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  if (blocked.length > 0) {
    console.log(`[outlets-service] reuseCycle: ${blocked.length} outlets blocked, inserted as skipped`);
  }

  // Step 3: Score non-blocked outlets via LLM
  if (available.length === 0) {
    console.log(`[outlets-service] reuseCycle: all ${outlets.length} outlets blocked for campaign ${ctx.campaignId}`);
    return inserted;
  }

  const { brandContext, featureInput } = await buildBrandContext(ctx);

  let parsedScores: z.infer<typeof reuseScoringSchema>["outlets"] | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
    const response = await chatComplete(
      {
        provider: "google",
        model: "flash",
        message: buildReuseScoringMessage(brandContext, available, featureInput ?? undefined),
        systemPrompt: SCORE_OUTLETS_SYSTEM_PROMPT,
        responseFormat: "json",
        responseSchema: reuseScoringJsonSchema,
        temperature: 0.3,

      },
      ctx
    );

    const parsed = reuseScoringSchema.safeParse(response.json);
    if (parsed.success && parsed.data.outlets.length > 0) {
      parsedScores = parsed.data.outlets;
      break;
    }

    if (retry < MAX_LLM_RETRIES) {
      console.warn(`[outlets-service] reuseCycle: LLM returned invalid format (attempt ${retry + 1}/${MAX_LLM_RETRIES + 1}), retrying in ${LLM_RETRY_DELAY_MS}ms:`, response.content);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    } else {
      console.error(`[outlets-service] reuseCycle: LLM failed after ${MAX_LLM_RETRIES + 1} attempts`);
    }
  }

  if (!parsedScores) {
    // LLM failed — insert all with a neutral score so we don't re-process them
    console.warn(`[outlets-service] reuseCycle: LLM scoring failed, inserting ${available.length} outlets with default score 50`);
    for (const o of available) {
      const result = await pool.query(
        `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 'reused', $10, $11, $12)
         ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
        [
          ctx.campaignId,
          o.outletId,
          ctx.orgId,
          ctx.brandIds,
          ctx.featureSlug,
          ctx.workflowSlug,
          "Reused from previous campaign (scoring failed)",
          "",
          50,
          `Reuse cycle: LLM scoring failed, assigned default score 50 for outlet ${o.outletId} (${o.outletDomain})`,
          "medium",
          ctx.runId,
        ]
      );
      if (result.rowCount && result.rowCount > 0) inserted++;
    }
    console.log(`[outlets-service] reuseCycle: inserted ${inserted} outlets (${blocked.length} blocked + ${available.length} default-scored) for campaign ${ctx.campaignId}`);
    return inserted;
  }

  // Build a map of scores by outletId
  const scoreMap = new Map(parsedScores.map((s) => [s.outletId, s]));

  for (const o of available) {
    const score = scoreMap.get(o.outletId);
    const relevanceScore = score?.relevanceScore ?? 50;
    const whyRelevant = score?.whyRelevant ?? "Reused from previous campaign";

    const result = await pool.query(
      `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 'reused', $10, $11, $12)
       ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
      [
        ctx.campaignId,
        o.outletId,
        ctx.orgId,
        ctx.brandIds,
        ctx.featureSlug,
        ctx.workflowSlug,
        whyRelevant,
        "Reused from previous campaign",
        relevanceScore,
        `Reuse cycle: outlet ${o.outletId} (${o.outletDomain}) scored ${relevanceScore} by LLM`,
        relevanceScore >= 60 ? "high" : relevanceScore >= 30 ? "medium" : "low",
        ctx.runId,
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  console.log(`[outlets-service] reuseCycle: inserted ${inserted} outlets (${blocked.length} blocked/skipped, ${available.length} scored) for campaign ${ctx.campaignId}`);
  return inserted;
}

/**
 * Main discovery cycle entry point.
 * Loops across categories until it finds outlets. When a category is exhausted,
 * moves to the next active category. When all categories are exhausted, generates
 * a new batch. Only returns 0 when the campaign reaches the category cap (100)
 * and no new categories can be generated — never because a single category was exhausted.
 */
export async function discoverCycle(ctx: OrgContext): Promise<number> {
  // Ensure at least one batch of categories exists
  const existing = await pool.query(
    `SELECT COUNT(*) AS cnt FROM campaign_categories WHERE campaign_id = $1`,
    [ctx.campaignId]
  );
  if (Number(existing.rows[0].cnt) === 0) {
    const generated = await generateCategoryBatch(ctx);
    if (generated === 0) {
      console.error("[outlets-service] discoverCycle: failed to generate initial categories");
      return 0;
    }
  }

  // Loop until we find outlets — only exits on category cap or generation failure
  while (true) {
    let activeCategory = await getActiveCategory(ctx.campaignId!);

    // If no active category, all are exhausted/capped — generate a new batch
    if (!activeCategory) {
      const countResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM campaign_categories WHERE campaign_id = $1`,
        [ctx.campaignId]
      );
      const totalCategories = Number(countResult.rows[0].cnt);
      if (totalCategories >= MAX_CATEGORIES_PER_CAMPAIGN) {
        console.log(`[outlets-service] discoverCycle: campaign ${ctx.campaignId} reached category cap (${totalCategories}/${MAX_CATEGORIES_PER_CAMPAIGN})`);
        return 0;
      }

      console.log(`[outlets-service] discoverCycle: all categories exhausted for campaign ${ctx.campaignId}, generating new batch (${totalCategories}/${MAX_CATEGORIES_PER_CAMPAIGN})`);
      const generated = await generateCategoryBatch(ctx);
      if (generated === 0) {
        console.log(`[outlets-service] discoverCycle: could not generate new categories for campaign ${ctx.campaignId}`);
        return 0;
      }
      activeCategory = await getActiveCategory(ctx.campaignId!);
      if (!activeCategory) return 0;
    }

    const found = await discoverOutletsInCategory(activeCategory, ctx);
    if (found > 0) return found;

    // Category was exhausted (0 outlets) — loop to try the next one
    console.log(`[outlets-service] discoverCycle: category "${activeCategory.categoryName}" yielded 0, trying next`);
  }
}
