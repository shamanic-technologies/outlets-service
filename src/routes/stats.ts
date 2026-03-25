import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { validateQuery } from "../middleware/validate";
import { statsQuerySchema } from "../schemas";

const router = Router();

const GROUP_BY_COLUMN: Record<string, string> = {
  workflowName: "co.workflow_name",
  brandId: "co.brand_id",
  campaignId: "co.campaign_id",
};

// GET /outlets/stats — aggregated outlet metrics
router.get(
  "/stats",
  validateQuery(statsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const orgId = req.orgContext!.orgId;
      const q = req.query as Record<string, string | undefined>;

      const conditions: string[] = ["co.org_id = $1"];
      const params: unknown[] = [orgId];
      let idx = 2;

      if (q.brandId) {
        conditions.push(`co.brand_id = $${idx++}`);
        params.push(q.brandId);
      }
      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${idx++}`);
        params.push(q.campaignId);
      }
      if (q.workflowName) {
        conditions.push(`co.workflow_name = $${idx++}`);
        params.push(q.workflowName);
      }

      const where = conditions.join(" AND ");
      const groupBy = q.groupBy as string | undefined;

      if (groupBy && GROUP_BY_COLUMN[groupBy]) {
        const col = GROUP_BY_COLUMN[groupBy];
        const result = await pool.query(
          `SELECT
            ${col} AS group_key,
            COUNT(DISTINCT co.outlet_id)::int AS outlets_discovered,
            ROUND(AVG(co.relevance_score), 2) AS avg_relevance_score,
            SUM(co.search_queries_used)::int AS search_queries_used
           FROM campaign_outlets co
           WHERE ${where} AND ${col} IS NOT NULL
           GROUP BY ${col}
           ORDER BY outlets_discovered DESC`,
          params
        );

        res.json({
          groups: result.rows.map((r: any) => ({
            key: String(r.group_key),
            outletsDiscovered: r.outlets_discovered,
            avgRelevanceScore: Number(r.avg_relevance_score),
            searchQueriesUsed: r.search_queries_used,
          })),
        });
      } else {
        const result = await pool.query(
          `SELECT
            COUNT(DISTINCT co.outlet_id)::int AS outlets_discovered,
            ROUND(AVG(co.relevance_score), 2) AS avg_relevance_score,
            SUM(co.search_queries_used)::int AS search_queries_used
           FROM campaign_outlets co
           WHERE ${where}`,
          params
        );

        const row = result.rows[0];
        res.json({
          outletsDiscovered: row.outlets_discovered ?? 0,
          avgRelevanceScore: Number(row.avg_relevance_score ?? 0),
          searchQueriesUsed: row.search_queries_used ?? 0,
        });
      }
    } catch (err) {
      console.error("Error getting outlet stats:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
