import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { validateBody } from "../middleware/validate";
import {
  internalOutletsBodySchema,
  transferBrandBodySchema,
  createPriceSourceSchema,
  ensureOutletSchema,
  createPricingSourceSchema,
  linkSourceOutletsSchema,
  editorialEmailSourcesBodySchema,
} from "../schemas";
import { seedEditorialEmailSources } from "../services/editorial-email-sources";
import { fetchOutletStatuses } from "../services/outlet-status";
import { buildServiceHeaders } from "../services/headers";
import {
  outletExists,
  hasPriceSources,
  insertPriceSource,
  extractAndUpsertPricing,
  getInternalPricing,
  ensureOutlet,
  ensureSource,
  sourceExists,
  linkSourceOutlets,
  insertBrokerPriceSource,
  extractForSource,
  triggerDrComputeIfMissingForOutlet,
} from "../services/pricing";

const router = Router();

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function optionalOrgContext(req: Request): Partial<OrgContext> | null {
  const orgId = headerValue(req, "x-org-id");
  if (!orgId) return null;

  return {
    orgId,
    userId: headerValue(req, "x-user-id"),
    runId: headerValue(req, "x-run-id"),
    featureSlug: headerValue(req, "x-feature-slug"),
    campaignId: headerValue(req, "x-campaign-id"),
    brandIds: String(headerValue(req, "x-brand-id") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    workflowSlug: headerValue(req, "x-workflow-slug"),
  };
}

function logDrTriggerFailure(outletId: string, err: unknown): void {
  console.error(
    `[outlets-service] ahref dr-compute trigger failed for outlet ${outletId}:`,
    err instanceof Error ? err.message : err
  );
}

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
      void triggerDrComputeIfMissingForOutlet(outletId, optionalOrgContext(req)).catch((err) =>
        logDrTriggerFailure(outletId, err)
      );
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
      void triggerDrComputeIfMissingForOutlet(outletId, optionalOrgContext(req)).catch((err) =>
        logDrTriggerFailure(outletId, err)
      );
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

// POST /internal/outlets/ensure — upsert a global outlet (publication) by
// domain. Admin/broker curation path (the only other create is org-scoped).
router.post(
  "/outlets/ensure",
  validateBody(ensureOutletSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { outletName, outletUrl, outletDomain } = req.body;
      const result = await ensureOutlet(outletName, outletUrl, outletDomain);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      console.error("[outlets-service] Error ensuring outlet:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /internal/pricing-sources — create/ensure a broker pricing source.
router.post(
  "/pricing-sources",
  validateBody(createPricingSourceSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, domain } = req.body;
      const source = await ensureSource(name, domain ?? null);
      res.status(201).json(source);
    } catch (err) {
      console.error("[outlets-service] Error creating pricing source:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /internal/pricing-sources/:id/outlets — link outlets (broker inventory).
router.post(
  "/pricing-sources/:id/outlets",
  validateBody(linkSourceOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sourceId = req.params.id as string;
    try {
      if (!(await sourceExists(sourceId))) {
        res.status(404).json({ error: "Pricing source not found" });
        return;
      }
      const linked = await linkSourceOutlets(sourceId, req.body.outletIds);
      res.json({ linked, requested: req.body.outletIds.length });
    } catch (err) {
      console.error("[outlets-service] Error linking source outlets:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /internal/pricing-sources/:id/price-sources — append a broker pricing
// note (stored once), then fan-out re-extract every outlet in its inventory.
router.post(
  "/pricing-sources/:id/price-sources",
  validateBody(createPriceSourceSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sourceId = req.params.id as string;

    let priceSourceId: string;
    try {
      if (!(await sourceExists(sourceId))) {
        res.status(404).json({ error: "Pricing source not found" });
        return;
      }
      priceSourceId = await insertBrokerPriceSource(sourceId, req.body);
    } catch (err) {
      console.error("[outlets-service] Error inserting broker price source:", err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    // Fan-out extraction across the broker's inventory depends on the LLM —
    // the note is already persisted, so fail loud (502) and let reextract retry.
    try {
      const extracted = await extractForSource(sourceId);
      const ctx = optionalOrgContext(req);
      for (const row of extracted) {
        void triggerDrComputeIfMissingForOutlet(row.outletId, ctx).catch((err) =>
          logDrTriggerFailure(row.outletId, err)
        );
      }
      res.status(201).json({ priceSourceId, extracted });
    } catch (err) {
      console.error("[outlets-service] Error fanning out broker extraction:", err);
      res.status(502).json({ error: "Pricing extraction failed" });
    }
  }
);

// POST /internal/editorial-emails/sources — seed the curated editorial-email
// bronze (global, org-agnostic). Each entry upserts the outlet by domain, records
// its verdict (found / not_found), and — for `found` — stores its curated emails
// with provenance. Curated data takes precedence over the scrape cache on read,
// and a `not_found` verdict stops re-scraping + powers the dashboard "not found".
router.post(
  "/editorial-emails/sources",
  validateBody(editorialEmailSourcesBodySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const summary = await seedEditorialEmailSources(req.body.entries);
      res.status(201).json(summary);
    } catch (err) {
      console.error("[outlets-service] Error seeding editorial-email sources:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
