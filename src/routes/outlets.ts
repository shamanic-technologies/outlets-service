import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { validateBody, validateQuery } from "../middleware/validate";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  listOutletsQuerySchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
} from "../schemas";
import { fetchOutletStatuses, countOutletStatuses, mergeStatusCounts, type ScopeFilters } from "../services/outlet-status";
import { getPublicPricingForOrg } from "../services/pricing";
import { getDrStatus } from "../services/ahref";
import { derivePriceRequestStatus } from "../services/price-requests";
import type { OrgContext } from "../middleware/org-context";

const router = Router();

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Normalize a domain the same way ahref-service does (www stripped, case-folded) so DR lookups match. */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "");
}

async function getDrStatusBestEffort(
  domains: string[],
  ctx: OrgContext
): Promise<Map<string, number | null>> {
  try {
    return await getDrStatus(domains, ctx);
  } catch (err) {
    console.warn("[outlets-service] ahref dr-status unavailable; returning null domainRating:", err);
    return new Map();
  }
}

// POST /org/outlets — create outlet (upsert by outlet_url)
router.post(
  "/",
  validateBody(createOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    try {
      const b = req.body;
      const domain = b.outletDomain || extractDomain(b.outletUrl);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const outletResult = await client.query(
          `INSERT INTO outlets (outlet_name, outlet_url, outlet_domain)
           VALUES ($1, $2, $3)
           ON CONFLICT (outlet_domain)
           DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_url = EXCLUDED.outlet_url, updated_at = CURRENT_TIMESTAMP
           RETURNING id, outlet_name, outlet_url, outlet_domain, created_at, updated_at`,
          [b.outletName, b.outletUrl, domain]
        );
        const outlet = outletResult.rows[0];

        await client.query(
          `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, relevance_rationale, run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (campaign_id, outlet_id)
           DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
             relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
             status_reason = EXCLUDED.status_reason, status_detail = EXCLUDED.status_detail,
             overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
             feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
             brand_ids = EXCLUDED.brand_ids, workflow_slug = EXCLUDED.workflow_slug,
             run_id = EXCLUDED.run_id,
             updated_at = CURRENT_TIMESTAMP`,
          [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandIds, ctx.featureSlug, ctx.workflowSlug, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.statusReason || "discovered", b.statusDetail || null, b.overallRelevance || null, b.relevanceRationale || null, ctx.runId]
        );

        await client.query("COMMIT");

        res.status(201).json({
          id: outlet.id,
          outletName: outlet.outlet_name,
          outletUrl: outlet.outlet_url,
          outletDomain: outlet.outlet_domain,
          campaignId: ctx.campaignId,
          brandIds: ctx.brandIds,
          whyRelevant: b.whyRelevant,
          whyNotRelevant: b.whyNotRelevant,
          relevanceScore: Number(b.relevanceScore),
          status: b.status || "open",
          statusReason: b.statusReason || "discovered",
          statusDetail: b.statusDetail || null,
          overallRelevance: b.overallRelevance || null,
          relevanceRationale: b.relevanceRationale || null,
          runId: ctx.runId,
          createdAt: outlet.created_at,
          updatedAt: outlet.updated_at,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[outlets-service] Error creating outlet:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /org/outlets — list with filters, deduplicated by outlet with nested campaigns
router.get(
  "/",
  validateQuery(listOutletsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ctx = req.orgContext!;
      const q = req.query as any;

      // Require at least brandId or campaignId — org-only scoping is not supported
      if (!q.brandId && !q.campaignId) {
        res.status(400).json({ error: "At least one of brandId or campaignId query parameter is required" });
        return;
      }

      const conditions: string[] = ["co.org_id = $1"];
      const params: unknown[] = [ctx.orgId];
      let paramIdx = 2;

      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${paramIdx++}`);
        params.push(q.campaignId);
      }
      if (q.brandId) {
        conditions.push(`$${paramIdx++} = ANY(co.brand_ids)`);
        params.push(q.brandId);
      }
      if (q.status) {
        conditions.push(`co.status = $${paramIdx++}`);
        params.push(q.status);
      }
      if (q.runId) {
        conditions.push(`co.run_id = $${paramIdx++}`);
        params.push(q.runId);
      }

      // Feature filter: plural slugs
      if (q.featureSlugs) {
        const slugs = q.featureSlugs.split(",").map((s: string) => s.trim()).filter(Boolean);
        if (slugs.length === 0) {
          res.json({ outlets: [], total: 0, byOutreachStatus: {} });
          return;
        }
        const placeholders = slugs.map((_: string, i: number) => `$${paramIdx + i}`).join(", ");
        conditions.push(`co.feature_slug IN (${placeholders})`);
        params.push(...slugs);
        paramIdx += slugs.length;
      }

      const where = `WHERE ${conditions.join(" AND ")}`;

      // Step 1: Get ALL distinct outlet IDs matching filters (no pagination — used for total + enrichment)
      const allIdsResult = await pool.query(
        `SELECT DISTINCT o.id
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         ${where}
         ORDER BY o.id`,
        params
      );

      if (allIdsResult.rows.length === 0) {
        res.json({ outlets: [], total: 0, byOutreachStatus: {} });
        return;
      }

      const allOutletIds = allIdsResult.rows.map((r: any) => r.id as string);
      const total = allOutletIds.length;

      // Step 2: Paginate in JS (only if limit is provided)
      const pageOutletIds = q.limit != null
        ? allOutletIds.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit)
        : allOutletIds;

      // Step 3: Fetch all campaign_outlet rows for the page outlet IDs (with filters)
      const dataParams: unknown[] = [pageOutletIds, ctx.orgId];
      let dataIdx = 3;
      const dataConditions: string[] = ["o.id = ANY($1)", "co.org_id = $2"];

      if (q.campaignId) {
        dataConditions.push(`co.campaign_id = $${dataIdx++}`);
        dataParams.push(q.campaignId);
      }
      if (q.brandId) {
        dataConditions.push(`$${dataIdx++} = ANY(co.brand_ids)`);
        dataParams.push(q.brandId);
      }
      if (q.status) {
        dataConditions.push(`co.status = $${dataIdx++}`);
        dataParams.push(q.status);
      }
      if (q.runId) {
        dataConditions.push(`co.run_id = $${dataIdx++}`);
        dataParams.push(q.runId);
      }
      if (q.featureSlugs) {
        const slugs = q.featureSlugs.split(",").map((s: string) => s.trim()).filter(Boolean);
        const placeholders = slugs.map((_: string, i: number) => `$${dataIdx + i}`).join(", ");
        dataConditions.push(`co.feature_slug IN (${placeholders})`);
        dataParams.push(...slugs);
        dataIdx += slugs.length;
      }

      const dataWhere = `WHERE ${dataConditions.join(" AND ")}`;

      const result = await pool.query(
        `SELECT o.id, o.outlet_name, o.outlet_url, o.outlet_domain,
                co.campaign_id, co.feature_slug, co.brand_ids, co.why_relevant, co.why_not_relevant,
                co.relevance_score, co.status AS outlet_status,
                co.status_reason, co.status_detail,
                co.overall_relevance, co.relevance_rationale, co.run_id,
                o.created_at, co.updated_at AS campaign_updated_at,
                p.sell_price_cents, p.currency, p.article_type, p.allows_dofollow_backlink,
                p.online_duration_months, p.is_permanent, p.conditions_note,
                p.updated_at AS pricing_updated_at,
                req.requested_at AS price_requested_at
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         LEFT JOIN outlet_pricing p ON p.outlet_id = o.id
         LEFT JOIN outlet_price_requests req ON req.outlet_id = o.id
         ${dataWhere}
         ORDER BY co.updated_at DESC`,
        dataParams
      );

      // Group rows by outlet_id
      const outletsMap = new Map<string, {
        id: string;
        outletName: string;
        outletUrl: string;
        outletDomain: string;
        createdAt: string;
        // Pricing (silver) + price-request lifecycle — 1:1 on outlet, captured once.
        pricingPresent: boolean;
        sellPriceCents: number | null;
        currency: string | null;
        articleType: "organic" | "sponsored" | null;
        allowsDofollowBacklink: boolean | null;
        onlineDurationMonths: number | null;
        isPermanent: boolean | null;
        conditionsNote: string | null;
        pricingUpdatedAt: string | null;
        priceRequestedAt: string | null;
        campaigns: Array<{
          campaignId: string;
          featureSlug: string;
          brandIds: string[];
          whyRelevant: string;
          whyNotRelevant: string;
          relevanceScore: number;
          dbStatus: string;
          statusReason: string | null;
          statusDetail: string | null;
          overallRelevance: string | null;
          relevanceRationale: string | null;
          runId: string | null;
          updatedAt: string;
        }>;
      }>();

      for (const r of result.rows) {
        let outlet = outletsMap.get(r.id);
        if (!outlet) {
          outlet = {
            id: r.id,
            outletName: r.outlet_name,
            outletUrl: r.outlet_url,
            outletDomain: r.outlet_domain,
            createdAt: r.created_at,
            pricingPresent: r.pricing_updated_at != null,
            sellPriceCents: r.sell_price_cents ?? null,
            currency: r.currency ?? null,
            articleType: r.article_type ?? null,
            allowsDofollowBacklink: r.allows_dofollow_backlink ?? null,
            onlineDurationMonths: r.online_duration_months ?? null,
            isPermanent: r.is_permanent ?? null,
            conditionsNote: r.conditions_note ?? null,
            pricingUpdatedAt: r.pricing_updated_at ?? null,
            priceRequestedAt: r.price_requested_at ?? null,
            campaigns: [],
          };
          outletsMap.set(r.id, outlet);
        }
        outlet.campaigns.push({
          campaignId: r.campaign_id,
          featureSlug: r.feature_slug,
          brandIds: r.brand_ids,
          whyRelevant: r.why_relevant,
          whyNotRelevant: r.why_not_relevant,
          relevanceScore: Number(r.relevance_score),
          dbStatus: r.outlet_status,
          statusReason: r.status_reason,
          statusDetail: r.status_detail,
          overallRelevance: r.overall_relevance,
          relevanceRationale: r.relevance_rationale,
          runId: r.run_id || null,
          updatedAt: r.campaign_updated_at,
        });
      }

      // Enrich ALL outlets (not just the page) via journalists-service
      const scopeFilters: ScopeFilters = {};
      if (q.campaignId) scopeFilters.campaignId = q.campaignId;
      if (q.brandId) scopeFilters.brandId = q.brandId;

      const enrichment = await fetchOutletStatuses(allOutletIds, ctx, scopeFilters);

      // Count outlet statuses from DB for hybrid byOutreachStatus
      const outletCounts = await countOutletStatuses(pool.query.bind(pool), conditions, params);
      const hybridByOutreachStatus = mergeStatusCounts(outletCounts, enrichment.byOutreachStatus);

      // Build final response (page only)
      const outlets = Array.from(outletsMap.values()).map((outlet) => {
        const journalistStatus = enrichment.results.get(outlet.id) ?? null;

        // Pick the first campaign's DB status (most recently updated, since rows are ordered by updated_at DESC)
        const firstCampaign = outlet.campaigns[0];

        const campaignsOut = outlet.campaigns.map((c) => ({
          campaignId: c.campaignId,
          featureSlug: c.featureSlug,
          brandIds: c.brandIds,
          whyRelevant: c.whyRelevant,
          whyNotRelevant: c.whyNotRelevant,
          relevanceScore: c.relevanceScore,
          statusReason: c.statusReason,
          statusDetail: c.statusDetail,
          overallRelevance: c.overallRelevance,
          relevanceRationale: c.relevanceRationale,
          runId: c.runId,
          updatedAt: c.updatedAt,
        }));

        // Outlet-level relevanceScore = max across campaigns
        const outletRelevanceScore = Math.max(...outlet.campaigns.map((c) => c.relevanceScore));

        // Merge journalist-service status with outlets-service DB fields
        const status = journalistStatus
          ? {
              ...journalistStatus,
              outletStatus: firstCampaign.dbStatus,
              statusReason: firstCampaign.statusReason,
              statusDetail: firstCampaign.statusDetail,
            }
          : {
              outletStatus: firstCampaign.dbStatus,
              statusReason: firstCampaign.statusReason,
              statusDetail: firstCampaign.statusDetail,
            };

        // Public sell pricing (retail + multiplier never exposed). null until a
        // silver row exists. The org already owns the outlet here (data query
        // joins campaign_outlets on org_id), so no extra tenant gate is needed.
        const pricing = outlet.pricingPresent
          ? {
              outletId: outlet.id,
              sellPriceCents: outlet.sellPriceCents,
              currency: outlet.currency,
              articleType: outlet.articleType,
              allowsDofollowBacklink: outlet.allowsDofollowBacklink,
              onlineDurationMonths: outlet.onlineDurationMonths,
              isPermanent: outlet.isPermanent,
              conditionsNote: outlet.conditionsNote,
            }
          : null;

        return {
          id: outlet.id,
          outletName: outlet.outletName,
          outletUrl: outlet.outletUrl,
          outletDomain: outlet.outletDomain,
          createdAt: outlet.createdAt,
          relevanceScore: outletRelevanceScore,
          status,
          pricing,
          priceRequestStatus: derivePriceRequestStatus(outlet.priceRequestedAt, outlet.pricingUpdatedAt),
          campaigns: campaignsOut,
        };
      });

      // Enrich page outlets with Domain Rating from ahref-service (live read).
      // null = ahref has not scraped that domain yet or the decorative DR read
      // is unavailable. Core journalist-status enrichment above remains fail-loud.
      const pageDomains = [...new Set(outlets.map((o) => normalizeDomain(o.outletDomain)))];
      const drMap = await getDrStatusBestEffort(pageDomains, ctx);
      const outletsWithDr = outlets.map((o) => ({
        ...o,
        domainRating: drMap.get(normalizeDomain(o.outletDomain)) ?? null,
      }));

      res.json({ outlets: outletsWithDr, total, byOutreachStatus: hybridByOutreachStatus });
    } catch (err) {
      console.error("[outlets-service] Error listing outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /org/outlets/:id
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = req.orgContext!;
    const result = await pool.query(
      `SELECT o.id, o.outlet_name, o.outlet_url, o.outlet_domain, o.created_at, o.updated_at
       FROM outlets o
       JOIN campaign_outlets co ON o.id = co.outlet_id
       WHERE o.id = $1 AND co.org_id = $2
       LIMIT 1`,
      [req.params.id, ctx.orgId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Outlet not found" });
      return;
    }

    const r = result.rows[0];
    const drMap = await getDrStatusBestEffort([normalizeDomain(r.outlet_domain)], ctx);
    res.json({
      id: r.id,
      outletName: r.outlet_name,
      outletUrl: r.outlet_url,
      outletDomain: r.outlet_domain,
      domainRating: drMap.get(normalizeDomain(r.outlet_domain)) ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error("[outlets-service] Error getting outlet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /org/outlets/:id/pricing — SELL price only (retail + multiplier never
// leave the service). Gated on the org owning the outlet (tenant isolation).
router.get("/:id/pricing", async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = req.orgContext!;
    const pricing = await getPublicPricingForOrg(req.params.id as string, ctx.orgId);
    if (!pricing) {
      res.status(404).json({ error: "Pricing not found" });
      return;
    }
    res.json(pricing);
  } catch (err) {
    console.error("[outlets-service] Error getting outlet pricing:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /org/outlets/:id
router.patch(
  "/:id",
  validateBody(updateOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ctx = req.orgContext!;

      // Verify the outlet belongs to this org
      const check = await pool.query(
        `SELECT 1 FROM campaign_outlets WHERE outlet_id = $1 AND org_id = $2 LIMIT 1`,
        [req.params.id, ctx.orgId]
      );
      if (check.rows.length === 0) {
        res.status(404).json({ error: "Outlet not found" });
        return;
      }

      const b = req.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (b.outletName !== undefined) { sets.push(`outlet_name = $${idx++}`); params.push(b.outletName); }
      if (b.outletUrl !== undefined) { sets.push(`outlet_url = $${idx++}`); params.push(b.outletUrl); }
      if (b.outletDomain !== undefined) { sets.push(`outlet_domain = $${idx++}`); params.push(b.outletDomain); }

      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE outlets SET ${sets.join(", ")} WHERE id = $${idx}
         RETURNING id, outlet_name, outlet_url, outlet_domain, created_at, updated_at`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Outlet not found" });
        return;
      }

      const r = result.rows[0];
      res.json({
        id: r.id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch (err) {
      console.error("[outlets-service] Error updating outlet:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /org/outlets/:id/status
router.patch(
  "/:id/status",
  validateBody(updateOutletStatusSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    try {
      const { status, statusReason, statusDetail } = req.body;

      const result = await pool.query(
        `UPDATE campaign_outlets
         SET status = $1, status_reason = $2, status_detail = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE outlet_id = $4 AND campaign_id = $5 AND org_id = $6
         RETURNING campaign_id, outlet_id, status, status_reason, status_detail, updated_at`,
        [status, statusReason || null, statusDetail || null, req.params.id, ctx.campaignId, ctx.orgId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Campaign outlet not found" });
        return;
      }

      const r = result.rows[0];
      res.json({
        outletId: r.outlet_id,
        campaignId: r.campaign_id,
        status: r.status,
        statusReason: r.status_reason,
        statusDetail: r.status_detail,
        updatedAt: r.updated_at,
      });
    } catch (err) {
      console.error("[outlets-service] Error updating outlet status:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /org/outlets/bulk — upsert many outlets
router.post(
  "/bulk",
  validateBody(bulkCreateOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    try {
      const { outlets } = req.body;
      const client = await pool.connect();
      const results: any[] = [];

      try {
        await client.query("BEGIN");

        for (const b of outlets) {
          const domain = b.outletDomain || extractDomain(b.outletUrl);

          const outletResult = await client.query(
            `INSERT INTO outlets (outlet_name, outlet_url, outlet_domain)
             VALUES ($1, $2, $3)
             ON CONFLICT (outlet_domain)
             DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_url = EXCLUDED.outlet_url, updated_at = CURRENT_TIMESTAMP
             RETURNING id, outlet_name, outlet_url, outlet_domain`,
            [b.outletName, b.outletUrl, domain]
          );
          const outlet = outletResult.rows[0];

          await client.query(
            `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, status_reason, status_detail, overall_relevance, relevance_rationale, run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (campaign_id, outlet_id)
             DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
               relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
               status_reason = EXCLUDED.status_reason, status_detail = EXCLUDED.status_detail,
               overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
               feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
               brand_ids = EXCLUDED.brand_ids, workflow_slug = EXCLUDED.workflow_slug,
               run_id = EXCLUDED.run_id,
               updated_at = CURRENT_TIMESTAMP`,
            [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandIds, ctx.featureSlug, ctx.workflowSlug, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.statusReason || "discovered", b.statusDetail || null, b.overallRelevance || null, b.relevanceRationale || null, ctx.runId]
          );

          results.push({
            id: outlet.id,
            outletName: outlet.outlet_name,
            outletUrl: outlet.outlet_url,
            campaignId: ctx.campaignId,
          });
        }

        await client.query("COMMIT");
        res.status(201).json({ outlets: results, count: results.length });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[outlets-service] Error bulk creating outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /org/outlets/search — search by name/url, scoped by org
router.post(
  "/search",
  validateBody(searchOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ctx = req.orgContext!;
      const { query, campaignId, limit } = req.body;
      const pattern = `%${query}%`;
      const params: unknown[] = [pattern, pattern, ctx.orgId];
      let paramIdx = 4;

      let campaignFilter = "";
      if (campaignId) {
        campaignFilter = `AND co.campaign_id = $${paramIdx++}`;
        params.push(campaignId);
      }

      let limitClause = "";
      if (limit != null) {
        limitClause = `LIMIT $${paramIdx++}`;
        params.push(limit);
      }

      const result = await pool.query(
        `SELECT DISTINCT o.id, o.outlet_name, o.outlet_url, o.outlet_domain, o.created_at, o.updated_at
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         WHERE (o.outlet_name ILIKE $1 OR o.outlet_url ILIKE $2) AND co.org_id = $3 ${campaignFilter}
         ORDER BY o.outlet_name
         ${limitClause}`,
        params
      );

      res.json({
        outlets: result.rows.map((r: any) => ({
          id: r.id,
          outletName: r.outlet_name,
          outletUrl: r.outlet_url,
          outletDomain: r.outlet_domain,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        total: result.rowCount,
      });
    } catch (err) {
      console.error("[outlets-service] Error searching outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
