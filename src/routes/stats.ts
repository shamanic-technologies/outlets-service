import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { validateQuery } from "../middleware/validate";
import { statsQuerySchema } from "../schemas";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../services/dynasty";

const router = Router();

/** Columns that support direct groupBy (no dynasty resolution needed). */
const GROUP_BY_COLUMN: Record<string, string> = {
  workflowSlug: "co.workflow_slug",
  featureSlug: "co.feature_slug",
  brandId: "co.brand_id",
  campaignId: "co.campaign_id",
};

const EMPTY_STATS = {
  outletsDiscovered: 0,
  avgRelevanceScore: 0,
  searchQueriesUsed: 0,
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

      // --- Static filters ---
      if (q.brandId) {
        conditions.push(`co.brand_id = $${idx++}`);
        params.push(q.brandId);
      }
      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${idx++}`);
        params.push(q.campaignId);
      }

      // --- Workflow filter: dynasty takes priority over exact slug ---
      if (q.workflowDynastySlug) {
        const slugs = await resolveWorkflowDynastySlugs(
          q.workflowDynastySlug,
          config.workflowServiceApiKey
        );
        if (slugs.length === 0) {
          res.json(q.groupBy ? { groups: [] } : EMPTY_STATS);
          return;
        }
        const placeholders = slugs.map((_, i) => `$${idx + i}`).join(", ");
        conditions.push(`co.workflow_slug IN (${placeholders})`);
        params.push(...slugs);
        idx += slugs.length;
      } else if (q.workflowSlug) {
        conditions.push(`co.workflow_slug = $${idx++}`);
        params.push(q.workflowSlug);
      }

      // --- Feature filter: dynasty takes priority over exact slug ---
      if (q.featureDynastySlug) {
        const slugs = await resolveFeatureDynastySlugs(
          q.featureDynastySlug,
          config.featuresServiceApiKey
        );
        if (slugs.length === 0) {
          res.json(q.groupBy ? { groups: [] } : EMPTY_STATS);
          return;
        }
        const placeholders = slugs.map((_, i) => `$${idx + i}`).join(", ");
        conditions.push(`co.feature_slug IN (${placeholders})`);
        params.push(...slugs);
        idx += slugs.length;
      } else if (q.featureSlug) {
        conditions.push(`co.feature_slug = $${idx++}`);
        params.push(q.featureSlug);
      }

      const where = conditions.join(" AND ");
      const groupBy = q.groupBy as string | undefined;

      // --- Dynasty groupBy (requires post-query aggregation) ---
      if (groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug") {
        const dbCol =
          groupBy === "workflowDynastySlug"
            ? "co.workflow_slug"
            : "co.feature_slug";

        // Query grouped by the raw DB column
        const result = await pool.query(
          `SELECT
            ${dbCol} AS group_key,
            COUNT(DISTINCT co.outlet_id)::int AS outlets_discovered,
            ROUND(AVG(co.relevance_score), 2) AS avg_relevance_score,
            SUM(co.search_queries_used)::int AS search_queries_used
           FROM campaign_outlets co
           WHERE ${where} AND ${dbCol} IS NOT NULL
           GROUP BY ${dbCol}
           ORDER BY outlets_discovered DESC`,
          params
        );

        // Build reverse map: slug → dynastySlug
        const dynastyMap =
          groupBy === "workflowDynastySlug"
            ? await getWorkflowDynastyMap(config.workflowServiceApiKey)
            : await getFeatureDynastyMap(config.featuresServiceApiKey);

        // Re-aggregate rows by dynasty slug
        const aggregated = new Map<
          string,
          { outletsDiscovered: number; relevanceSum: number; relevanceCount: number; searchQueriesUsed: number }
        >();

        for (const row of result.rows) {
          const rawSlug = String(row.group_key);
          const dynastyKey = dynastyMap.get(rawSlug) ?? rawSlug; // fallback to raw slug

          const existing = aggregated.get(dynastyKey);
          if (existing) {
            existing.outletsDiscovered += row.outlets_discovered;
            existing.relevanceSum += Number(row.avg_relevance_score) * row.outlets_discovered;
            existing.relevanceCount += row.outlets_discovered;
            existing.searchQueriesUsed += row.search_queries_used;
          } else {
            aggregated.set(dynastyKey, {
              outletsDiscovered: row.outlets_discovered,
              relevanceSum: Number(row.avg_relevance_score) * row.outlets_discovered,
              relevanceCount: row.outlets_discovered,
              searchQueriesUsed: row.search_queries_used,
            });
          }
        }

        const groups = Array.from(aggregated.entries())
          .map(([key, v]) => ({
            key,
            outletsDiscovered: v.outletsDiscovered,
            avgRelevanceScore: Number((v.relevanceSum / v.relevanceCount).toFixed(2)),
            searchQueriesUsed: v.searchQueriesUsed,
          }))
          .sort((a, b) => b.outletsDiscovered - a.outletsDiscovered);

        res.json({ groups });
        return;
      }

      // --- Standard groupBy (direct column) ---
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
        // --- No groupBy: flat aggregate ---
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
      console.error("[outlets-service] Error getting outlet stats:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
