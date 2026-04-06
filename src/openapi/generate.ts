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
  enrichedOutletStatusEnum,
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
    version: "4.0.0",
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
        description: "Returns outlets deduplicated by outlet_id with nested campaign data. Always scoped by x-org-id. Filter by campaignId, brandId, status, featureSlug(s), or featureDynastySlug.",
        parameters: [
          ...orgHeaders,
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "ended", "denied", "served", "skipped"] }, description: "Filter by outlet status" },
          { in: "query", name: "runId", schema: { type: "string" }, description: "Filter by run ID" },
          { in: "query", name: "featureSlugs", schema: { type: "string" }, description: "Filter by feature slugs (comma-separated)" },
          { in: "query", name: "featureDynastySlug", schema: { type: "string" }, description: "Filter by feature dynasty slug (resolved via features-service)" },
          { in: "query", name: "limit", schema: { type: "integer", default: 100 }, description: "Max distinct outlets (default 100, max 1000)" },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 }, description: "Pagination offset" },
        ],
        responses: {
          "200": {
            description: "List of deduplicated outlets with nested campaigns",
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
                          latestStatus: { type: "string", enum: ["open", "ended", "denied", "served", "contacted", "delivered", "replied", "skipped"] },
                          latestRelevanceScore: { type: "number" },
                          campaigns: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                campaignId: { type: "string", format: "uuid" },
                                featureSlug: { type: "string" },
                                brandIds: { type: "array", items: { type: "string", format: "uuid" } },
                                whyRelevant: { type: "string" },
                                whyNotRelevant: { type: "string" },
                                relevanceScore: { type: "number" },
                                status: { type: "string", enum: ["open", "ended", "denied", "served", "contacted", "delivered", "replied", "skipped"] },
                                overallRelevance: { type: "string", nullable: true },
                                relevanceRationale: { type: "string", nullable: true },
                                replyClassification: { type: "string", nullable: true, enum: ["positive", "negative", "neutral"] },
                                runId: { type: "string", nullable: true },
                                updatedAt: { type: "string", format: "date-time" },
                              },
                              required: ["campaignId", "featureSlug", "brandIds", "relevanceScore", "status", "updatedAt"],
                            },
                          },
                        },
                        required: ["id", "outletName", "outletUrl", "outletDomain", "createdAt", "latestStatus", "latestRelevanceScore", "campaigns"],
                      },
                    },
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
        description: "Returns outlet discovery stats. Supports filtering and groupBy.",
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
            description: "Stats (flat or grouped)",
            content: {
              "application/json": {
                schema: { oneOf: [ref("StatsResponse"), ref("StatsGroupedResponse")] },
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
        description: "Internal endpoint — requires only x-api-key, no org context. At least one of `ids` or `campaignId` must be provided.",
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
