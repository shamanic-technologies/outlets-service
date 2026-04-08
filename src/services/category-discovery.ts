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

  // Get already-known domains for this category
  const knownResult = await pool.query(
    `SELECT o.outlet_domain FROM campaign_outlets co
     JOIN outlets o ON o.id = co.outlet_id
     WHERE co.category_id = $1`,
    [category.id]
  );
  const knownDomains: string[] = knownResult.rows.map((r: { outlet_domain: string }) => r.outlet_domain);

  // Ask LLM for 10 outlets (with retry on invalid format)
  let parsedOutlets: z.infer<typeof outletGenerationSchema>["outlets"] | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
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

      const relevanceScore = o.relevanceScore;

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
