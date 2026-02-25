import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { validateBody } from "../middleware/validate";
import { updateDomainRatingSchema } from "../schemas";

const router = Router();

function mapDrRow(r: any) {
  return {
    outletId: r.outlet_id,
    outletName: r.outlet_name,
    outletUrl: r.outlet_url,
    outletDomain: r.outlet_domain,
    drToUpdate: r.dr_to_update,
    drUpdateReason: r.dr_update_reason,
    drLatestSearchDate: r.dr_latest_search_date,
    latestValidDr: r.latest_valid_dr != null ? Number(r.latest_valid_dr) : null,
    latestValidDrDate: r.latest_valid_dr_date,
    hasLowDomainRating: r.has_low_domain_rating,
  };
}

// GET /outlets/dr-status
router.get("/dr-status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT * FROM v_outlets_dr_status ORDER BY dr_latest_search_date DESC NULLS LAST`
    );
    res.json({ outlets: result.rows.map(mapDrRow) });
  } catch (err) {
    console.error("Error getting DR status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outlets/dr-stale — outlets with DR older than 6 months
router.get("/dr-stale", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT * FROM v_outlets_dr_status WHERE dr_to_update = TRUE ORDER BY dr_latest_search_date ASC NULLS FIRST`
    );
    res.json({ outlets: result.rows.map(mapDrRow) });
  } catch (err) {
    console.error("Error getting stale DR outlets:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /outlets/:id/domain-rating — update DR data
router.patch(
  "/:id/domain-rating",
  validateBody(updateDomainRatingSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const outletId = req.params.id;
      const b = req.body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Insert apify_ahref record
        const ahrefResult = await client.query(
          `INSERT INTO apify_ahref (url_input, domain, data_captured_at, data_type, raw_data,
            authority_domain_rating, authority_url_rating, authority_backlinks, authority_refdomains,
            authority_dofollow_backlinks, authority_dofollow_refdomains, traffic_monthly_avg, cost_monthly_avg)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          [
            b.urlInput, b.domain, b.dataCapturedAt, b.dataType, JSON.stringify(b.rawData),
            b.authorityDomainRating ?? null, b.authorityUrlRating ?? null,
            b.authorityBacklinks ?? null, b.authorityRefdomains ?? null,
            b.authorityDofollowBacklinks ?? null, b.authorityDofollowRefdomains ?? null,
            b.trafficMonthlyAvg ?? null, b.costMonthlyAvg ?? null,
          ]
        );

        // Link to outlet
        await client.query(
          `INSERT INTO ahref_outlets (outlet_id, apify_ahref_id) VALUES ($1, $2)`,
          [outletId, ahrefResult.rows[0].id]
        );

        await client.query("COMMIT");

        res.json({
          outletId,
          apifyAhrefId: ahrefResult.rows[0].id,
          authorityDomainRating: b.authorityDomainRating ?? null,
          dataCapturedAt: b.dataCapturedAt,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Error updating domain rating:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /outlets/low-domain-rating
router.get("/low-domain-rating", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT * FROM v_outlets_dr_status WHERE has_low_domain_rating = TRUE ORDER BY outlet_name`
    );
    res.json({ outlets: result.rows.map(mapDrRow) });
  } catch (err) {
    console.error("Error getting low DR outlets:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outlets/campaign-categories-dr-status
router.get("/campaign-categories-dr-status", async (req: Request, res: Response): Promise<void> => {
  try {
    const campaignId = req.query.campaignId as string;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (campaignId) {
      conditions.push(`cco.campaign_id = $${idx++}`);
      params.push(campaignId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT
        pc.id AS category_id,
        pc.category_name,
        pc.campaign_id,
        COUNT(DISTINCT cco.outlet_id) AS total_outlets,
        COUNT(DISTINCT CASE WHEN dr.latest_valid_dr IS NOT NULL THEN cco.outlet_id END) AS outlets_with_dr,
        COUNT(DISTINCT CASE WHEN dr.has_low_domain_rating = TRUE THEN cco.outlet_id END) AS outlets_low_dr,
        COUNT(DISTINCT CASE WHEN dr.dr_to_update = TRUE THEN cco.outlet_id END) AS outlets_stale_dr,
        AVG(dr.latest_valid_dr) AS avg_domain_rating
       FROM campaigns_categories_outlets cco
       JOIN press_categories pc ON cco.category_id = pc.id
       LEFT JOIN v_outlets_dr_status dr ON cco.outlet_id = dr.outlet_id
       ${where}
       GROUP BY pc.id, pc.category_name, pc.campaign_id
       ORDER BY pc.category_name`,
      params
    );

    res.json({
      categories: result.rows.map((r: any) => ({
        categoryId: r.category_id,
        categoryName: r.category_name,
        campaignId: r.campaign_id,
        totalOutlets: Number(r.total_outlets),
        outletsWithDr: Number(r.outlets_with_dr),
        outletsLowDr: Number(r.outlets_low_dr),
        outletsStaleDr: Number(r.outlets_stale_dr),
        avgDomainRating: r.avg_domain_rating ? Number(Number(r.avg_domain_rating).toFixed(1)) : null,
      })),
    });
  } catch (err) {
    console.error("Error getting campaign categories DR status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
