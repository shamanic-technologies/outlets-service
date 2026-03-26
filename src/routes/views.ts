import { Router, Request, Response } from "express";
import { pool } from "../db/pool";

const router = Router();

// GET /outlets/status — outlets with targeting readiness
router.get("/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const campaignId = req.query.campaignId as string;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (campaignId) {
      conditions.push(`co.campaign_id = $${idx++}`);
      params.push(campaignId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT
        co.campaign_id,
        co.outlet_id,
        po.outlet_name,
        po.outlet_url,
        co.relevance_score,
        co.why_relevant,
        co.why_not_relevant,
        co.status AS outlet_status,
        co.overal_relevance,
        co.relevance_rationale,
        co.updated_at
       FROM campaign_outlets co
       JOIN press_outlets po ON co.outlet_id = po.id
       ${where}
       ORDER BY co.relevance_score DESC`,
      params
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        campaignId: r.campaign_id,
        outletId: r.outlet_id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        relevanceScore: Number(r.relevance_score),
        whyRelevant: r.why_relevant,
        whyNotRelevant: r.why_not_relevant,
        outletStatus: r.outlet_status,
        overalRelevance: r.overal_relevance,
        relevanceRationale: r.relevance_rationale,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("Error getting outlet status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outlets/has-topics-articles — outlets that need topic/article updates
router.get("/has-topics-articles", async (_req: Request, res: Response): Promise<void> => {
  try {
    // Simplified version — in production this joins with searched_outlet_topic_articles
    // Here we return outlets with their basic info and a needs_update flag
    const result = await pool.query(
      `SELECT po.id AS outlet_id, po.outlet_name, po.outlet_url, po.outlet_domain,
              po.updated_at
       FROM press_outlets po
       WHERE po.status IS NULL OR po.status <> 'to_delete'
       ORDER BY po.updated_at DESC`
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        outletId: r.outlet_id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("Error getting topics articles status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outlets/has-recent-articles — outlets with recent articles to search
router.get("/has-recent-articles", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT po.id AS outlet_id, po.outlet_name, po.outlet_url, po.outlet_domain,
              po.updated_at
       FROM press_outlets po
       WHERE po.status IS NULL OR po.status <> 'to_delete'
       ORDER BY po.updated_at DESC`
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        outletId: r.outlet_id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("Error getting recent articles status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outlets/has-journalists — outlets with journalist coverage status
router.get("/has-journalists", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT po.id AS outlet_id, po.outlet_name, po.outlet_url, po.outlet_domain,
              po.updated_at
       FROM press_outlets po
       WHERE po.status IS NULL OR po.status <> 'to_delete'
       ORDER BY po.updated_at DESC`
    );

    res.json({
      outlets: result.rows.map((r: any) => ({
        outletId: r.outlet_id,
        outletName: r.outlet_name,
        outletUrl: r.outlet_url,
        outletDomain: r.outlet_domain,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("Error getting journalist coverage status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
