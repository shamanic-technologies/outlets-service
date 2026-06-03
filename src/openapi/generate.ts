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
  editorialEmailDiscoverSchema,
  editorialEmailDiscoverBatchSchema,
  editorialEmailResultSchema,
  editorialEmailBatchResultSchema,
  createPriceSourceSchema,
  outletPricingInternalSchema,
  outletPricingPublicSchema,
  ingestPriceSourceResponseSchema,
  ensureOutletSchema,
  createPricingSourceSchema,
  linkSourceOutletsSchema,
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

/** Status counts object — hybrid: open/served/skipped from outlets-service, email fields from journalists-service. */
const statusCountsObject = {
  type: "object",
  properties: {
    open: { type: "number" },
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
  required: ["open", "served", "skipped", "contacted", "sent", "delivered", "opened", "clicked", "replied", "repliesPositive", "repliesNegative", "repliesNeutral", "bounced", "unsubscribed"],
};

/** Per-outlet status object — hybrid: journalist-service data + outlets-service DB fields. */
const outletStatusObject = {
  type: "object",
  description: "Hybrid status object. Always includes outletStatus/statusReason/statusDetail from outlets-service DB. When journalist data exists, also includes totalJournalists, brand, byCampaign, campaign, and global from journalists-service.",
  properties: {
    outletStatus: { type: "string", enum: ["open", "served", "skipped"], description: "DB status from outlets-service (first/most recent campaign)" },
    statusReason: { type: "string", nullable: true, description: "Short reason for the outlet's status" },
    statusDetail: { type: "string", nullable: true, description: "Detailed debug info for the status" },
    totalJournalists: { type: "number", description: "Total journalists for this outlet (from journalists-service)" },
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
  required: ["outletStatus"],
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
      EditorialEmailDiscover: zodToJsonSchema(editorialEmailDiscoverSchema),
      EditorialEmailDiscoverBatch: zodToJsonSchema(editorialEmailDiscoverBatchSchema),
      EditorialEmailResult: zodToJsonSchema(editorialEmailResultSchema),
      EditorialEmailBatchResult: zodToJsonSchema(editorialEmailBatchResultSchema),
      CreatePriceSource: zodToJsonSchema(createPriceSourceSchema),
      OutletPricingInternal: zodToJsonSchema(outletPricingInternalSchema),
      OutletPricingPublic: zodToJsonSchema(outletPricingPublicSchema),
      IngestPriceSourceResponse: zodToJsonSchema(ingestPriceSourceResponseSchema),
      EnsureOutlet: zodToJsonSchema(ensureOutletSchema),
      CreatePricingSource: zodToJsonSchema(createPricingSourceSchema),
      LinkSourceOutlets: zodToJsonSchema(linkSourceOutletsSchema),
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
                          domainRating: { type: "integer", nullable: true, description: "Ahrefs Domain Rating from ahref-service (live read). null when ahref has not scraped this domain yet." },
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
                                statusReason: { type: "string", nullable: true, description: "Short reason for the outlet's status in this campaign" },
                                statusDetail: { type: "string", nullable: true, description: "Detailed debug info for the status" },
                                overallRelevance: { type: "string", nullable: true },
                                relevanceRationale: { type: "string", nullable: true },
                                runId: { type: "string", nullable: true },
                                updatedAt: { type: "string", format: "date-time" },
                              },
                              required: ["campaignId", "featureSlug", "brandIds", "relevanceScore", "updatedAt"],
                            },
                          },
                        },
                        required: ["id", "outletName", "outletUrl", "outletDomain", "domainRating", "createdAt", "relevanceScore", "status", "campaigns"],
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
                      domainRating: 93,
                      createdAt: "2026-01-01T00:00:00Z",
                      relevanceScore: 85,
                      status: {
                        outletStatus: "served",
                        statusReason: "buffer_claimed",
                        statusDetail: null,
                        totalJournalists: 3,
                        brand: null,
                        byCampaign: null,
                        campaign: { open: 0, served: 2, skipped: 0, contacted: 2, sent: 2, delivered: 2, opened: 1, clicked: 0, replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, bounced: 0, unsubscribed: 0 },
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
                  byOutreachStatus: { open: 1, served: 2, skipped: 0, contacted: 2, sent: 2, delivered: 2, opened: 1, clicked: 0, replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, bounced: 0, unsubscribed: 0 },
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
          "200": {
            description: "Outlet found",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    ref("OutletResponse"),
                    {
                      type: "object",
                      properties: {
                        domainRating: { type: "integer", nullable: true, description: "Ahrefs Domain Rating from ahref-service (live read). null when ahref has not scraped this domain yet." },
                      },
                      required: ["domainRating"],
                    },
                  ],
                },
              },
            },
          },
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
              example: { status: "skipped", statusReason: "blocked", statusDetail: "Already contacted for this brand in another campaign" },
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
                    statusReason: { type: "string", nullable: true, description: "Short reason for the status (e.g. 'blocked', 'low_relevance', 'buffer_claimed')" },
                    statusDetail: { type: "string", nullable: true, description: "Detailed debug info about why this status was set" },
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
    "/orgs/outlets/{id}/pricing": {
      get: {
        summary: "Get outlet sell pricing (org-scoped)",
        description: "Returns the SELL price (retail × sales multiplier) plus article terms for an outlet. Retail cost and the multiplier are never exposed here. Gated on the org owning the outlet (present in one of its campaigns) — 404 otherwise.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgHeaders],
        responses: {
          "200": { description: "Sell pricing", content: { "application/json": { schema: ref("OutletPricingPublic") } } },
          "404": { description: "Pricing not found (or outlet not owned by org)", content: { "application/json": { schema: ref("ErrorResponse") } } },
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
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["workflowSlug", "featureSlug", "brandId", "campaignId", "workflowDynastySlug"] }, description: "Group results by dimension" },
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
                    open: 50, served: 120, skipped: 30,
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
    "/orgs/outlets/editorial-emails/discover": {
      post: {
        summary: "Discover editorial emails for one outlet (org-scoped)",
        description: "Resolves newsroom/editorial contact emails from an outlet domain via a fallback ladder (scraping-service raw fetch of contact/about paths → sitemap discovery → render retry → serper Google fallback). Results are cached per (org, domain) for 60 days, including terminal no_email_found / parked_dead. Editorial-typed addresses (editorial@/editor/news/press…) are surfaced first.",
        parameters: [...orgHeaders],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("EditorialEmailDiscover"),
              example: { outletName: "Citywealth", domain: "citywealthmag.com", url: "https://citywealthmag.com" },
            },
          },
        },
        responses: {
          "200": {
            description: "Discovery result (status ∈ found | found_google | parked_dead | no_email_found)",
            content: {
              "application/json": {
                schema: ref("EditorialEmailResult"),
                example: {
                  domain: "citywealthmag.com",
                  status: "found",
                  emails: [{ email: "editorial@citywealthmag.com", score: 0, source: "https://citywealthmag.com/contact" }],
                },
              },
            },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/orgs/outlets/editorial-emails/discover-batch": {
      post: {
        summary: "Discover editorial emails for many outlets (org-scoped)",
        description: "Batch variant of editorial-email discovery. Runs a concurrency pool of 8 across domains (each domain's ladder is internally sequential so its early-stop works). Max 50 outlets per request — chunk larger sets.",
        parameters: [...orgHeaders],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("EditorialEmailDiscoverBatch"),
              example: {
                outlets: [
                  { outletName: "Citywealth", domain: "citywealthmag.com", url: "https://citywealthmag.com" },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Per-outlet discovery results",
            content: { "application/json": { schema: ref("EditorialEmailBatchResult") } },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
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
        description: "Re-assigns all solo-brand rows (where brand_ids contains exactly one element matching sourceBrandId) from sourceOrgId to targetOrgId. When targetBrandId is provided, also rewrites the brand reference. Skips co-branding rows. Idempotent — running twice is a no-op.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("TransferBrandBody"),
              example: {
                sourceBrandId: "ffffffff-1111-2222-3333-444444444444",
                sourceOrgId: "org-source-uuid",
                targetOrgId: "org-target-uuid",
                targetBrandId: "eeeeeeee-1111-2222-3333-444444444444",
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
    "/internal/outlets/{id}/price-sources": {
      post: {
        summary: "Append a raw pricing note + re-extract (internal)",
        description: "Appends one verbatim bronze note (journalist email / doc / sheet paste) for the outlet, then re-derives the silver pricing from ALL of the outlet's notes via the platform LLM. Returns the new bronze id and the refreshed internal pricing (incl. retail).",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("CreatePriceSource"),
              example: { rawText: "Hi! Sponsored post is $500, one dofollow link, stays up 12 months, 2 images max.", sourceType: "email" },
            },
          },
        },
        responses: {
          "201": { description: "Note stored + pricing extracted", content: { "application/json": { schema: ref("IngestPriceSourceResponse") } } },
          "404": { description: "Outlet not found", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Pricing extraction failed (note was stored — retry via reextract)", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets/{id}/pricing/reextract": {
      post: {
        summary: "Re-run silver pricing extraction (internal)",
        description: "Re-derives the silver pricing from the outlet's existing bronze notes without adding a new one. 404 if the outlet has no notes.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Pricing re-extracted", content: { "application/json": { schema: { type: "object", properties: { pricing: ref("OutletPricingInternal") }, required: ["pricing"] } } } },
          "404": { description: "No price sources for outlet", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Pricing extraction failed", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets/{id}/pricing": {
      get: {
        summary: "Get full outlet pricing incl. retail (internal)",
        description: "Returns the full silver pricing row including the retail cost (`amountCents`), sales multiplier, sell price, and extraction audit fields.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Internal pricing", content: { "application/json": { schema: ref("OutletPricingInternal") } } },
          "404": { description: "Pricing not found", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets/ensure": {
      post: {
        summary: "Ensure (upsert) a global outlet by domain (internal)",
        description: "Upserts a publication into the global outlets registry, keyed by domain. The admin/broker curation path — the only other outlet-create is org-scoped. Returns 201 when created, 200 when it already existed.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("EnsureOutlet"), example: { outletName: "TechBullion", outletUrl: "https://techbullion.com", outletDomain: "techbullion.com" } } },
        },
        responses: {
          "200": { description: "Outlet already existed" },
          "201": { description: "Outlet created" },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/pricing-sources": {
      post: {
        summary: "Create/ensure a broker pricing source (internal)",
        description: "A broker resells placement across many outlets, so its single quote prices N publications. Ensured by domain when provided.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreatePricingSource"), example: { name: "Matrix Global Brands", domain: "matrixglobalbrands.com" } } },
        },
        responses: {
          "201": { description: "Source created/ensured" },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/pricing-sources/{id}/outlets": {
      post: {
        summary: "Link outlets to a broker source (internal)",
        description: "Registers which outlets a broker covers (its inventory). Idempotent.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("LinkSourceOutlets"), example: { outletIds: ["11111111-2222-3333-4444-555555555555"] } } },
        },
        responses: {
          "200": { description: "Outlets linked", content: { "application/json": { schema: { type: "object", properties: { linked: { type: "integer" }, requested: { type: "integer" } }, required: ["linked", "requested"] } } } },
          "404": { description: "Source not found", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/pricing-sources/{id}/price-sources": {
      post: {
        summary: "Append a broker pricing note + fan-out re-extract (internal)",
        description: "Stores one broker quote (once), then re-derives silver pricing for EVERY outlet in the broker's inventory — the quote feeds each member outlet's extraction context. Returns the bronze id + per-outlet pricing.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("CreatePriceSource"), example: { rawText: "Single article $150, permanent, 1 dofollow link, up to 3 photos.", sourceType: "email" } } },
        },
        responses: {
          "201": { description: "Note stored + fan-out extracted", content: { "application/json": { schema: { type: "object", properties: { priceSourceId: { type: "string", format: "uuid" }, extracted: { type: "array", items: { type: "object", properties: { outletId: { type: "string", format: "uuid" }, pricing: ref("OutletPricingInternal") }, required: ["outletId", "pricing"] } } }, required: ["priceSourceId", "extracted"] } } } },
          "404": { description: "Source not found", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Extraction failed (note stored — retry)", content: { "application/json": { schema: ref("ErrorResponse") } } },
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
