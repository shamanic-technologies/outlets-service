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
  validateBody(createOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    if (!ctx.campaignId || !ctx.brandId) {
      res.status(400).json({ error: "x-campaign-id and x-brand-id headers are required" });
      return;
    }

    try {
      const b = req.body;
      const domain = b.outletDomain || extractDomain(b.outletUrl);
      const featureSlug = ctx.featureSlug || null;

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
          `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_id, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, relevance_rationale)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (campaign_id, outlet_id)
           DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
             relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
             overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
             feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
             brand_id = EXCLUDED.brand_id, workflow_slug = EXCLUDED.workflow_slug,
             updated_at = CURRENT_TIMESTAMP`,
          [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandId, featureSlug, ctx.workflowSlug || null, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.overallRelevance || null, b.relevanceRationale || null]
        );

        await client.query("COMMIT");

        res.status(201).json({
          id: outlet.id,
          outletName: outlet.outlet_name,
          outletUrl: outlet.outlet_url,
          outletDomain: outlet.outlet_domain,
          campaignId: ctx.campaignId,
          brandId: ctx.brandId,
          whyRelevant: b.whyRelevant,
          whyNotRelevant: b.whyNotRelevant,
          relevanceScore: Number(b.relevanceScore),
          outletStatus: b.status || "open",
          overallRelevance: b.overallRelevance || null,
          relevanceRationale: b.relevanceRationale || null,
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

// GET /outlets — list with filters
router.get(
  "/",
  validateQuery(listOutletsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const q = req.query as any;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${paramIdx++}`);
        params.push(q.campaignId);
      }
      if (q.brandId) {
        conditions.push(`co.brand_id = $${paramIdx++}`);
        params.push(q.brandId);
      }
      if (q.status) {
        conditions.push(`co.status = $${paramIdx++}`);
        params.push(q.status);
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await pool.query(
        `SELECT o.id, o.outlet_name, o.outlet_url, o.outlet_domain,
                co.campaign_id, co.brand_id, co.why_relevant, co.why_not_relevant, co.relevance_score,
                co.status AS outlet_status, co.overall_relevance, co.relevance_rationale,
                o.created_at, o.updated_at
         FROM outlets o
         JOIN campaign_outlets co ON o.id = co.outlet_id
         ${where}
         ORDER BY o.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, q.limit, q.offset]
      );

      res.json({
        outlets: result.rows.map((r: any) => ({
          id: r.id,
          outletName: r.outlet_name,
          outletUrl: r.outlet_url,
          outletDomain: r.outlet_domain,
          campaignId: r.campaign_id,
          brandId: r.brand_id,
          whyRelevant: r.why_relevant,
          whyNotRelevant: r.why_not_relevant,
          relevanceScore: Number(r.relevance_score),
          outletStatus: r.outlet_status,
          overallRelevance: r.overall_relevance,
          relevanceRationale: r.relevance_rationale,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        total: result.rowCount,
      });
    } catch (err) {
      console.error("Error listing outlets:", err);
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
  validateBody(updateOutletStatusSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    if (!ctx.campaignId) {
      res.status(400).json({ error: "x-campaign-id header is required" });
      return;
    }

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
  validateBody(bulkCreateOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    if (!ctx.campaignId || !ctx.brandId) {
      res.status(400).json({ error: "x-campaign-id and x-brand-id headers are required" });
      return;
    }

    try {
      const { outlets } = req.body;
      const featureSlug = ctx.featureSlug || null;
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
            `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_id, feature_slug, workflow_slug, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, relevance_rationale)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (campaign_id, outlet_id)
             DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
               relevance_score = EXCLUDED.relevance_score, status = EXCLUDED.status,
               overall_relevance = EXCLUDED.overall_relevance, relevance_rationale = EXCLUDED.relevance_rationale,
               feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
               brand_id = EXCLUDED.brand_id, workflow_slug = EXCLUDED.workflow_slug,
               updated_at = CURRENT_TIMESTAMP`,
            [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandId, featureSlug, ctx.workflowSlug || null, b.whyRelevant, b.whyNotRelevant, b.relevanceScore, b.status || "open", b.overallRelevance || null, b.relevanceRationale || null]
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
