import { z } from "zod";
import { pool } from "../db/pool";
import { chatComplete } from "./chat";
import { validateOutletBatch } from "./google";
import { extractFields, findField } from "./brand";
import { getFeatureInputs } from "./campaign";
import {
  GENERATE_CATEGORIES_SYSTEM_PROMPT,
  GENERATE_OUTLETS_SYSTEM_PROMPT,
  buildCategoryGenerationMessage,
  buildOutletGenerationMessage,
  type BrandPromptContext,
} from "../prompts";
import type { FullOrgContext } from "../middleware/org-context";

const CATEGORY_BATCH_SIZE = 10;
const OUTLET_BATCH_SIZE = 10;
const CATEGORY_CAP = 100;

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
    })
  ),
});

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

async function buildBrandContext(ctx: FullOrgContext): Promise<{
  brandContext: BrandPromptContext;
  featureInput: Record<string, unknown> | undefined;
}> {
  const [extractedFields, featureInputs] = await Promise.all([
    extractFields(BRAND_FIELDS, ctx),
    getFeatureInputs(ctx.campaignId, ctx),
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
export async function generateCategoryBatch(ctx: FullOrgContext): Promise<number> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);
  const alreadyUsed = await getAllCategories(ctx.campaignId);

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

  const response = await chatComplete(
    {
      provider: "google",
      model: "flash-lite",
      message: buildCategoryGenerationMessage(brandContext, alreadyUsed, featureInput),
      systemPrompt: GENERATE_CATEGORIES_SYSTEM_PROMPT,
      responseFormat: "json",
      temperature: 0.7,
      maxTokens: 2000,
    },
    ctx
  );

  const parsed = categoryGenerationSchema.safeParse(response.json);
  if (!parsed.success || parsed.data.categories.length === 0) {
    console.error("[outlets-service] Category generation: LLM returned invalid format:", response.content);
    return 0;
  }

  // Dedup against already used
  const usedSet = new Set(alreadyUsed.map((c) => `${c.name}|||${c.geo}`));
  const newCategories = parsed.data.categories
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
  ctx: FullOrgContext
): Promise<number> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);

  // Get already-known domains for this category
  const knownResult = await pool.query(
    `SELECT o.outlet_domain FROM campaign_outlets co
     JOIN outlets o ON o.id = co.outlet_id
     WHERE co.category_id = $1`,
    [category.id]
  );
  const knownDomains: string[] = knownResult.rows.map((r: { outlet_domain: string }) => r.outlet_domain);

  // Ask LLM for 10 outlets
  const response = await chatComplete(
    {
      provider: "google",
      model: "flash-lite",
      message: buildOutletGenerationMessage(
        brandContext,
        category.categoryName,
        category.categoryGeo,
        knownDomains,
        featureInput
      ),
      systemPrompt: GENERATE_OUTLETS_SYSTEM_PROMPT,
      responseFormat: "json",
      temperature: 0.7,
      maxTokens: 2000,
    },
    ctx
  );

  const parsed = outletGenerationSchema.safeParse(response.json);
  if (!parsed.success || parsed.data.outlets.length === 0) {
    console.error("[outlets-service] Outlet generation: LLM returned invalid format:", response.content);
    // Bad parse is NOT exhaustion — next attempt will retry
    return 0;
  }

  // Filter out already-known domains (LLM might repeat them despite instructions)
  const knownSet = new Set(knownDomains);
  const candidates = parsed.data.outlets
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

  // Validate via Google
  console.log(`[outlets-service] Validating ${candidates.length} outlet candidates via Google for category "${category.categoryName} / ${category.categoryGeo}"`);
  const validated = await validateOutletBatch(candidates, ctx);
  const validOutlets = validated.filter((o) => o.valid);

  if (validOutlets.length === 0) {
    // No valid outlets — mark exhausted
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (0 validated) for campaign ${category.campaignId}`);
    return 0;
  }

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

      // Relevance score: derived from category rank (higher rank = higher score)
      // Rank 1 → 98, rank 2 → 96, etc. Minimum 50.
      const relevanceScore = Math.max(50, 100 - category.relevanceRank * 2);

      const insertResult = await client.query(
        `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, run_id, category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12)
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
          "high",
          ctx.runId,
          category.id,
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

/**
 * Main discovery cycle entry point.
 * 1. Ensure categories exist (generate first batch if needed)
 * 2. Get active category
 * 3. If no active category, generate new batch
 * 4. Discover outlets in active category
 * Returns number of outlets inserted.
 */
export async function discoverCycle(ctx: FullOrgContext): Promise<number> {
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

  // Get active category
  let activeCategory = await getActiveCategory(ctx.campaignId);

  // If no active category, all are exhausted/capped — generate a new batch
  if (!activeCategory) {
    console.log(`[outlets-service] discoverCycle: all categories exhausted for campaign ${ctx.campaignId}, generating new batch`);
    const generated = await generateCategoryBatch(ctx);
    if (generated === 0) {
      console.log(`[outlets-service] discoverCycle: could not generate new categories for campaign ${ctx.campaignId}`);
      return 0;
    }
    activeCategory = await getActiveCategory(ctx.campaignId);
    if (!activeCategory) return 0;
  }

  return discoverOutletsInCategory(activeCategory, ctx);
}
