import fs from "fs";
import path from "path";
import {
  createOutletSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
  bulkCreateOutletsSchema,
  searchOutletsSchema,
  createCategorySchema,
  updateCategorySchema,
  healthResponseSchema,
  errorResponseSchema,
} from "../schemas";
import { zodToJsonSchema } from "./zod-to-json";

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

const orgContextHeaders = [
  { in: "header", name: "x-org-id", schema: { type: "string", format: "uuid" }, description: "Organization ID (from client-service)" },
  { in: "header", name: "x-user-id", schema: { type: "string", format: "uuid" }, description: "User ID (from client-service)" },
];

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Outlets Service",
    description: "Manages press outlets (publications) and their campaign relevance data. Domain rating data is managed by the ahref-service.",
    version: "1.0.0",
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
      CreateCategory: zodToJsonSchema(createCategorySchema),
      UpdateCategory: zodToJsonSchema(updateCategorySchema),
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
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("CreateOutlet") } } },
        responses: {
          "201": { description: "Outlet created" },
          "400": { description: "Validation error", content: { "application/json": { schema: ref("ErrorResponse") } } },
        },
      },
      get: {
        summary: "List outlets with filters",
        parameters: [
          { in: "query", name: "campaignId", schema: { type: "string", format: "uuid" } },
          { in: "query", name: "status", schema: { type: "string", enum: ["open", "ended", "denied"] } },
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
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Outlet found" },
          "404": { description: "Outlet not found" },
        },
      },
      patch: {
        summary: "Update outlet",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("UpdateOutlet") } } },
        responses: {
          "200": { description: "Outlet updated" },
          "404": { description: "Outlet not found" },
        },
      },
    },
    "/outlets/{id}/status": {
      patch: {
        summary: "Update outlet status",
        parameters: [
          { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } },
          { in: "query", name: "campaignId", required: true, schema: { type: "string", format: "uuid" } },
          ...orgContextHeaders,
        ],
        requestBody: { content: { "application/json": { schema: ref("UpdateOutletStatus") } } },
        responses: {
          "200": { description: "Status updated" },
          "404": { description: "Not found" },
        },
      },
    },
    "/outlets/bulk": {
      post: {
        summary: "Bulk upsert outlets",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("BulkCreateOutlets") } } },
        responses: {
          "201": { description: "Outlets created" },
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
    "/outlets/status": {
      get: {
        summary: "Outlets with targeting readiness status",
        parameters: [{ in: "query", name: "campaignId", schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Outlet status list" } },
      },
    },
    "/outlets/has-topics-articles": {
      get: {
        summary: "Outlets that need topic/article updates",
        responses: { "200": { description: "Outlets needing updates" } },
      },
    },
    "/outlets/has-recent-articles": {
      get: {
        summary: "Outlets with recent articles to search",
        responses: { "200": { description: "Outlets with recent articles" } },
      },
    },
    "/outlets/has-journalists": {
      get: {
        summary: "Outlets with journalist coverage status",
        responses: { "200": { description: "Outlets with journalist info" } },
      },
    },
    "/categories": {
      post: {
        summary: "Create press category",
        parameters: [...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("CreateCategory") } } },
        responses: {
          "201": { description: "Category created" },
        },
      },
      get: {
        summary: "List categories by campaign",
        parameters: [{ in: "query", name: "campaignId", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Category list" },
        },
      },
    },
    "/categories/{id}": {
      patch: {
        summary: "Update category",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("UpdateCategory") } } },
        responses: {
          "200": { description: "Category updated" },
          "404": { description: "Not found" },
        },
      },
    },
    "/categories/{id}/status": {
      patch: {
        summary: "Update category status",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }, ...orgContextHeaders],
        requestBody: { content: { "application/json": { schema: ref("UpdateCategory") } } },
        responses: {
          "200": { description: "Category status updated" },
          "404": { description: "Not found" },
        },
      },
    },
    "/internal/outlets/by-ids": {
      get: {
        summary: "Batch lookup outlets by IDs",
        parameters: [{ in: "query", name: "ids", required: true, schema: { type: "string" }, description: "Comma-separated outlet IDs" }],
        responses: {
          "200": { description: "Outlets found" },
        },
      },
    },
    "/internal/outlets/by-campaign/{campaignId}": {
      get: {
        summary: "All outlets for a campaign",
        parameters: [{ in: "path", name: "campaignId", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Campaign outlets" },
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
