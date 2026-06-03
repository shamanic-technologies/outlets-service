import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import { validateBody } from "../middleware/validate";
import { internalOutletsBodySchema, transferBrandBodySchema, createPriceSourceSchema } from "../schemas";
import { fetchOutletStatuses } from "../services/outlet-status";
import { buildServiceHeaders } from "../services/headers";
import {
  outletExists,
  hasPriceSources,
  insertPriceSource,
  extractAndUpsertPricing,
  getInternalPricing,
} from "../services/pricing";

const router = Router();

// POST /internal/outlets — lookup by IDs and/or campaignId
router.post(
  "/outlets",
  validateBody(internalOutletsBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { ids = [], campaignId } = req.body as { ids?: string[]; campaignId?: string };

      // When campaignId is provided, join campaign_outlets for enriched data
      if (campaignId) {
        const conditions: string[] = ["co.campaign_id = $1"];
        const params: unknown[] = [campaignId];
        let idx = 2;

        if (ids.length > 0) {
          const placeholders = ids.map((_: string, i: number) => `$${idx + i}`).join(", ");
          conditions.push(`o.id IN (${placeholders})`);
          params.push(...ids);
          idx += ids.length;
        }

        const where = conditions.join(" AND ");
        const result = await pool.query(
          `SELECT
            o.id, o.outlet_name, o.outlet_url, o.outlet_domain,
            co.org_id, co.brand_ids, co.why_relevant, co.why_not_relevant, co.relevance_score, co.status AS outlet_status,
            co.overall_relevance, co.relevance_rationale,
            o.created_at, o.updated_at
           FROM campaign_outlets co
           JOIN outlets o ON co.outlet_id = o.id
           WHERE ${where}
           ORDER BY co.relevance_score DESC`,
          params
        );

        // Enrich with outreach status from journalists-service
        const outletIds = result.rows.map((r: any) => r.id as string);
        // Internal endpoints don't have orgContext, so build a minimal one from the first row
        const firstRow = result.rows[0];
        const enrichment = outletIds.length > 0 && firstRow
          ? await fetchOutletStatuses(
              outletIds,
              { orgId: firstRow.org_id, brandIds: firstRow.brand_ids ?? [] },
              { campaignId }
            )
          : null;

        res.json({
          outlets: result.rows.map((r: any) => {
            const outletStatus = enrichment?.results.get(r.id) ?? null;
            return {
              id: r.id,
              outletName: r.outlet_name,
              outletUrl: r.outlet_url,
              outletDomain: r.outlet_domain,
              campaignId,
              brandIds: r.brand_ids,
              whyRelevant: r.why_relevant,
              whyNotRelevant: r.why_not_relevant,
              relevanceScore: Number(r.relevance_score),
              status: outletStatus,
              overallRelevance: r.overall_relevance,
              relevanceRationale: r.relevance_rationale,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            };
          }),
        });
        return;
      }

      // ids-only path (no campaignId)
      if (ids.length === 0) {
        res.json({ outlets: [] });
        return;
      }

      const placeholders = ids.map((_: string, i: number) => `$${i + 1}`).join(", ");
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

// POST /internal/transfer-brand — re-assign solo-brand rows from one org to another
router.post(
  "/transfer-brand",
  validateBody(transferBrandBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = req.body as {
        sourceBrandId: string;
        sourceOrgId: string;
        targetOrgId: string;
        targetBrandId?: string;
      };

      // Step 1: Move solo-brand rows from sourceOrg to targetOrg
      const moveResult = await pool.query(
        `UPDATE campaign_outlets
         SET org_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE org_id = $2
           AND array_length(brand_ids, 1) = 1
           AND brand_ids[1] = $3`,
        [targetOrgId, sourceOrgId, sourceBrandId]
      );

      // Step 2: When targetBrandId is present, rewrite ALL brand references (no org filter)
      let rewriteCount = 0;
      if (targetBrandId) {
        const rewriteResult = await pool.query(
          `UPDATE campaign_outlets
           SET brand_ids = array_replace(brand_ids, $1::uuid, $2::uuid), updated_at = CURRENT_TIMESTAMP
           WHERE $1::uuid = ANY(brand_ids)`,
          [sourceBrandId, targetBrandId]
        );
        rewriteCount = rewriteResult.rowCount ?? 0;
      }

      res.json({
        updatedTables: [
          { tableName: "campaign_outlets", count: moveResult.rowCount ?? 0 },
          ...(targetBrandId ? [{ tableName: "campaign_outlets_brand_rewrite", count: rewriteCount }] : []),
        ],
      });
    } catch (err) {
      console.error("[outlets-service] Error transferring brand:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /internal/outlets/:id/price-sources — append a raw bronze note, then
// re-derive silver pricing from ALL of the outlet's notes. Returns the new
// bronze id + the refreshed (internal) pricing.
router.post(
  "/outlets/:id/price-sources",
  validateBody(createPriceSourceSchema),
  async (req: Request, res: Response): Promise<void> => {
    const outletId = req.params.id as string;

    let priceSourceId: string;
    try {
      if (!(await outletExists(outletId))) {
        res.status(404).json({ error: "Outlet not found" });
        return;
      }
      priceSourceId = await insertPriceSource(outletId, req.body);
    } catch (err) {
      console.error("[outlets-service] Error inserting price source:", err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    // Extraction depends on the LLM (chat-service). The bronze note is already
    // persisted, so a failure here is recoverable via the reextract endpoint —
    // fail loud with 502 rather than swallowing.
    try {
      const pricing = await extractAndUpsertPricing(outletId);
      res.status(201).json({ priceSourceId, pricing });
    } catch (err) {
      console.error("[outlets-service] Error extracting pricing:", err);
      res.status(502).json({ error: "Pricing extraction failed" });
    }
  }
);

// POST /internal/outlets/:id/pricing/reextract — re-run silver extraction over
// the existing bronze notes without adding a new one.
router.post(
  "/outlets/:id/pricing/reextract",
  async (req: Request, res: Response): Promise<void> => {
    const outletId = req.params.id as string;
    try {
      if (!(await hasPriceSources(outletId))) {
        res.status(404).json({ error: "No price sources for outlet" });
        return;
      }
      const pricing = await extractAndUpsertPricing(outletId);
      res.json({ pricing });
    } catch (err) {
      console.error("[outlets-service] Error re-extracting pricing:", err);
      res.status(502).json({ error: "Pricing extraction failed" });
    }
  }
);

// GET /internal/outlets/:id/pricing — full silver pricing incl. retail cost.
router.get(
  "/outlets/:id/pricing",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const pricing = await getInternalPricing(req.params.id as string);
      if (!pricing) {
        res.status(404).json({ error: "Pricing not found" });
        return;
      }
      res.json(pricing);
    } catch (err) {
      console.error("[outlets-service] Error getting internal pricing:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
