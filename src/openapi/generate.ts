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
  outreachStatusEnum,
} from "../schemas";
import { zodToJsonSchema } from "./zod-to-json";

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

/** Org-level headers — only x-org-id is required. All others are optional. */
const orgHeaders = [
  { in: "header", name: "x-org-id", required: true, schema: { type: "string", format: "uuid" }, description: "Organization ID (from client-service)" },
  { in: "header", name: "x-user-id", required: false, schema: { type: "string", format: "uuid" }, description: "User ID (optional)" },
  { in: "header", name: "x-run-id", required: false, schema: { type: "string", format: "uuid" }, description: "Run ID (optional)" },
  { in: "header", name: "x-feature-slug", required: false, schema: { type: "string" }, description: "Feature slug (optional)" },
  { in: "header", name: "x-campaign-id", required: false, schema: { type: "string", format: "uuid" }, description: "Campaign ID (optional)" },
  { in: "header", name: "x-brand-id", required: false, schema: { type: "string" }, description: "Brand ID(s) — comma-separated UUIDs (optional)" },
  { in: "header", name: "x-workflow-slug", required: false, schema: { type: "string" }, description: "Workflow slug (optional)" },
];

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Outlets Service",
    description: "Manages press outlets (publications) and their campaign relevance data. Routes are organized under /org (requires x-api-key + x-org-id) and /internal (requires x-api-key only).",
    version: "5.0.0",
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
        description: "API key for authenticating requests. Required on all routes except /health and /openapi.json.",
      },
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        security: [],
        responses: {
          "200": { description: "Service is healthy", content: { "application/json": { schema: ref("HealthResponse") } } },
        },
      },
    },
    "/orgs/outlets": {
      post: {
        summary: "Create outlet (upsert by outlet_domain)",
        description: "Upserts by outlet_domain — if the domain already exists, updates the name/url. Callers should provide campaign/brand/feature/workflow headers for proper context.",
        parameters: [...orgHeaders],
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
            content: { "application/json": { schema: ref("CampaignOutletResponse") } },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
      get: {
        summary: "List outlets with filters (deduplicated, org-scoped)",
        description: "Returns outlets deduplicated by outlet_id with nested campaign data. Always scoped by x-org-id. At least one of brandId or campaignId is required (org-only scoping returns 400). Outreach status is enriched from journalists-service at the query's granularity.",
        parameters: [
          ...orgHeaders,
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "ended", "denied", "served", "skipped"] }, description: "Filter by internal DB status (not outreach status). Use this to filter outlets by their discovery pipeline state." },
          { in: "query", name: "runId", schema: { type: "string" }, description: "Filter by run ID" },
          { in: "query", name: "featureSlugs", schema: { type: "string" }, description: "Filter by feature slugs (comma-separated)" },
          { in: "query", name: "featureDynastySlug", schema: { type: "string" }, description: "Filter by feature dynasty slug (resolved via features-service)" },
          { in: "query", name: "limit", schema: { type: "integer" }, description: "Max distinct outlets per page. Omit to return all outlets." },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 }, description: "Pagination offset (only used when limit is provided)" },
        ],
        responses: {
          "200": {
            description: "List of deduplicated outlets with nested campaigns. Requires at least brandId or campaignId.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          outletName: { type: "string" },
                          outletUrl: { type: "string" },
                          outletDomain: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
                          relevanceScore: { type: "number", description: "High watermark relevance score across all campaigns for this outlet (max of per-campaign scores)." },
                          outreachStatus: { type: "string", enum: ["open", "ended", "denied", "served", "contacted", "delivered", "replied", "skipped"], description: "High watermark outreach status from journalists-service at the query's scope (campaign or brand). Falls back to most advanced DB status when no journalist data exists." },
                          replyClassification: { type: "string", nullable: true, enum: ["positive", "negative", "neutral"], description: "Best reply classification when outreachStatus is 'replied'. Null otherwise." },
                          campaigns: {
                            type: "array",
                            description: "Campaign-level data for this outlet. When brand-scoped, each campaign has its own outreachStatus from the byCampaign breakdown. When campaign-scoped, there is one entry.",
                            items: {
                              type: "object",
                              properties: {
                                campaignId: { type: "string", format: "uuid" },
                                featureSlug: { type: "string" },
                                brandIds: { type: "array", items: { type: "string", format: "uuid" } },
                                whyRelevant: { type: "string" },
                                whyNotRelevant: { type: "string" },
                                relevanceScore: { type: "number" },
                                outreachStatus: { type: "string", enum: ["open", "ended", "denied", "served", "contacted", "delivered", "replied", "skipped"], description: "Outreach status scoped to this specific campaign." },
                                overallRelevance: { type: "string", nullable: true },
                                relevanceRationale: { type: "string", nullable: true },
                                replyClassification: { type: "string", nullable: true, enum: ["positive", "negative", "neutral"] },
                                runId: { type: "string", nullable: true },
                                updatedAt: { type: "string", format: "date-time" },
                              },
                              required: ["campaignId", "featureSlug", "brandIds", "relevanceScore", "outreachStatus", "updatedAt"],
                            },
                          },
                        },
                        required: ["id", "outletName", "outletUrl", "outletDomain", "createdAt", "relevanceScore", "outreachStatus", "replyClassification", "campaigns"],
                      },
                    },
                    total: { type: "integer", description: "Total distinct outlets matching filters (not truncated by pagination)" },
                    byOutreachStatus: {
                      type: "object",
                      additionalProperties: { type: "integer" },
                      description: "Count of outlets per outreach status across ALL outlets matching filters (not truncated by pagination). Enriched from journalists-service.",
                      example: { open: 50, served: 120, contacted: 30, delivered: 37, replied: 5 },
                    },
                  },
                  required: ["outlets", "total", "byOutreachStatus"],
                },
                example: {
                  outlets: [
                    {
                      id: "11111111-2222-3333-4444-555555555555",
                      outletName: "TechCrunch",
                      outletUrl: "https://techcrunch.com",
                      outletDomain: "techcrunch.com",
                      createdAt: "2026-01-01T00:00:00Z",
                      relevanceScore: 85,
                      outreachStatus: "delivered",
                      replyClassification: null,
                      campaigns: [
                        {
                          campaignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                          featureSlug: "pr-outreach-v3",
                          brandIds: ["ffffffff-1111-2222-3333-444444444444"],
                          whyRelevant: "Top tech publication with high domain authority",
                          whyNotRelevant: "Highly competitive",
                          relevanceScore: 85,
                          outreachStatus: "delivered",
                          overallRelevance: "high",
                          relevanceRationale: null,
                          replyClassification: null,
                          runId: "cccccccc-dddd-eeee-ffff-111111111111",
                          updatedAt: "2026-01-15T12:00:00Z",
                        },
                      ],
                    },
                  ],
                  total: 1,
                  byOutreachStatus: { delivered: 1 },
                },
              },
            },
          },
          "400": {
            description: "Missing required filter — at least one of brandId or campaignId query parameter is required",
            content: { "application/json": { schema: ref("ErrorResponse"), example: { error: "At least one of brandId or campaignId query parameter is required" } } },
          },
        },
      },
    },
    "/orgs/outlets/{id}": {
      get: {
        summary: "Get outlet by ID (org-scoped)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgHeaders],
        responses: {
          "200": { description: "Outlet found", content: { "application/json": { schema: ref("OutletResponse") } } },
          "404": { description: "Outlet not found" },
        },
      },
      patch: {
        summary: "Update outlet (org-scoped)",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgHeaders],
        requestBody: { content: { "application/json": { schema: ref("UpdateOutlet") } } },
        responses: {
          "200": { description: "Outlet updated", content: { "application/json": { schema: ref("OutletResponse") } } },
          "404": { description: "Outlet not found" },
        },
      },
    },
    "/orgs/outlets/{id}/status": {
      patch: {
        summary: "Update outlet status (org-scoped)",
        description: "Updates the status of an outlet within a campaign. Requires x-campaign-id to identify the campaign_outlet row.",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } },
          ...orgHeaders,
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("UpdateOutletStatus"),
              example: { status: "ended", reason: "No longer relevant" },
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
              },
            },
          },
          "404": { description: "Campaign outlet not found" },
        },
      },
    },
    "/orgs/outlets/bulk": {
      post: {
        summary: "Bulk upsert outlets (org-scoped)",
        description: "Callers should provide campaign/brand/feature/workflow headers. Max 500 outlets per request.",
        parameters: [...orgHeaders],
        requestBody: {
          content: {
            "application/json": {
              schema: ref("BulkCreateOutlets"),
            },
          },
        },
        responses: {
          "201": { description: "Outlets created" },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/orgs/outlets/search": {
      post: {
        summary: "Search outlets by name/url (org-scoped)",
        description: "Full-text search (ILIKE) on outlet name and URL, scoped by org.",
        parameters: [...orgHeaders],
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
    "/orgs/outlets/stats": {
      get: {
        summary: "Aggregated outlet discovery metrics (org-scoped)",
        description: "Returns outlet discovery stats: total outlets discovered, average relevance score, search queries used, and a `byOutreachStatus` breakdown. The status breakdown enriches all outlets via journalists-service — each outlet's outreach status is its high watermark from journalists-service, falling back to the most advanced DB status when no journalist data exists. Supports filtering by brand, campaign, workflow, feature, and groupBy for dimensional breakdown.",
        parameters: [
          ...orgHeaders,
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "workflowSlug", schema: { type: "string" }, description: "Filter by exact workflow slug" },
          { in: "query", name: "workflowSlugs", schema: { type: "string" }, description: "Filter by multiple workflow slugs (comma-separated)" },
          { in: "query", name: "featureSlug", schema: { type: "string" }, description: "Filter by exact feature slug" },
          { in: "query", name: "featureSlugs", schema: { type: "string" }, description: "Filter by multiple feature slugs (comma-separated)" },
          { in: "query", name: "workflowDynastySlug", schema: { type: "string" }, description: "Filter by workflow dynasty slug" },
          { in: "query", name: "featureDynastySlug", schema: { type: "string" }, description: "Filter by feature dynasty slug" },
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["workflowSlug", "featureSlug", "brandId", "campaignId", "workflowDynastySlug", "featureDynastySlug"] }, description: "Group results by dimension" },
        ],
        responses: {
          "200": {
            description: "Stats (flat when no groupBy, grouped when groupBy is set). Flat response includes `byOutreachStatus` — a map of outreach status → count, enriched from journalists-service with DB status fallback.",
            content: {
              "application/json": {
                schema: { oneOf: [ref("StatsResponse"), ref("StatsGroupedResponse")] },
                example: {
                  outletsDiscovered: 42,
                  avgRelevanceScore: 72.5,
                  searchQueriesUsed: 8,
                  byOutreachStatus: {
                    open: 10,
                    served: 15,
                    contacted: 8,
                    delivered: 5,
                    replied: 3,
                    denied: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
    "/orgs/outlets/stats/costs": {
      get: {
        summary: "Cost stats for outlet discovery (org-scoped)",
        description: "Returns aggregated discovery costs via runs-service.",
        parameters: [
          ...orgHeaders,
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["outletId", "runId"] }, description: "Group results by dimension" },
        ],
        responses: {
          "200": {
            description: "Cost stats",
            content: { "application/json": { schema: ref("StatsCostsResponse") } },
          },
          "502": { description: "Upstream service error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/orgs/outlets/discover": {
      post: {
        summary: "Discover outlets for a campaign (org-scoped)",
        description: "Runs outlet discovery: generates categories, searches Google, scores results, inserts into buffer.",
        parameters: [...orgHeaders],
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
            content: { "application/json": { schema: ref("DiscoverResponse") } },
          },
          "400": { description: "Invalid request", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/orgs/buffer/next": {
      post: {
        summary: "Pull next outlet(s) from buffer (org-scoped)",
        description: "Returns up to `count` highest-scored open outlets. Auto-discovers if buffer is empty.",
        parameters: [...orgHeaders],
        requestBody: { content: { "application/json": { schema: ref("BufferNext") } } },
        responses: {
          "200": { description: "Outlets", content: { "application/json": { schema: ref("BufferNextResponse") } } },
          "400": { description: "Missing x-org-id", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets": {
      get: {
        summary: "Lookup outlets by IDs and/or campaignId",
        description: "Internal endpoint — requires only x-api-key, no org context. At least one of `ids` or `campaignId` must be provided. When `campaignId` is provided, returns enriched campaign-outlet data including `outreachStatus` and `replyClassification` from journalists-service. Without `campaignId`, returns basic outlet data only.",
        parameters: [
          { in: "query", name: "ids", required: false, schema: { type: "string" }, description: "Comma-separated outlet IDs" },
          { in: "query", name: "campaignId", required: false, schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
        ],
        responses: {
          "200": {
            description: "Outlets found",
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
        security: [],
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
