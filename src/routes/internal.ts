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
      `SELECT po.id, po.outlet_name, po.outlet_url, po.outlet_domain, po.status, po.created_at, po.updated_at
       FROM press_outlets po
       WHERE po.id IN (${placeholders})`,
      ids
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        id: r.id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("Error getting outlets by IDs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /internal/outlets/by-campaign/:campaignId — all outlets for a campaign with DR data
router.get("/outlets/by-campaign/:campaignId", async (req: Request, res: Response): Promise<void> => {
  try {
    const { campaignId } = req.params;

    const result = await pool.query(
      `SELECT
        po.id, po.outlet_name, po.outlet_url, po.outlet_domain, po.status,
        co.why_relevant, co.why_not_relevant, co.relevance_score, co.status AS outlet_status,
        co.overal_relevance, co.relevance_rationale,
        dr.latest_valid_dr, dr.latest_valid_dr_date, dr.dr_to_update, dr.has_low_domain_rating,
        po.created_at, po.updated_at
       FROM campaign_outlets co
       JOIN press_outlets po ON co.outlet_id = po.id
       LEFT JOIN v_outlets_dr_status dr ON po.id = dr.outlet_id
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
        status: r.status,
        campaignId,
        whyRelevant: r.why_relevant,
        whyNotRelevant: r.why_not_relevant,
        relevanceScore: Number(r.relevance_score),
        outletStatus: r.outlet_status,
        overalRelevance: r.overal_relevance,
        relevanceRationale: r.relevance_rationale,
        latestValidDr: r.latest_valid_dr != null ? Number(r.latest_valid_dr) : null,
        latestValidDrDate: r.latest_valid_dr_date,
        drToUpdate: r.dr_to_update,
        hasLowDomainRating: r.has_low_domain_rating,
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
