import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const router = Router();

// GET /internal/outlets/by-ids — batch lookup by IDs
router.get("/outlets/by-ids", async (req: Request, res: Response): Promise<void> => {
  try {
    const idsParam = req.query.ids as string;
    if (!idsParam) {
      res.status(400).json({ error: "ids query parameter required" });
      return;
    }

    const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean);
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
    console.error("Error getting outlets by IDs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /internal/outlets/by-campaign/:campaignId — all outlets for a campaign
router.get("/outlets/by-campaign/:campaignId", async (req: Request, res: Response): Promise<void> => {
  try {
    const { campaignId } = req.params;

    const result = await pool.query(
      `SELECT
        o.id, o.outlet_name, o.outlet_url, o.outlet_domain,
        co.brand_id, co.why_relevant, co.why_not_relevant, co.relevance_score, co.status AS outlet_status,
        co.overall_relevance, co.relevance_rationale,
        o.created_at, o.updated_at
       FROM campaign_outlets co
       JOIN outlets o ON co.outlet_id = o.id
       WHERE co.campaign_id = $1
       ORDER BY co.relevance_score DESC`,
      [campaignId]
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        id: r.id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        campaignId,
        brandId: r.brand_id,
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
  } catch (err) {
    console.error("Error getting campaign outlets:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
