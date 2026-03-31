import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { validateQuery } from "../middleware/validate";
import { statsQuerySchema, statsCostsQuerySchema } from "../schemas";
import { batchRunCosts } from "../services/runs";
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
        conditions.push(`$${idx++} = ANY(co.brand_ids)`);
        params.push(q.brandId);
      }
      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${idx++}`);
        params.push(q.campaignId);
      }

      // --- Workflow filter: dynasty > plural slugs > exact slug ---
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
      } else if (q.workflowSlugs) {
        const slugs = q.workflowSlugs.split(",").map((s) => s.trim()).filter(Boolean);
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

      // --- Feature filter: dynasty > plural slugs > exact slug ---
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
      } else if (q.featureSlugs) {
        const slugs = q.featureSlugs.split(",").map((s) => s.trim()).filter(Boolean);
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

      // --- GroupBy brandId (requires unnest of brand_ids array) ---
      if (groupBy === "brandId") {
        const result = await pool.query(
          `SELECT
            brand_id::text AS group_key,
            COUNT(DISTINCT co.outlet_id)::int AS outlets_discovered,
            ROUND(AVG(co.relevance_score), 2) AS avg_relevance_score,
            SUM(co.search_queries_used)::int AS search_queries_used
           FROM campaign_outlets co, unnest(co.brand_ids) AS brand_id
           WHERE ${where}
           GROUP BY brand_id
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

// GET /outlets/stats/costs — cost stats from runs-service, grouped by outletId or runId
router.get(
  "/stats/costs",
  validateQuery(statsCostsQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const orgId = req.orgContext!.orgId;
      const ctx = req.orgContext!;
      const q = req.query as Record<string, string | undefined>;

      // Build WHERE clause: org-scoped + optional filters
      const conditions: string[] = ["co.org_id = $1", "co.run_id IS NOT NULL"];
      const params: unknown[] = [orgId];
      let idx = 2;

      if (q.brandId) {
        conditions.push(`$${idx++} = ANY(co.brand_ids)`);
        params.push(q.brandId);
      }
      if (q.campaignId) {
        conditions.push(`co.campaign_id = $${idx++}`);
        params.push(q.campaignId);
      }

      const where = conditions.join(" AND ");

      // Get distinct run_ids and count of outlets per run
      const runResult = await pool.query(
        `SELECT co.run_id, COUNT(DISTINCT co.outlet_id)::int AS outlet_count
         FROM campaign_outlets co
         WHERE ${where}
         GROUP BY co.run_id`,
        params
      );

      if (runResult.rows.length === 0) {
        res.json({ groups: [] });
        return;
      }

      const runIds = runResult.rows.map((r: any) => r.run_id as string);
      const outletCountByRun = new Map<string, number>(
        runResult.rows.map((r: any) => [r.run_id as string, r.outlet_count as number])
      );

      // Batch fetch costs from runs-service
      const costs = await batchRunCosts(runIds, ctx);
      const costByRun = new Map(costs.map((c) => [c.runId, c]));

      const groupBy = q.groupBy as string | undefined;

      if (groupBy === "runId") {
        // Group by run: one row per discovery run
        const groups = runIds.map((runId) => {
          const cost = costByRun.get(runId);
          return {
            dimensions: { runId },
            totalCostInUsdCents: cost?.totalCostInUsdCents ?? 0,
            actualCostInUsdCents: cost?.actualCostInUsdCents ?? 0,
            provisionedCostInUsdCents: cost?.provisionedCostInUsdCents ?? 0,
            runCount: 1,
            outletCount: outletCountByRun.get(runId) ?? 0,
          };
        });

        res.json({ groups });
      } else if (groupBy === "outletId") {
        // Group by outlet: cost per outlet = run cost / outlets in that run
        // Need outlet-to-run mapping
        const outletResult = await pool.query(
          `SELECT co.outlet_id, co.run_id
           FROM campaign_outlets co
           WHERE ${where}`,
          params
        );

        // An outlet may have been touched by multiple runs; sum the per-outlet share from each
        const outletCosts = new Map<string, { total: number; actual: number; provisioned: number; runs: Set<string> }>();

        for (const row of outletResult.rows) {
          const outletId = row.outlet_id as string;
          const runId = row.run_id as string;
          const cost = costByRun.get(runId);
          const count = outletCountByRun.get(runId) ?? 1;

          const share = {
            total: (cost?.totalCostInUsdCents ?? 0) / count,
            actual: (cost?.actualCostInUsdCents ?? 0) / count,
            provisioned: (cost?.provisionedCostInUsdCents ?? 0) / count,
          };

          const existing = outletCosts.get(outletId);
          if (existing) {
            existing.total += share.total;
            existing.actual += share.actual;
            existing.provisioned += share.provisioned;
            existing.runs.add(runId);
          } else {
            outletCosts.set(outletId, {
              total: share.total,
              actual: share.actual,
              provisioned: share.provisioned,
              runs: new Set([runId]),
            });
          }
        }

        const groups = Array.from(outletCosts.entries()).map(([outletId, v]) => ({
          dimensions: { outletId },
          totalCostInUsdCents: Math.round(v.total),
          actualCostInUsdCents: Math.round(v.actual),
          provisionedCostInUsdCents: Math.round(v.provisioned),
          runCount: v.runs.size,
        }));

        res.json({ groups });
      } else {
        // No groupBy: flat totals across all runs
        let totalCost = 0;
        let actualCost = 0;
        let provisionedCost = 0;

        for (const cost of costs) {
          totalCost += cost.totalCostInUsdCents;
          actualCost += cost.actualCostInUsdCents;
          provisionedCost += cost.provisionedCostInUsdCents;
        }

        res.json({
          groups: [{
            dimensions: {},
            totalCostInUsdCents: totalCost,
            actualCostInUsdCents: actualCost,
            provisionedCostInUsdCents: provisionedCost,
            runCount: runIds.length,
          }],
        });
      }
    } catch (err) {
      console.error("[outlets-service] Error getting cost stats:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
