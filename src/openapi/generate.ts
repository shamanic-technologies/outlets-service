import fs from "fs";
import path from "path";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
  bufferNextSchema,
  bufferNextResponseSchema,
  healthResponseSchema,
  errorResponseSchema,
  outletResponseSchema,
  campaignOutletResponseSchema,
  statsResponseSchema,
  statsGroupedResponseSchema,
  discoverSchema,
  discoverResponseSchema,
  statsCostsResponseSchema,
} from "../schemas";
import { zodToJsonSchema } from "./zod-to-json";

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

/** Base headers — only the 3 required headers. For read/stats/internal endpoints. */
const baseOrgContextHeaders = [
  { in: "header", name: "x-org-id", required: true, schema: { type: "string", format: "uuid" }, description: "Organization ID (from client-service)" },
  { in: "header", name: "x-user-id", required: true, schema: { type: "string", format: "uuid" }, description: "User ID (from client-service)" },
  { in: "header", name: "x-run-id", required: true, schema: { type: "string", format: "uuid" }, description: "Run ID (caller's run from runs-service)" },
  { in: "header", name: "x-feature-slug", required: false, schema: { type: "string" }, description: "Feature slug for tracking (optional, propagated downstream)" },
  { in: "header", name: "x-campaign-id", required: false, schema: { type: "string", format: "uuid" }, description: "Campaign ID (optional for read endpoints)" },
  { in: "header", name: "x-brand-id", required: false, schema: { type: "string" }, description: "Brand ID(s) — optional for read endpoints" },
  { in: "header", name: "x-workflow-slug", required: false, schema: { type: "string" }, description: "Workflow slug for tracking (optional, propagated downstream)" },
];

