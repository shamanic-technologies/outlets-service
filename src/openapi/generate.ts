import fs from "fs";
import path from "path";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
  discoverOutletsSchema,
  discoverOutletsResponseSchema,
  bufferNextSchema,
  bufferNextResponseSchema,
  healthResponseSchema,
  errorResponseSchema,
  outletResponseSchema,
  campaignOutletResponseSchema,
  statsResponseSchema,
  statsGroupedResponseSchema,
} from "../schemas";
import { zodToJsonSchema } from "./zod-to-json";

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

const orgContextHeaders = [
  { in: "header", name: "x-org-id", required: true, schema: { type: "string", format: "uuid" }, description: "Organization ID (from client-service)" },
  { in: "header", name: "x-user-id", required: true, schema: { type: "string", format: "uuid" }, description: "User ID (from client-service)" },
  { in: "header", name: "x-run-id", required: true, schema: { type: "string", format: "uuid" }, description: "Run ID (caller's run from runs-service)" },
  { in: "header", name: "x-feature-slug", required: false, schema: { type: "string" }, description: "Feature slug for tracking (propagated downstream)" },
  { in: "header", name: "x-campaign-id", required: false, schema: { type: "string", format: "uuid" }, description: "Campaign ID (required for mutating endpoints)" },
  { in: "header", name: "x-brand-id", required: false, schema: { type: "string", format: "uuid" }, description: "Brand ID (required for mutating endpoints)" },
  { in: "header", name: "x-workflow-name", required: false, schema: { type: "string" }, description: "Workflow name for tracking (propagated downstream)" },
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
      DiscoverOutlets: zodToJsonSchema(discoverOutletsSchema),
      DiscoverOutletsResponse: zodToJsonSchema(discoverOutletsResponseSchema),
      BufferNext: zodToJsonSchema(bufferNextSchema),
      BufferNextResponse: zodToJsonSchema(bufferNextResponseSchema),
      OutletResponse: zodToJsonSchema(outletResponseSchema),
      CampaignOutletResponse: zodToJsonSchema(campaignOutletResponseSchema),
      StatsResponse: zodToJsonSchema(statsResponseSchema),
      StatsGroupedResponse: zodToJsonSchema(statsGroupedResponseSchema),
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
        description: "Requires x-campaign-id and x-brand-id headers.",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("CreateOutlet") } } },
        responses: {
          "201": { description: "Outlet created", content: { "application/json": { schema: ref("CampaignOutletResponse") } } },
          "400": { description: "Validation error or missing headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
      get: {
        summary: "List outlets with filters",
        parameters: [
          ...orgContextHeaders,
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" } },
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" } },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "ended", "denied", "served", "skipped"] } },
          { in: "query", name: "limit", schema: { type: "integer", default: 100 } },
          { in: "query", name: "offset", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": { description: "List of outlets" },
        },
      },
    },
    "/outlets/{id}": {
      get: {
        summary: "Get outlet by ID",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgContextHeaders],
        responses: {
          "200": { description: "Outlet found", content: { "application/json": { schema: ref("OutletResponse") } } },
          "404": { description: "Outlet not found" },
        },
      },
      patch: {
        summary: "Update outlet",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgContextHeaders],
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
        description: "Requires x-campaign-id header to identify the campaign_outlets row.",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } },
          ...orgContextHeaders,
        ],
        requestBody: { content: { "application/json": { schema: ref("UpdateOutletStatus") } } },
        responses: {
          "200": { description: "Status updated" },
          "400": { description: "Missing x-campaign-id header" },
          "404": { description: "Not found" },
        },
      },
    },
    "/outlets/bulk": {
      post: {
        summary: "Bulk upsert outlets",
        description: "Requires x-campaign-id and x-brand-id headers. All outlets in the batch share the same campaign and brand.",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("BulkCreateOutlets") } } },
        responses: {
          "201": { description: "Outlets created" },
          "400": { description: "Validation error or missing headers" },
        },
      },
    },
    "/outlets/search": {
      post: {
        summary: "Search outlets by name/url",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("SearchOutlets") } } },
        responses: {
          "200": { description: "Search results" },
        },
      },
    },
    "/outlets/stats": {
      get: {
        summary: "Aggregated outlet discovery metrics",
        description: "Returns outlet discovery stats (count, avg relevance, search queries used). Supports filtering by brandId, campaignId, workflowName and optional groupBy.",
        parameters: [
          ...orgContextHeaders,
          { in: "query", name: "brandId", schema: { type: "string", format: "uuid" }, description: "Filter by brand ID" },
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" }, description: "Filter by campaign ID" },
          { in: "query", name: "workflowName", schema: { type: "string" }, description: "Filter by workflow name" },
          { in: "query", name: "groupBy", schema: { type: "string", enum: ["workflowName", "brandId", "campaignId"] }, description: "Group results by this dimension" },
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
    "/outlets/discover": {
      post: {
        summary: "Discover relevant outlets via Google search + LLM scoring",
        description: "Requires x-campaign-id and x-brand-id headers. Fetches brand data from brand-service, generates search queries via LLM, searches Google via google-service, scores results for relevance via LLM, and bulk upserts discovered outlets. Pass featureInput as opaque context forwarded to LLM calls.",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("DiscoverOutlets") } } },
        responses: {
          "201": { description: "Outlets discovered and saved", content: { "application/json": { schema: ref("DiscoverOutletsResponse") } } },
          "200": { description: "No outlets found (empty results)" },
          "400": { description: "Validation error or missing headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error (brand-service, chat-service, or google-service)", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/buffer/next": {
      post: {
        summary: "Pull the next best outlet from the buffer",
        description: "Buffer-first strategy: returns the highest-scored open outlet for the campaign. If the buffer is empty, triggers a lightweight mini-discover (3 queries × 5 Google results, LLM scoring) to refill it, then returns the top result. Supports idempotency via optional idempotencyKey. Requires x-campaign-id and x-brand-id headers.",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("BufferNext") } } },
        responses: {
          "200": { description: "Next outlet from buffer (found: true) or no outlets available (found: false)", content: { "application/json": { schema: ref("BufferNextResponse") } } },
          "400": { description: "Missing required headers", content: { "application/json": { schema: ref("ErrorResponse") } } },
          "502": { description: "Upstream service error during mini-discover", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
    },
    "/internal/outlets/by-ids": {
      get: {
        summary: "Batch lookup outlets by IDs",
        parameters: [...orgContextHeaders, { in: "query", name: "ids", required: true, schema: { type: "string" }, description: "Comma-separated outlet IDs" }],
        responses: {
          "200": {
            description: "Outlets found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: { type: "array", items: ref("OutletResponse") },
                  },
                  required: ["outlets"],
                },
              },
            },
          },
        },
      },
    },
    "/internal/outlets/by-campaign/{campaignId}": {
      get: {
        summary: "All outlets for a campaign, sorted by relevance score descending",
        parameters: [...orgContextHeaders, { in: "path", name: "campaignId", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Campaign outlets sorted by relevance score (descending)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    outlets: { type: "array", items: ref("CampaignOutletResponse") },
                  },
                  required: ["outlets"],
                },
              },
            },
          },
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
