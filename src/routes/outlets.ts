import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { validateBody, validateQuery } from "../middleware/validate";
import type { OrgContext } from "../middleware/org-context";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  listOutletsQuerySchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
} from "../schemas";
import { resolveFeatureDynastySlugs } from "../services/dynasty";
import { fetchOutletStatuses, type ScopeFilters } from "../services/outlet-status";

const router = Router();

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
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
          `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, relevance_rationale, run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (campaign_id, outlet_id)
           DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
             relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
             overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
             feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
             brand_ids = EXCLUDED.brand_ids, workflow_slug = EXCLUDED.workflow_slug,
             run_id = EXCLUDED.run_id,
             updated_at = CURRENT_TIMESTAMP`,
          [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandIds, ctx.featureSlug, ctx.workflowSlug, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.overallRelevance || null, b.relevanceRationale || null, ctx.runId]
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

      // Feature filter: dynasty > plural slugs
      if (q.featureDynastySlug) {
        const slugs = await resolveFeatureDynastySlugs(
          q.featureDynastySlug,
          config.featuresServiceApiKey,
          ctx
        );
        if (slugs.length === 0) {
          res.json({ outlets: [], total: 0, byOutreachStatus: {} });
          return;
        }
        const placeholders = slugs.map((_, i) => `$${paramIdx + i}`).join(", ");
        conditions.push(`co.feature_slug IN (${placeholders})`);
        params.push(...slugs);
        paramIdx += slugs.length;
      } else if (q.featureSlugs) {
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
      if (q.featureDynastySlug) {
        const slugs = await resolveFeatureDynastySlugs(
          q.featureDynastySlug,
          config.featuresServiceApiKey,
          ctx
        );
        const placeholders = slugs.map((_, i) => `$${dataIdx + i}`).join(", ");
        dataConditions.push(`co.feature_slug IN (${placeholders})`);
        dataParams.push(...slugs);
        dataIdx += slugs.length;
      } else if (q.featureSlugs) {
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
                co.relevance_score, co.status AS outlet_status, co.overall_relevance,
                co.relevance_rationale, co.run_id,
                o.created_at, co.updated_at AS campaign_updated_at
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
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
        campaigns: Array<{
          campaignId: string;
          featureSlug: string;
          brandIds: string[];
          whyRelevant: string;
          whyNotRelevant: string;
          relevanceScore: number;
          dbStatus: string;
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

      const enrichedStatuses = await fetchOutletStatuses(allOutletIds, ctx, scopeFilters);

      // Status priority for fallback computation
      // Priority ordering: replied > delivered > contacted > served > claimed > buffered > open > skipped/denied/ended
      const STATUS_PRIORITY: Record<string, number> = {
        ended: 0, denied: 0, skipped: 0, open: 1, buffered: 2, claimed: 3, served: 4, contacted: 5, delivered: 6, replied: 7,
      };

      // Compute byOutreachStatus across ALL outlets (not truncated by pagination)
      // Need DB status fallback for outlets not in the enrichment map
      const allDbStatusResult = await pool.query(
        `SELECT o.id AS outlet_id, co.status
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         ${where}`,
        params
      );
      const dbStatusMap = new Map<string, string>();
      for (const r of allDbStatusResult.rows) {
        const existing = dbStatusMap.get(r.outlet_id);
        if (!existing || (STATUS_PRIORITY[r.status] ?? 0) > (STATUS_PRIORITY[existing] ?? 0)) {
          dbStatusMap.set(r.outlet_id, r.status);
        }
      }

      const byOutreachStatus: Record<string, number> = {};
      for (const outletId of allOutletIds) {
        const e = enrichedStatuses.get(outletId);
        const status = e?.outreachStatus ?? dbStatusMap.get(outletId) ?? "open";
        byOutreachStatus[status] = (byOutreachStatus[status] ?? 0) + 1;
      }

      // Build final response (page only)
      const outlets = Array.from(outletsMap.values()).map((outlet) => {
        const enriched = enrichedStatuses.get(outlet.id);

        // Per-campaign outreach status (from byCampaign breakdown, or the top-level enriched status for single-campaign queries)
        const campaignsOut = outlet.campaigns.map((c) => {
          let outreachStatus: string;
          let replyClassification: string | null = null;

          if (enriched?.byCampaign?.[c.campaignId]) {
            // Brand-scoped: use per-campaign breakdown from journalists-service
            outreachStatus = enriched.byCampaign[c.campaignId].outreachStatus;
            replyClassification = enriched.byCampaign[c.campaignId].replyClassification;
          } else if (q.campaignId && enriched) {
            // Campaign-scoped: single enriched status applies to the one campaign
            outreachStatus = enriched.outreachStatus;
            replyClassification = enriched.replyClassification;
          } else {
            // Fallback: use DB status
            outreachStatus = c.dbStatus;
          }

          return {
            campaignId: c.campaignId,
            featureSlug: c.featureSlug,
            brandIds: c.brandIds,
            whyRelevant: c.whyRelevant,
            whyNotRelevant: c.whyNotRelevant,
            relevanceScore: c.relevanceScore,
            outreachStatus,
            overallRelevance: c.overallRelevance,
            relevanceRationale: c.relevanceRationale,
            replyClassification,
            runId: c.runId,
            updatedAt: c.updatedAt,
          };
        });

        // Outlet-level outreachStatus = enriched top-level (high watermark for the scope), or fallback to most advanced DB status
        let outletOutreachStatus: string;
        let outletReplyClassification: string | null = null;
        if (enriched) {
          outletOutreachStatus = enriched.outreachStatus;
          outletReplyClassification = enriched.replyClassification;
        } else {
          // Fallback: most advanced DB status across campaigns
          outletOutreachStatus = outlet.campaigns.reduce(
            (best, c) => (STATUS_PRIORITY[c.dbStatus] ?? 0) > (STATUS_PRIORITY[best] ?? 0) ? c.dbStatus : best,
            outlet.campaigns[0].dbStatus,
          );
        }

        // Outlet-level relevanceScore = max across campaigns (high watermark, same logic as outreachStatus)
        const outletRelevanceScore = Math.max(...outlet.campaigns.map((c) => c.relevanceScore));

        return {
          id: outlet.id,
          outletName: outlet.outletName,
          outletUrl: outlet.outletUrl,
          outletDomain: outlet.outletDomain,
          createdAt: outlet.createdAt,
          relevanceScore: outletRelevanceScore,
          outreachStatus: outletOutreachStatus,
          replyClassification: outletReplyClassification,
          campaigns: campaignsOut,
        };
      });

      res.json({ outlets, total, byOutreachStatus });
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
    res.json({
      id: r.id,
      outletName: r.outlet_name,
      outletUrl: r.outlet_url,
      outletDomain: r.outlet_domain,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error("[outlets-service] Error getting outlet:", err);
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
      const { status, reason } = req.body;

      const result = await pool.query(
        `UPDATE campaign_outlets
         SET status = $1, relevance_rationale = COALESCE($2, relevance_rationale),
             ended_at = ${status === "ended" ? "CURRENT_TIMESTAMP" : "ended_at"},
             updated_at = CURRENT_TIMESTAMP
         WHERE outlet_id = $3 AND campaign_id = $4 AND org_id = $5
         RETURNING campaign_id, outlet_id, status, relevance_rationale, updated_at`,
        [status, reason || null, req.params.id, ctx.campaignId, ctx.orgId]
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
        reason: r.relevance_rationale,
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
            `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_ids, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, relevance_rationale, run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (campaign_id, outlet_id)
             DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
               relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
               overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
               feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
               brand_ids = EXCLUDED.brand_ids, workflow_slug = EXCLUDED.workflow_slug,
               run_id = EXCLUDED.run_id,
               updated_at = CURRENT_TIMESTAMP`,
            [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandIds, ctx.featureSlug, ctx.workflowSlug, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.overallRelevance || null, b.relevanceRationale || null, ctx.runId]
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
