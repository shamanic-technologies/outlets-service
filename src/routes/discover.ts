import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { pool } from "../db/pool";
import { chatComplete } from "../services/chat";
import { searchBatch } from "../services/google";
import { getBrand, extractFields, findField } from "../services/brand";
import { getFeatureInputs } from "../services/campaign";
import {
  GENERATE_QUERIES_SYSTEM_PROMPT,
  SCORE_OUTLETS_SYSTEM_PROMPT,
  buildQueryGenerationMessage,
  buildScoringMessage,
  type BrandPromptContext,
} from "../prompts";
import { discoverOutletsSchema } from "../schemas";

export type DiscoverRequest = z.infer<typeof discoverOutletsSchema>;

const querySchema = z.object({
  queries: z.array(
    z.object({
      query: z.string(),
      type: z.enum(["web", "news"]),
      rationale: z.string(),
    })
  ),
});

const scoringSchema = z.object({
  outlets: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      domain: z.string(),
      relevanceScore: z.number().min(0).max(100),
      whyRelevant: z.string(),
      whyNotRelevant: z.string(),
      overallRelevance: z.string(),
    })
  ),
});

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Fields we need from brand-service for outlet discovery */
const BRAND_FIELDS = [
  { key: "elevator_pitch", description: "A concise elevator pitch describing what the brand does" },
  { key: "categories", description: "The brand's primary industry vertical or categories" },
  { key: "target_geo", description: "Priority geographic markets for outreach" },
  { key: "target_audience", description: "Target audience for the brand's products or services" },
  { key: "angles", description: "PR angles and editorial hooks the brand can leverage" },
];

const router = Router();