/** Full headers — all 7 required. For write/workflow endpoints. */
const fullOrgContextHeaders = [
  { in: "header", name: "x-org-id", required: true, schema: { type: "string", format: "uuid" }, description: "Organization ID (from client-service)" },
  { in: "header", name: "x-user-id", required: true, schema: { type: "string", format: "uuid" }, description: "User ID (from client-service)" },
  { in: "header", name: "x-run-id", required: true, schema: { type: "string", format: "uuid" }, description: "Run ID (caller's run from runs-service)" },
  { in: "header", name: "x-feature-slug", required: true, schema: { type: "string" }, description: "Feature slug for tracking (propagated downstream)" },
  { in: "header", name: "x-campaign-id", required: true, schema: { type: "string", format: "uuid" }, description: "Campaign ID" },
  { in: "header", name: "x-brand-id", required: true, schema: { type: "string" }, description: "Brand ID(s) — single UUID or comma-separated UUIDs for multi-brand campaigns. Example: uuid1,uuid2,uuid3" },
  { in: "header", name: "x-workflow-slug", required: true, schema: { type: "string" }, description: "Workflow slug for tracking (propagated downstream)" },
];

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Outlets Service",
    description: "Manages press outlets (publications) and their campaign relevance data. Scoped by org × brand × feature × campaign × workflow. Brand fields (brandName, industry, etc.) are fetched from brand-service — callers provide brandId via x-brand-id header and optionally pass featureInput as opaque context for LLM calls.",
    version: "3.0.0",
  },
  servers: [{ url: "http://localhost:3000" }],
  security: [{ apiKey: [] }],
  components: {
    schemas: {
      CreateOutlet: zodToJsonSchema(createOutletSchema),
      UpdateOutlet: zodToJsonSchema(updateOutletSchema),
      UpdateOutletStatus: zodToJsonSchema(updateOutletStatusSchema),
      BulkCreateOutlets: zodToJsonSchema(bulkCreateOutletsSchema),
      SearchOutlets: zodToJsonSchema(searchOutletsSchema),
      BufferNext: zodToJsonSchema(bufferNextSchema),
      BufferNextResponse: zodToJsonSchema(bufferNextResponseSchema),
      OutletResponse: zodToJsonSchema(outletResponseSchema),
      CampaignOutletResponse: zodToJsonSchema(campaignOutletResponseSchema),
      StatsResponse: zodToJsonSchema(statsResponseSchema),
      StatsGroupedResponse: zodToJsonSchema(statsGroupedResponseSchema),
      Discover: zodToJsonSchema(discoverSchema),
      DiscoverResponse: zodToJsonSchema(discoverResponseSchema),
      StatsCostsResponse: zodToJsonSchema(statsCostsResponseSchema),
      HealthResponse: zodToJsonSchema(healthResponseSchema),
      ErrorResponse: zodToJsonSchema(errorResponseSchema),
    },
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "API key for authenticating requests. Must match OUTLETS_SERVICE_API_KEY env var.",
      },
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": { description: "Service is healthy", content: { "application/json": { schema: ref("HealthResponse") } } },
        },
      },
    },
    "/outlets": {
      post: {
        summary: "Create outlet (upsert by outlet_url)",
        description: "Requires all 7 identity headers. Upserts by outlet_domain — if the domain already exists, updates the name/url.",
        parameters: [...fullOrgContextHeaders],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("CreateOutlet"),
              example: {
                outletName: "TechCrunch",
                outletUrl: "https://techcrunch.com",
                outletDomain: "techcrunch.com",
                whyRelevant: "Top tech publication with high domain authority",
                whyNotRelevant: "Highly competitive, may not accept guest posts",
                relevanceScore: 85,
                status: "open",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Outlet created",
            content: {
              "application/json": {
                schema: ref("CampaignOutletResponse"),
                example: {
                  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  outletName: "TechCrunch",
                  outletUrl: "https://techcrunch.com",
                  outletDomain: "techcrunch.com",
                  campaignId: "11111111-2222-3333-4444-555555555555",
                  brandIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
                  whyRelevant: "Top tech publication with high domain authority",
                  whyNotRelevant: "Highly competitive, may not accept guest posts",
                  relevanceScore: 85,
                  status: "open",
                  overallRelevance: null,
                  relevanceRationale: null,
                  createdAt: "2026-01-15T10:30:00.000Z",
                  updatedAt: "2026-01-15T10:30:00.000Z",
                },
              },
            },
          },
          "400": { description: "Validation error or missing headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
      get: {
        summary: "List outlets with filters",
        description: "Returns outlets joined with their campaign data. Filter by campaignId, brandId, and/or status.",
        parameters: [
          ...baseOrgContextHeaders,
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "ended", "denied", "served", "skipped"] }, description: "Filter by outlet status" },
          { in: "query", name: "runId", schema: { type: "string" }, description: "Filter by run ID (from discover endpoint)" },
          { in: "query", name: "limit", schema: { type: "integer", default: 100 }, description: "Max results (default 100, max 1000)" },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 }, description: "Pagination offset" },
        ],
        responses: {
          "200": {
            description: "List of outlets",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: { type: "array", items: ref("CampaignOutletResponse") },
                    total: { type: "integer" },
                  },
                  required: ["outlets", "total"],
                },
                example: {
                  outlets: [
                    {
                      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                      outletName: "TechCrunch",
                      outletUrl: "https://techcrunch.com",
                      outletDomain: "techcrunch.com",
                      campaignId: "11111111-2222-3333-4444-555555555555",
                      brandIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
                      whyRelevant: "Top tech publication",
                      whyNotRelevant: "Competitive",
                      relevanceScore: 85,
                      status: "open",
                      overallRelevance: "high",
                      relevanceRationale: null,
                      createdAt: "2026-01-15T10:30:00.000Z",
                      updatedAt: "2026-01-15T10:30:00.000Z",
                    },
                  ],
                  total: 1,
                },
              },
            },
          },
        },
      },
    },
    "/outlets/{id}": {
      get: {
        summary: "Get outlet by ID",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...baseOrgContextHeaders],
        responses: {
          "200": { description: "Outlet found", content: { "application/json": { schema: ref("OutletResponse") } } },
          "404": { description: "Outlet not found" },
        },
      },
      patch: {
        summary: "Update outlet",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...baseOrgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("UpdateOutlet") } } },
        responses: {
          "200": { description: "Outlet updated", content: { "application/json": { schema: ref("OutletResponse") } } },
          "404": { description: "Outlet not found" },
        },
      },
    },
    "/outlets/{id}/status": {
      patch: {
        summary: "Update outlet status",
        description: "Updates the status of an outlet within a campaign. Requires all 7 identity headers. Setting status to 'ended' also sets ended_at timestamp.",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" }, description: "Outlet ID" },
          ...fullOrgContextHeaders,
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("UpdateOutletStatus"),
              example: { status: "ended", reason: "No longer relevant to campaign goals" },
            },
          },
        },
        responses: {
          "200": {
            description: "Status updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outletId: { type: "string", format: "uuid" },
                    campaignId: { type: "string", format: "uuid" },
                    status: { type: "string", enum: ["open", "ended", "denied", "served", "skipped"] },
                    reason: { type: "string", nullable: true },
                    updatedAt: { type: "string", format: "date-time" },
                  },
                  required: ["outletId", "campaignId", "status", "updatedAt"],
                },
                example: {
                  outletId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  campaignId: "11111111-2222-3333-4444-555555555555",
                  status: "ended",
                  reason: "No longer relevant to campaign goals",
                  updatedAt: "2026-01-16T14:00:00.000Z",
                },
              },
            },
          },
          "400": { description: "Missing x-campaign-id header", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "404": { description: "Campaign outlet not found", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/outlets/bulk": {
      post: {
        summary: "Bulk upsert outlets",
        description: "Requires all 7 identity headers. All outlets in the batch share the same campaign and brand. Max 500 outlets per request.",
        parameters: [...fullOrgContextHeaders],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("BulkCreateOutlets"),
              example: {
                outlets: [
                  {
                    outletName: "TechCrunch",
                    outletUrl: "https://techcrunch.com",
                    outletDomain: "techcrunch.com",
                    whyRelevant: "Top tech publication",
                    whyNotRelevant: "Competitive",
                    relevanceScore: 85,
                  },
                  {
                    outletName: "The Verge",
                    outletUrl: "https://theverge.com",
                    outletDomain: "theverge.com",
                    whyRelevant: "Wide consumer tech audience",
                    whyNotRelevant: "May not cover B2B topics",
                    relevanceScore: 78,
                  },
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Outlets created",
            content: {
              "application/json": {
                example: {
                  outlets: [
                    { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", outletName: "TechCrunch", outletUrl: "https://techcrunch.com", campaignId: "11111111-2222-3333-4444-555555555555" },
                    { id: "b2c3d4e5-f6a7-8901-bcde-f12345678901", outletName: "The Verge", outletUrl: "https://theverge.com", campaignId: "11111111-2222-3333-4444-555555555555" },
                  ],
                  count: 2,
                },
              },
            },
          },
          "400": { description: "Validation error or missing headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/outlets/search": {
      post: {
        summary: "Search outlets by name/url",
        description: "Full-text search (ILIKE) on outlet name and URL. Optionally scoped to a campaign.",
        parameters: [...baseOrgContextHeaders],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("SearchOutlets"),
              example: { query: "tech", campaignId: "11111111-2222-3333-4444-555555555555", limit: 10 },
            },
          },
        },
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: { type: "array", items: ref("OutletResponse") },
                    total: { type: "integer" },
                  },
                  required: ["outlets", "total"],
                },
              },
            },
          },
        },
      },
    },
    "/outlets/stats": {
      get: {
        summary: "Aggregated outlet discovery metrics",
        description: "Returns outlet discovery stats (count, avg relevance, search queries used). Supports filtering by brandId, campaignId, workflowSlug, featureSlug, and dynasty slugs. Dynasty slug filters resolve to all versioned slugs via workflow-service / features-service.",
        parameters: [
          ...baseOrgContextHeaders,
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "workflowSlug", schema: { type: "string" }, description: "Filter by exact workflow slug" },
          { in: "query", name: "workflowSlugs", schema: { type: "string" }, description: "Filter by multiple workflow slugs (comma-separated). Takes priority over workflowSlug." },
          { in: "query", name: "featureSlug", schema: { type: "string" }, description: "Filter by exact feature slug" },
          { in: "query", name: "featureSlugs", schema: { type: "string" }, description: "Filter by multiple feature slugs (comma-separated). Takes priority over featureSlug." },
          { in: "query", name: "workflowDynastySlug", schema: { type: "string" }, description: "Filter by workflow dynasty slug (resolved to all versioned slugs). Takes priority over workflowSlug." },
          { in: "query", name: "featureDynastySlug", schema: { type: "string" }, description: "Filter by feature dynasty slug (resolved to all versioned slugs). Takes priority over featureSlug." },
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["workflowSlug", "featureSlug", "brandId", "campaignId", "workflowDynastySlug", "featureDynastySlug"] }, description: "Group results by this dimension. Dynasty groupBy aggregates versioned slugs into their dynasty." },
        ],
        responses: {
          "200": {
            description: "Stats (flat or grouped)",
            content: {
              "application/json": {
                schema: {
                  oneOf: [ref("StatsResponse"), ref("StatsGroupedResponse")],
                },
              },
            },
          },
        },
      },
    },
    "/outlets/stats/costs": {
      get: {
        summary: "Cost stats for outlet discovery",
        description: "Returns aggregated discovery costs by querying runs-service for all runs associated with outlets. Supports filters (brandId, campaignId) and optional groupBy (outletId, runId). Without groupBy returns flat totals; with groupBy=outletId returns cost-per-outlet (run cost / outlets in that run); with groupBy=runId returns one row per discovery run.",
        parameters: [
          ...baseOrgContextHeaders,
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["outletId", "runId"] }, description: "Group results by dimension. Omit for flat totals." },
        ],
        responses: {
          "200": {
            description: "Cost stats (flat or grouped)",
            content: {
              "application/json": {
                schema: ref("StatsCostsResponse"),
                example: {
                  groups: [{
                    dimensions: { outletId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
                    totalCostInUsdCents: 1234,
                    actualCostInUsdCents: 800,
                    provisionedCostInUsdCents: 434,
                    runCount: 3,
                  }],
                },
              },
            },
          },
          "502": { description: "Upstream service error (runs-service)", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/outlets/discover": {
      post: {
        summary: "Discover outlets for a campaign",
        description: "Runs parameterized outlet discovery: generates search queries via LLM, searches Google, scores results, and inserts into the campaign buffer. Creates a child run in runs-service for cost tracking. Requires all 7 identity headers.",
        parameters: [...fullOrgContextHeaders],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("Discover"),
              example: { count: 50 },
            },
          },
        },
        responses: {
          "200": {
            description: "Discovery completed",
            content: {
              "application/json": {
                schema: ref("DiscoverResponse"),
                example: { runId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", discovered: 42 },
              },
            },
          },
          "400": { description: "Missing required headers or invalid count", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error during discovery", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/buffer/next": {
      post: {
        summary: "Pull the next best outlet(s) from the buffer",
        description: "Returns up to `count` (default 1, max 50) highest-scored open outlets for the campaign. If the buffer is empty, triggers a lightweight mini-discover (3 queries × 5 Google results, LLM scoring) to refill it. Supports idempotency via optional idempotencyKey. Requires all 7 identity headers.",
        parameters: [...fullOrgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("BufferNext") } } },
        responses: {
          "200": { description: "Array of outlets (may be empty if none available)", content: { "application/json": { schema: ref("BufferNextResponse") } } },
          "400": { description: "Missing required headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error during mini-discover", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets": {
      get: {
        summary: "Lookup outlets by IDs and/or campaignId",
        description: "Unified internal endpoint. At least one of `ids` or `campaignId` must be provided. When `campaignId` is provided, returns campaign-enriched outlet data (relevance, status, etc.). When only `ids` is provided, returns base outlet data.",
        parameters: [
          ...baseOrgContextHeaders,
          { in: "query", name: "ids", required: false, schema: { type: "string" }, description: "Comma-separated outlet IDs" },
          { in: "query", name: "campaignId", required: false, schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID — includes campaign-specific fields in response" },
        ],
        responses: {
          "200": {
            description: "Outlets found. Shape depends on whether campaignId was provided.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: { type: "array", items: { oneOf: [ref("OutletResponse"), ref("CampaignOutletResponse")] } },
                  },
                  required: ["outlets"],
                },
              },
            },
          },
          "400": { description: "Neither ids nor campaignId provided", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "Get OpenAPI specification",
        responses: {
          "200": { description: "OpenAPI JSON document" },
          "404": { description: "Spec not generated" },
        },
      },
    },
  },
};

const outPath = path.join(__dirname, "..", "..", "openapi.json");
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outPath}`);
