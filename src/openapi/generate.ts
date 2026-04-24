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
  statusCountsSchema,
  transferBrandBodySchema,
  transferBrandResponseSchema,
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

/** Status counts object — reused in outlet status and byOutreachStatus. */
const statusCountsObject = {
  type: "object",
  properties: {
    buffered: { type: "number" },
    claimed: { type: "number" },
    served: { type: "number" },
    skipped: { type: "number" },
    contacted: { type: "number" },
    sent: { type: "number" },
    delivered: { type: "number" },
    opened: { type: "number" },
    clicked: { type: "number" },
    replied: { type: "number" },
    repliesPositive: { type: "number" },
    repliesNegative: { type: "number" },
    repliesNeutral: { type: "number" },
    bounced: { type: "number" },
    unsubscribed: { type: "number" },
  },
  required: ["buffered", "claimed", "served", "skipped", "contacted", "sent", "delivered", "opened", "clicked", "replied", "repliesPositive", "repliesNegative", "repliesNeutral", "bounced", "unsubscribed"],
};

/** Per-outlet status object from journalists-service. */
const outletStatusObject = {
  type: "object",
  nullable: true,
  description: "Structured status from journalists-service. Null when no journalist data exists for this outlet.",
  properties: {
    totalJournalists: { type: "number", description: "Total journalists for this outlet" },
    brand: { ...statusCountsObject, nullable: true, description: "Cumulative counts at brand scope. Null in campaign mode." },
    byCampaign: {
      type: "object",
      nullable: true,
      additionalProperties: statusCountsObject,
      description: "Per-campaign counts. Present in brand mode, null in campaign mode.",
    },
    campaign: { ...statusCountsObject, nullable: true, description: "Cumulative counts at campaign scope. Null in brand mode." },
    global: {
      type: "object",
      properties: {
        bounced: { type: "number" },
        unsubscribed: { type: "number" },
      },
      required: ["bounced", "unsubscribed"],
      description: "Global email signals (bounced/unsubscribed counts).",
    },
  },
  required: ["totalJournalists", "brand", "byCampaign", "campaign", "global"],
};

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Outlets Service",
    description: "Manages press outlets (publications) and their campaign relevance data. Routes are organized under /org (requires x-api-key + x-org-id) and /internal (requires x-api-key only).",
    version: "6.0.0",
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
      StatusCounts: zodToJsonSchema(statusCountsSchema),
      StatsResponse: zodToJsonSchema(statsResponseSchema),
      StatsGroupedResponse: zodToJsonSchema(statsGroupedResponseSchema),
      Discover: zodToJsonSchema(discoverSchema),
      DiscoverResponse: zodToJsonSchema(discoverResponseSchema),
      StatsCostsResponse: zodToJsonSchema(statsCostsResponseSchema),
      TransferBrandBody: zodToJsonSchema(transferBrandBodySchema),
      TransferBrandResponse: zodToJsonSchema(transferBrandResponseSchema),
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
        description: "Returns outlets deduplicated by outlet_id with nested campaign data. Always scoped by x-org-id. At least one of brandId or campaignId is required (org-only scoping returns 400). Status is a structured object from journalists-service with cumulative journalist counts.",
        parameters: [
          ...orgHeaders,
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "served", "skipped"] }, description: "Filter by internal DB status. Use this to filter outlets by their discovery pipeline state." },
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
                          relevanceScore: { type: "number", description: "Max relevance score across all campaigns for this outlet." },
                          status: outletStatusObject,
                          campaigns: {
                            type: "array",
                            description: "Campaign-level data for this outlet. Status breakdown is in status.byCampaign.",
                            items: {
                              type: "object",
                              properties: {
                                campaignId: { type: "string", format: "uuid" },
                                featureSlug: { type: "string" },
                                brandIds: { type: "array", items: { type: "string", format: "uuid" } },
                                whyRelevant: { type: "string" },
                                whyNotRelevant: { type: "string" },
                                relevanceScore: { type: "number" },
                                overallRelevance: { type: "string", nullable: true },
                                relevanceRationale: { type: "string", nullable: true },
                                runId: { type: "string", nullable: true },
                                updatedAt: { type: "string", format: "date-time" },
                              },
                              required: ["campaignId", "featureSlug", "brandIds", "relevanceScore", "updatedAt"],
                            },
                          },
                        },
                        required: ["id", "outletName", "outletUrl", "outletDomain", "createdAt", "relevanceScore", "status", "campaigns"],
                      },
                    },
                    total: { type: "integer", description: "Total distinct outlets matching filters (not truncated by pagination)" },
                    byOutreachStatus: {
                      ...statusCountsObject,
                      description: "Cumulative journalist status counts across ALL outlets matching filters. Passed through from journalists-service.",
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
                      status: {
                        totalJournalists: 3,
                        brand: null,
                        byCampaign: null,
                        campaign: { buffered: 3, claimed: 2, served: 2, skipped: 0, contacted: 2, sent: 2, delivered: 2, opened: 1, clicked: 0, replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, bounced: 0, unsubscribed: 0 },
                        global: { bounced: 0, unsubscribed: 0 },
                      },
                      campaigns: [
                        {
                          campaignId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                          featureSlug: "pr-outreach-v3",
                          brandIds: ["ffffffff-1111-2222-3333-444444444444"],
                          whyRelevant: "Top tech publication with high domain authority",
                          whyNotRelevant: "Highly competitive",
                          relevanceScore: 85,
                          overallRelevance: "high",
                          relevanceRationale: null,
                          runId: "cccccccc-dddd-eeee-ffff-111111111111",
                          updatedAt: "2026-01-15T12:00:00Z",
                        },
                      ],
                    },
                  ],
                  total: 1,
                  byOutreachStatus: { buffered: 3, claimed: 2, served: 2, skipped: 0, contacted: 2, sent: 2, delivered: 2, opened: 1, clicked: 0, replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, bounced: 0, unsubscribed: 0 },
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
              example: { status: "skipped", reason: "Cross-campaign duplicate" },
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
                    status: { type: "string", enum: ["open", "served", "skipped"] },
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
        description: "Returns outlet discovery stats: total outlets discovered, average relevance score, search queries used, and a `byOutreachStatus` breakdown with cumulative journalist counts from journalists-service. Supports filtering by brand, campaign, workflow, feature, and groupBy for dimensional breakdown.",
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
            description: "Stats (flat when no groupBy, grouped when groupBy is set). Flat response includes `byOutreachStatus` — cumulative journalist status counts from journalists-service.",
            content: {
              "application/json": {
                schema: { oneOf: [ref("StatsResponse"), ref("StatsGroupedResponse")] },
                example: {
                  outletsDiscovered: 42,
                  avgRelevanceScore: 72.5,
                  searchQueriesUsed: 8,
                  byOutreachStatus: {
                    buffered: 200, claimed: 150, served: 120, skipped: 30,
                    contacted: 115, sent: 110, delivered: 105, opened: 45, clicked: 12,
                    replied: 6, repliesPositive: 3, repliesNegative: 2, repliesNeutral: 1,
                    bounced: 5, unsubscribed: 0,
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
      post: {
        summary: "Lookup outlets by IDs and/or campaignId",
        description: "Internal endpoint — requires only x-api-key, no org context. At least one of `ids` or `campaignId` must be provided. When `campaignId` is provided, returns enriched campaign-outlet data including structured `status` from journalists-service. Without `campaignId`, returns basic outlet data only.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ids: { type: "array", items: { type: "string", format: "uuid" }, description: "Outlet UUIDs to look up" },
                  campaignId: { type: "string", format: "uuid", description: "Filter by campaign ID" },
                },
              },
            },
          },
        },
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
    "/internal/transfer-brand": {
      post: {
        summary: "Transfer solo-brand rows between orgs",
        description: "Re-assigns all solo-brand rows (where brand_ids contains exactly one element matching brandId) from sourceOrgId to targetOrgId. Skips co-branding rows. Idempotent — running twice is a no-op.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("TransferBrandBody"),
              example: {
                brandId: "ffffffff-1111-2222-3333-444444444444",
                sourceOrgId: "org-source-uuid",
                targetOrgId: "org-target-uuid",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Transfer completed",
            content: { "application/json": { schema: ref("TransferBrandResponse") } },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "500": { description: "Internal error", content: { "application/json": { schema: ref("ErrorResponse") } } },
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
