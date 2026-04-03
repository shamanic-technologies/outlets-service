import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { validateQuery } from "../middleware/validate";
import { internalOutletsQuerySchema } from "../schemas";

const router = Router();

// GET /internal/outlets — unified lookup by IDs and/or campaignId
router.get(
  "/outlets",
  validateQuery(internalOutletsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const ids = q.ids
        ? q.ids.split(",").map((id) => id.trim()).filter(Boolean)
        : [];
      const campaignId = q.campaignId;

      // When campaignId is provided, join campaign_outlets for enriched data
      if (campaignId) {
        const conditions: string[] = ["co.campaign_id = $1"];
        const params: unknown[] = [campaignId];
        let idx = 2;

        if (ids.length > 0) {
          const placeholders = ids.map((_, i) => `$${idx + i}`).join(", ");
          conditions.push(`o.id IN (${placeholders})`);
          params.push(...ids);
          idx += ids.length;
        }

        const where = conditions.join(" AND ");
        const result = await pool.query(
          `SELECT
            o.id, o.outlet_name, o.outlet_url, o.outlet_domain,
            co.brand_ids, co.why_relevant, co.why_not_relevant, co.relevance_score, co.status AS outlet_status,
            co.overall_relevance, co.relevance_rationale,
            o.created_at, o.updated_at
           FROM campaign_outlets co
           JOIN outlets o ON co.outlet_id = o.id
           WHERE ${where}
           ORDER BY co.relevance_score DESC`,
          params
        );

        res.json({
          outlets: result.rows.map((r: any) => ({
            id: r.id,
            outletName: r.outlet_name,
            outletUrl: r.outlet_url,
            outletDomain: r.outlet_domain,
            campaignId,
            brandIds: r.brand_ids,
            whyRelevant: r.why_relevant,
            whyNotRelevant: r.why_not_relevant,
            relevanceScore: Number(r.relevance_score),
            status: r.outlet_status,
            overallRelevance: r.overall_relevance,
            relevanceRationale: r.relevance_rationale,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
        });
        return;
      }

      // ids-only path (no campaignId)
      if (ids.length === 0) {
        res.json({ outlets: [] });
        return;
      }

      const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
      const result = await pool.query(
        `SELECT id, outlet_name, outlet_url, outlet_domain, created_at, updated_at
         FROM outlets
         WHERE id IN (${placeholders})`,
        ids
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
      });
    } catch (err) {
      console.error("[outlets-service] Error getting internal outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
