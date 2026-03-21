import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { pool } from "../db/pool";
import { chatComplete } from "../services/chat";
import { searchBatch } from "../services/google";
import {
  GENERATE_QUERIES_SYSTEM_PROMPT,
  SCORE_OUTLETS_SYSTEM_PROMPT,
  buildQueryGenerationMessage,
  buildScoringMessage,
} from "../prompts";

const discoverSchema = z.object({
  campaignId: z.string().uuid(),
  brandName: z.string().min(1),
  brandDescription: z.string().min(1),
  industry: z.string().min(1),
  targetGeo: z.string().optional(),
  targetAudience: z.string().optional(),
  angles: z.array(z.string()).optional(),
});

export type DiscoverRequest = z.infer<typeof discoverSchema>;

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

const router = Router();

// POST /outlets/discover — find relevant outlets via Google search + LLM scoring
router.post(
  "/discover",
  validateBody(discoverSchema),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = req.orgContext!;
    const body = req.body as DiscoverRequest;

    try {
      // Step 1: Generate search queries via LLM
      const queryGenResponse = await chatComplete(
        {
          message: buildQueryGenerationMessage(body),
          systemPrompt: GENERATE_QUERIES_SYSTEM_PROMPT,
          responseFormat: "json",
          temperature: 0.7,
          maxTokens: 2000,
        },
        ctx
      );

      const parsedQueries = querySchema.safeParse(queryGenResponse.json);
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
            {
              brandName: body.brandName,
              brandDescription: body.brandDescription,
              industry: body.industry,
              targetGeo: body.targetGeo,
              targetAudience: body.targetAudience,
            },
            searchResponse.results.map((r) => ({
              query: r.query,
              results: r.results.map((sr) => ({
                title: sr.title,
                url: sr.url,
                snippet: sr.snippet,
                domain: sr.domain,
              })),
            }))
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

        for (const o of outlets) {
          const domain = extractDomain(o.url);
          // Normalize URL — ensure it has a protocol
          const url = o.url.startsWith("http") ? o.url : `https://${o.url}`;

          const outletResult = await client.query(
            `INSERT INTO press_outlets (outlet_name, outlet_url, outlet_domain)
             VALUES ($1, $2, $3)
             ON CONFLICT (outlet_url)
             DO UPDATE SET outlet_name = EXCLUDED.outlet_name, outlet_domain = EXCLUDED.outlet_domain, updated_at = CURRENT_TIMESTAMP
             RETURNING id, outlet_name, outlet_url, outlet_domain`,
            [o.name, url, domain]
          );
          const outlet = outletResult.rows[0];

          await client.query(
            `INSERT INTO campaign_outlets (campaign_id, outlet_id, why_relevant, why_not_relevant, relevance_score, status, overal_relevance)
             VALUES ($1, $2, $3, $4, $5, 'open', $6)
             ON CONFLICT (campaign_id, outlet_id)
             DO UPDATE SET why_relevant = EXCLUDED.why_relevant, why_not_relevant = EXCLUDED.why_not_relevant,
               relevance_score = EXCLUDED.relevance_score, overal_relevance = EXCLUDED.overal_relevance,
               updated_at = CURRENT_TIMESTAMP`,
            [body.campaignId, outlet.id, o.whyRelevant, o.whyNotRelevant, o.relevanceScore, o.overallRelevance]
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
export { discoverSchema };