// POST /outlets/discover — find relevant outlets via Google search + LLM scoring
router.post(
  "/discover",
  validateBody(discoverOutletsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;

    if (!ctx.campaignId || !ctx.brandId) {
      res.status(400).json({ error: "x-campaign-id and x-brand-id headers are required" });
      return;
    }

    try {
      // Step 0: Fetch brand data and campaign context in parallel
      const [brand, extractedFields, featureInputs] = await Promise.all([
        getBrand(ctx.brandId, ctx),
        extractFields(ctx.brandId, BRAND_FIELDS, ctx),
        getFeatureInputs(ctx.campaignId, ctx),
      ]);

      const brandContext: BrandPromptContext = {
        brandName: brand.name || brand.domain || "Unknown",
        brandDescription: findField(extractedFields, "elevator_pitch") || brand.elevatorPitch || brand.bio || "No description available",
        industry: findField(extractedFields, "categories") || brand.categories || "General",
        targetGeo: findField(extractedFields, "target_geo") || brand.location || undefined,
        targetAudience: findField(extractedFields, "target_audience") || undefined,
        angles: (() => {
          const raw = findField(extractedFields, "angles");
          return raw ? raw.split(", ") : undefined;
        })(),
      };

      const featureInput = featureInputs ?? undefined;

      // Step 1: Generate search queries via LLM
      const queryGenResponse = await chatComplete(
        {
          message: buildQueryGenerationMessage(brandContext, featureInput),
          systemPrompt: GENERATE_QUERIES_SYSTEM_PROMPT,
          responseFormat: "json",
          temperature: 0.7,
          maxTokens: 2000,
        },
        ctx
      );

      // Filter out empty/incomplete query objects (LLM sometimes emits empty {} entries)
      const queryJson = queryGenResponse.json;
      if (queryJson && Array.isArray(queryJson.queries)) {
        queryJson.queries = (queryJson.queries as Array<Record<string, unknown>>)
          .filter((q) => q.query && q.type && q.rationale);
      }
      const parsedQueries = querySchema.safeParse(queryJson);
      if (!parsedQueries.success) {
        console.error("LLM returned invalid query format:", queryGenResponse.content);
        res.status(502).json({ error: "Failed to generate search queries — unexpected LLM output" });
        return;
      }

      // Step 2: Execute searches via google-service batch endpoint
      const searchResponse = await searchBatch(
        {
          queries: parsedQueries.data.queries.map((q) => ({
            query: q.query,
            type: q.type,
            num: 20,
          })),
        },
        ctx
      );

      // Step 3: Score results via LLM
      const scoringResponse = await chatComplete(
        {
          message: buildScoringMessage(
            brandContext,
            searchResponse.results.map((r) => ({
              query: r.query,
              results: r.results.map((sr) => ({
                title: sr.title,
                url: sr.url,
                snippet: sr.snippet,
                domain: sr.domain,
              })),
            })),
            featureInput
          ),
          systemPrompt: SCORE_OUTLETS_SYSTEM_PROMPT,
          responseFormat: "json",
          temperature: 0.3,
          maxTokens: 8000,
        },
        ctx
      );

      const parsedOutlets = scoringSchema.safeParse(scoringResponse.json);
      if (!parsedOutlets.success) {
        console.error("LLM returned invalid scoring format:", scoringResponse.content);
        res.status(502).json({ error: "Failed to score outlets — unexpected LLM output" });
        return;
      }

      // Step 4: Bulk upsert into DB
      const outlets = parsedOutlets.data.outlets;
      if (outlets.length === 0) {
        res.json({ discoveredCount: 0, outlets: [] });
        return;
      }

      const featureSlug = ctx.featureSlug || null;
      const searchQueryCount = parsedQueries.data.queries.length;
      const client = await pool.connect();
      const saved: Array<{
        id: string;
        outletName: string;
        outletUrl: string;
        outletDomain: string;
        relevanceScore: number;
        whyRelevant: string;
        whyNotRelevant: string;
        overallRelevance: string;
      }> = [];

      try {
        await client.query("BEGIN");

        for (let i = 0; i < outlets.length; i++) {
          const o = outlets[i];
          const domain = extractDomain(o.url);
          const url = o.url.startsWith("http") ? o.url : `https://${o.url}`;

          const outletResult = await client.query(
            `INSERT INTO outlets (outlet_name, outlet_url, outlet_domain)
             VALUES ($1, $2, $3)
             ON CONFLICT (outlet_url)
             DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_domain = EXCLUDED.outlet_domain, updated_at = CURRENT_TIMESTAMP
             RETURNING id, outlet_name, outlet_url, outlet_domain`,
            [o.name, url, domain]
          );
          const outlet = outletResult.rows[0];

          await client.query(
            `INSERT INTO campaign_outlets (campaign_id, outlet_id, org_id, brand_id, feature_slug, workflow_name, why_relevant, why_not_relevant, relevance_score, status, overall_relevance, search_queries_used)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11)
             ON CONFLICT (campaign_id, outlet_id)
             DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
               relevance_score = EXCLUDED.relevance_score, overall_relevance = EXCLUDED.overall_relevance,
               feature_slug = EXCLUDED.feature_slug, org_id = EXCLUDED.org_id,
               brand_id = EXCLUDED.brand_id, workflow_name = EXCLUDED.workflow_name,
               search_queries_used = EXCLUDED.search_queries_used,
               updated_at = CURRENT_TIMESTAMP`,
            [ctx.campaignId, outlet.id, ctx.orgId, ctx.brandId, featureSlug, ctx.workflowName || null, o.whyRelevant, o.whyNotRelevant, o.relevanceScore, o.overallRelevance, i === 0 ? searchQueryCount : 0]
          );

          saved.push({
            id: outlet.id,
            outletName: outlet.outlet_name,
            outletUrl: outlet.outlet_url,
            outletDomain: outlet.outlet_domain,
            relevanceScore: o.relevanceScore,
            whyRelevant: o.whyRelevant,
            whyNotRelevant: o.whyNotRelevant,
            overallRelevance: o.overallRelevance,
          });
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      res.status(201).json({
        discoveredCount: saved.length,
        outlets: saved,
        searchQueries: parsedQueries.data.queries.length,
        tokensUsed: {
          queryGeneration: queryGenResponse.tokensInput + queryGenResponse.tokensOutput,
          scoring: scoringResponse.tokensInput + scoringResponse.tokensOutput,
        },
      });
    } catch (err) {
      console.error("Error in outlet discovery:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      const status = message.includes("failed (") ? 502 : 500;
      res.status(status).json({ error: message });
    }
  }
);

export default router;
