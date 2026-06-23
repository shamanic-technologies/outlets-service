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
import { normalizeOutletDomain } from "../lib/domain";
import type { OrgContext } from "../middleware/org-context";

const OUTLET_BATCH_SIZE = 10;
const CATEGORY_CAP = 100;
const TARGET_CATEGORIES_PER_CAMPAIGN = 100;
const MAX_LLM_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 2000;

// Threshold used to label overall_relevance ("high"/"medium"/"low"). Distinct
// from buffer.ts MIN_ACCEPTANCE_SCORE: an outlet at score 25 still gets
// processed (above acceptance gate=20) but is flagged "low" relevance.
const RELEVANCE_THRESHOLD = 30;

function relevanceBand(score: number): "high" | "medium" | "low" {
  if (score >= 60) return "high";
  if (score >= RELEVANCE_THRESHOLD) return "medium";
  return "low";
}

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
      score: z.number().int().min(0).max(100),
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
// Gemini's schema dialect is an OpenAPI 3.0 subset and rejects
// `additionalProperties` with HTTP 400 — do not add it. (Anthropic's strict
// mode requires it; if we ever swap provider, schemas need a conditional.)
const categoryGenerationJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          geo: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string" },
        },
        required: ["name", "geo", "score", "rationale"],
      },
    },
  },
  required: ["categories"],
};

const outletGenerationJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    outlets: {
      type: "array",
      items: {
        type: "object",
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
  properties: {
    outlets: {
      type: "array",
      items: {
        type: "object",
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
  relevanceScore: number;
  status: "active" | "exhausted" | "capped";
  outletsFound: number;
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
 * Generate all categories upfront for a campaign — 1× LLM call producing 100
 * categories, each scored 0-100. Run once per campaign at first discoverCycle.
 * Uses Gemini Pro for higher-quality MECE coverage.
 *
 * Returns the number of categories inserted.
 */
export async function generateAllCategories(ctx: OrgContext): Promise<number> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);

  let parsedCategories: z.infer<typeof categoryGenerationSchema>["categories"] | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
    const response = await chatComplete(
      {
        provider: "google",
        model: "pro",
        message: buildCategoryGenerationMessage(brandContext, featureInput),
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

  // Dedup within batch by (name, geo)
  const seenKeys = new Set<string>();
  const uniqueCategories = parsedCategories.filter((c) => {
    const key = `${c.name}|||${c.geo}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  }).slice(0, TARGET_CATEGORIES_PER_CAMPAIGN);

  if (uniqueCategories.length === 0) return 0;

  let inserted = 0;
  for (const c of uniqueCategories) {
    const result = await pool.query(
      `INSERT INTO campaign_categories (campaign_id, category_name, category_geo, relevance_score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, category_name, category_geo) DO NOTHING`,
      [ctx.campaignId, c.name, c.geo, c.score]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }

  console.log(`[outlets-service] Generated ${inserted} categories upfront for campaign ${ctx.campaignId}`);
  return inserted;
}

/**
 * Get the highest-scoring active category, ties broken by category name.
 */
export async function getActiveCategory(campaignId: string): Promise<CampaignCategory | null> {
  const result = await pool.query(
    `SELECT id, campaign_id, category_name, category_geo, relevance_score, status, outlets_found
     FROM campaign_categories
     WHERE campaign_id = $1 AND status = 'active'
     ORDER BY relevance_score DESC NULLS LAST, category_name ASC
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
    relevanceScore: r.relevance_score == null ? 0 : Number(r.relevance_score),
    status: r.status,
    outletsFound: Number(r.outlets_found),
  };
}

/**
 * Discover outlets within a specific category.
 * Asks LLM for 10 outlets, validates each via Google, inserts valid ones.
 * Returns number of new outlets inserted.
 * Marks category exhausted if 0 new validated outlets, or capped if >= CATEGORY_CAP.
 *
 * Tracks Google-rejected domains in `campaign_category_rejected_domains` so
 * the LLM's "known domains" prompt list grows across iterations, preventing
 * the model from re-proposing the same dead-end domains.
 */
export async function discoverOutletsInCategory(
  category: CampaignCategory,
  ctx: OrgContext
): Promise<{ inserted: number; domains: string[] }> {
  const { brandContext, featureInput } = await buildBrandContext(ctx);

  // Known domains for this category = validated outlets (cco) ∪ Google-rejected
  // domains. Union prevents LLM from re-proposing domains it already burned.
  const knownResult = await pool.query(
    `SELECT outlet_domain FROM (
       SELECT o.outlet_domain
       FROM campaign_category_outlets cco
       JOIN outlets o ON o.id = cco.outlet_id
       WHERE cco.category_id = $1
       UNION
       SELECT domain AS outlet_domain
       FROM campaign_category_rejected_domains
       WHERE category_id = $1
     ) all_known`,
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
    return { inserted: 0, domains: [] };
  }

  // Normalize LLM-emitted domains to valid bare hosts; DROP any that are junk
  // (e.g. "-", path-bearing, whitespace) so a non-domain value never enters the
  // outlets table or, later, an ahref enrichment batch. This is the producer
  // root-cause fix — the LLM occasionally emits a placeholder domain.
  const normalizedOutlets = parsedOutlets.map((o) => ({
    ...o,
    domain: normalizeOutletDomain(o.domain),
    rawDomain: o.domain,
  }));
  const droppedDomains = normalizedOutlets.filter((o) => o.domain === null);
  if (droppedDomains.length > 0) {
    console.warn(
      `[outlets-service] discovery: dropping ${droppedDomains.length} outlet(s) with invalid domain from LLM output: ${droppedDomains
        .slice(0, 5)
        .map((o) => JSON.stringify(o.rawDomain))
        .join(", ")}`
    );
  }

  // Filter out already-known domains (LLM might repeat them despite instructions)
  const knownSet = new Set(knownDomains);
  const candidates = normalizedOutlets
    .filter((o): o is typeof o & { domain: string } => o.domain !== null)
    .filter((o) => !knownSet.has(o.domain));

  if (candidates.length === 0) {
    // All were duplicates — mark exhausted
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (all duplicates) for campaign ${category.campaignId}`);
    return { inserted: 0, domains: [] };
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
  let googleRejected: typeof candidates = [];
  if (needsValidation.length > 0) {
    console.log(`[outlets-service] Validating ${needsValidation.length} new outlet candidates via Google for category "${category.categoryName} / ${category.categoryGeo}" (${alreadyValidated.length} already known)`);
    const validated = await validateOutletBatch(needsValidation, ctx);
    const validDomains = new Set(validated.filter((o) => o.valid).map((o) => o.domain));
    const googleValid = needsValidation.filter((o) => validDomains.has(o.domain));
    googleRejected = needsValidation.filter((o) => !validDomains.has(o.domain));
    console.log(`[outlets-service] Google validation: ${googleValid.length}/${needsValidation.length} validated for "${category.categoryName} / ${category.categoryGeo}"`);
    validOutlets = [...alreadyValidated, ...googleValid];
  } else {
    console.log(`[outlets-service] All ${alreadyValidated.length} outlet candidates already known for category "${category.categoryName} / ${category.categoryGeo}", skipping Google validation`);
    validOutlets = alreadyValidated;
  }

  // Track Google-rejected domains so the next LLM call sees them as "known" and
  // doesn't propose them again. Fire-and-forget per row, ON CONFLICT skips dups.
  for (const r of googleRejected) {
    await pool.query(
      `INSERT INTO campaign_category_rejected_domains (campaign_id, category_id, domain)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [ctx.campaignId, category.id, r.domain]
    );
  }

  if (validOutlets.length === 0) {
    // No valid outlets — mark exhausted
    await markCategoryStatus(category.id, "exhausted");
    console.log(`[outlets-service] Category "${category.categoryName} / ${category.categoryGeo}" exhausted (0 validated) for campaign ${category.campaignId}`);
    return { inserted: 0, domains: [] };
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
      await client.query(
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
          relevanceBand(relevanceScore),
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
  return { inserted, domains: validOutlets.map((o) => o.domain) };
}

async function markCategoryStatus(categoryId: string, status: "exhausted" | "capped"): Promise<void> {
  await pool.query(
    `UPDATE campaign_categories SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [status, categoryId]
  );
}

const REUSE_BATCH_SIZE = 10;

interface ReusableOutlet {
  outletId: string;
  outletName: string;
  outletDomain: string;
  previousWhyRelevant: string;
  previousWhyNotRelevant: string;
  previousRelevanceScore: number;
  previousOverallRelevance: string | null;
  previousRelevanceRationale: string | null;
}

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
    `WITH reusable AS (
       SELECT o.id AS outlet_id, o.outlet_name, o.outlet_domain,
              co.why_relevant, co.why_not_relevant, co.relevance_score,
              co.overall_relevance, co.relevance_rationale, co.updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY o.id
                ORDER BY co.relevance_score DESC NULLS LAST, co.updated_at DESC
              ) AS rn
       FROM campaign_outlets co
       JOIN outlets o ON o.id = co.outlet_id
       WHERE co.brand_ids && $1
         AND co.campaign_id <> $2
         AND NOT EXISTS (
           SELECT 1 FROM campaign_outlets existing
           WHERE existing.campaign_id = $2 AND existing.outlet_id = co.outlet_id
         )
     )
     SELECT outlet_id, outlet_name, outlet_domain, why_relevant, why_not_relevant,
            relevance_score, overall_relevance, relevance_rationale
     FROM reusable
     WHERE rn = 1
     ORDER BY relevance_score DESC NULLS LAST, updated_at DESC
     LIMIT $3`,
    [ctx.brandIds, ctx.campaignId, REUSE_BATCH_SIZE]
  );

  if (reusable.rows.length === 0) {
    console.log(`[outlets-service] reuseCycle: no reusable outlets for campaign ${ctx.campaignId}`);
    return 0;
  }

  const outlets: ReusableOutlet[] = reusable.rows.map((r: {
    outlet_id: string;
    outlet_name: string;
    outlet_domain: string;
    why_relevant: string;
    why_not_relevant: string;
    relevance_score: string | number;
    overall_relevance: string | null;
    relevance_rationale: string | null;
  }) => {
    const previousRelevanceScore = Number(r.relevance_score);

    return {
      outletId: r.outlet_id,
      outletName: r.outlet_name,
      outletDomain: r.outlet_domain,
      previousWhyRelevant: r.why_relevant,
      previousWhyNotRelevant: r.why_not_relevant,
      previousRelevanceScore,
      previousOverallRelevance: r.overall_relevance,
      previousRelevanceRationale: r.relevance_rationale,
    };
  });

  console.log(`[outlets-service] reuseCycle: checking ${outlets.length} reusable outlets for campaign ${ctx.campaignId}`);

  // Step 1: Check blocked status (free call — no LLM cost)
  const blocked: ReusableOutlet[] = [];
  const available: ReusableOutlet[] = [];

  for (const o of outlets) {
    const result = await isOutletBlocked(o.outletId, ctx);
    if (result.blocked) {
      blocked.push(o);
    } else {
      available.push(o);
    }
  }

  let inserted = 0;

  // Step 2: Insert blocked outlets as 'skipped' while preserving relevance from prior scoring.
  for (const o of blocked) {
    const result = await pool.query(
      `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, relevance_rationale, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'skipped', 'blocked', $10, $11, $12, $13)
       ON CONFLICT (campaign_id, outlet_id) DO NOTHING`,
      [
        ctx.campaignId,
        o.outletId,
        ctx.orgId,
        ctx.brandIds,
        ctx.featureSlug,
        ctx.workflowSlug,
        o.previousWhyRelevant,
        o.previousWhyNotRelevant,
        o.previousRelevanceScore,
        `Reuse cycle: outlet ${o.outletId} (${o.outletDomain}) blocked — journalist already contacted or in cooldown`,
        o.previousOverallRelevance ?? relevanceBand(o.previousRelevanceScore),
        o.previousRelevanceRationale,
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
        relevanceBand(relevanceScore),
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
 *
 * 1. If the campaign has no categories yet, generate all 100 upfront via 1 LLM
 *    call (Gemini Pro). Single shot, no incremental batches.
 * 2. Loop active categories by score DESC. Each call to discoverOutletsInCategory
 *    either yields outlets (return immediately) or exhausts the category and we
 *    try the next one.
 * 3. When no active category remains, the campaign's discovery is over —
 *    return 0. Never regenerate categories.
 */
export async function discoverCycle(ctx: OrgContext): Promise<{ inserted: number; domains: string[] }> {
  // Ensure the upfront category batch has been generated
  const existing = await pool.query(
    `SELECT COUNT(*) AS cnt FROM campaign_categories WHERE campaign_id = $1`,
    [ctx.campaignId]
  );
  if (Number(existing.rows[0].cnt) === 0) {
    const generated = await generateAllCategories(ctx);
    if (generated === 0) {
      console.error("[outlets-service] discoverCycle: failed to generate initial categories");
      return { inserted: 0, domains: [] };
    }
  }

  // Loop until we find outlets or run out of active categories
  while (true) {
    const activeCategory = await getActiveCategory(ctx.campaignId!);

    if (!activeCategory) {
      console.log(`[outlets-service] discoverCycle: all categories exhausted for campaign ${ctx.campaignId}`);
      return { inserted: 0, domains: [] };
    }

    const found = await discoverOutletsInCategory(activeCategory, ctx);
    if (found.inserted > 0) return found;

    // Category was exhausted (0 outlets) — loop to try the next one
    console.log(`[outlets-service] discoverCycle: category "${activeCategory.categoryName}" yielded 0, trying next`);
  }
}
