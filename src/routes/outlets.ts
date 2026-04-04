import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { validateBody, validateQuery } from "../middleware/validate";
import { requireFullOrgContext } from "../middleware/org-context";
import type { FullOrgContext } from "../middleware/org-context";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  listOutletsQuerySchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
} from "../schemas";
import { resolveFeatureDynastySlugs } from "../services/dynasty";
import { fetchOutletStatuses } from "../services/outlet-status";

const router = Router();

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// POST /outlets — create outlet (upsert by outlet_url)
router.post(
  "/",
  requireFullOrgContext,
  validateBody(createOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext! as FullOrgContext;

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
      console.error("Error creating outlet:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /outlets — list with filters, deduplicated by outlet with nested campaigns
router.get(
  "/",
  validateQuery(listOutletsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const ctx = req.orgContext!;
      const q = req.query as any;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

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
          res.json({ outlets: [], total: 0 });
          return;
        }
        const placeholders = slugs.map((_, i) => `$${paramIdx + i}`).join(", ");
        conditions.push(`co.feature_slug IN (${placeholders})`);
        params.push(...slugs);
        paramIdx += slugs.length;
      } else if (q.featureSlugs) {
        const slugs = q.featureSlugs.split(",").map((s: string) => s.trim()).filter(Boolean);
        if (slugs.length === 0) {
          res.json({ outlets: [], total: 0 });
          return;
        }
        const placeholders = slugs.map((_: string, i: number) => `$${paramIdx + i}`).join(", ");
        conditions.push(`co.feature_slug IN (${placeholders})`);
        params.push(...slugs);
        paramIdx += slugs.length;
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      // Step 1: Get paginated distinct outlet IDs + total count
      const idsResult = await pool.query(
        `SELECT DISTINCT o.id
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         ${where}
         ORDER BY o.id
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, q.limit, q.offset]
      );

      if (idsResult.rows.length === 0) {
        res.json({ outlets: [], total: 0 });
        return;
      }

      const outletIds = idsResult.rows.map((r: any) => r.id as string);

      // Step 2: Count total distinct outlets matching filters
      const countResult = await pool.query(
        `SELECT COUNT(DISTINCT o.id)::int AS total
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         ${where}`,
        params
      );
      const total = countResult.rows[0]?.total ?? 0;

      // Step 3: Fetch all campaign_outlet rows for the paginated outlet IDs (with filters)
      // Re-apply filters so we only get matching campaign_outlet rows
      const dataParams: unknown[] = [outletIds];
      let dataIdx = 2;
      const dataConditions: string[] = ["o.id = ANY($1)"];

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
      // Re-apply feature slug filters for the data query
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
          status: string;
          overallRelevance: string | null;
          relevanceRationale: string | null;
          replyClassification: string | null;
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
          status: r.outlet_status,
          overallRelevance: r.overall_relevance,
          relevanceRationale: r.relevance_rationale,
          replyClassification: null,
          runId: r.run_id || null,
          updatedAt: r.campaign_updated_at,
        });
      }

      // Enrich statuses from journalists-service for "served" outlets
      const servedOutletIds = Array.from(outletsMap.entries())
        .filter(([_, o]) => o.campaigns.some((c) => c.status === "served"))
        .map(([id]) => id);

      const enrichedStatuses = servedOutletIds.length > 0
        ? await fetchOutletStatuses(servedOutletIds, ctx)
        : new Map();

      // Override campaign-level statuses with enriched status
      for (const outlet of outletsMap.values()) {
        const enriched = enrichedStatuses.get(outlet.id);
        if (!enriched) continue;
        for (const campaign of outlet.campaigns) {
          if (campaign.status === "served" && enriched.status !== "served") {
            campaign.status = enriched.status;
            campaign.replyClassification = enriched.replyClassification;
          }
        }
      }

      // Status priority: most advanced journalist/delivery status wins
      const STATUS_PRIORITY: Record<string, number> = {
        skipped: 0, denied: 0, ended: 0, open: 1, served: 2, contacted: 3, delivered: 4, replied: 5,
      };

      // Build final response — campaigns sorted by updated_at DESC from SQL
      const outlets = Array.from(outletsMap.values()).map((outlet) => {
        const latest = outlet.campaigns[0];
        const mostAdvancedStatus = outlet.campaigns.reduce(
          (best, c) => (STATUS_PRIORITY[c.status] ?? 0) > (STATUS_PRIORITY[best] ?? 0) ? c.status : best,
          outlet.campaigns[0].status,
        );
        return {
          id: outlet.id,
          outletName: outlet.outletName,
          outletUrl: outlet.outletUrl,
          outletDomain: outlet.outletDomain,
          createdAt: outlet.createdAt,
          latestStatus: mostAdvancedStatus,
          latestRelevanceScore: latest.relevanceScore,
          campaigns: outlet.campaigns,
        };
      });

      res.json({ outlets, total });
    } catch (err) {
      console.error("[outlets-service] Error listing outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /outlets/:id
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id, outlet_name, outlet_url, outlet_domain, created_at, updated_at
       FROM outlets WHERE id = $1`,
      [req.params.id]
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
    console.error("Error getting outlet:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /outlets/:id
router.patch(
  "/:id",
  validateBody(updateOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
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
      console.error("Error updating outlet:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /outlets/:id/status
router.patch(
  "/:id/status",
  requireFullOrgContext,
  validateBody(updateOutletStatusSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext! as FullOrgContext;

    try {
      const { status, reason } = req.body;

      const result = await pool.query(
        `UPDATE campaign_outlets
         SET status = $1, relevance_rationale = COALESCE($2, relevance_rationale),
             ended_at = ${status === "ended" ? "CURRENT_TIMESTAMP" : "ended_at"},
             updated_at = CURRENT_TIMESTAMP
         WHERE outlet_id = $3 AND campaign_id = $4
         RETURNING campaign_id, outlet_id, status, relevance_rationale, updated_at`,
        [status, reason || null, req.params.id, ctx.campaignId]
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
      console.error("Error updating outlet status:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /outlets/bulk — upsert many outlets
router.post(
  "/bulk",
  requireFullOrgContext,
  validateBody(bulkCreateOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext! as FullOrgContext;

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
      console.error("Error bulk creating outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /outlets/search — search by name/url
router.post(
  "/search",
  validateBody(searchOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { query, campaignId, limit } = req.body;
      const pattern = `%${query}%`;
      const params: unknown[] = [pattern, pattern];
      let paramIdx = 3;

      let campaignFilter = "";
      if (campaignId) {
        campaignFilter = `AND co.campaign_id = $${paramIdx++}`;
        params.push(campaignId);
      }
      params.push(limit);

      const result = await pool.query(
        `SELECT DISTINCT o.id, o.outlet_name, o.outlet_url, o.outlet_domain, o.created_at, o.updated_at
         FROM outlets o
         LEFT JOIN campaign_outlets co ON o.id = co.outlet_id
         WHERE (o.outlet_name ILIKE $1 OR o.outlet_url ILIKE $2) ${campaignFilter}
         ORDER BY o.outlet_name
         LIMIT $${paramIdx - (campaignId ? 0 : 1)}`,
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
      console.error("Error searching outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
