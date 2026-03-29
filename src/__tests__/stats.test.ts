import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Mock the pool
const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}));

// Mock runs service
const mockBatchRunCosts = vi.fn();
vi.mock("../services/runs", () => ({
  createChildRun: vi.fn(),
  closeRun: vi.fn(),
  batchRunCosts: (...args: unknown[]) => mockBatchRunCosts(...args),
}));

// Mock dynasty service
vi.mock("../services/dynasty", () => ({
  resolveWorkflowDynastySlugs: vi.fn(),
  resolveFeatureDynastySlugs: vi.fn(),
  getWorkflowDynastyMap: vi.fn(),
  getFeatureDynastyMap: vi.fn(),
}));

import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../services/dynasty";

const mockedResolveWorkflow = vi.mocked(resolveWorkflowDynastySlugs);
const mockedResolveFeature = vi.mocked(resolveFeatureDynastySlugs);
const mockedGetWorkflowMap = vi.mocked(getWorkflowDynastyMap);
const mockedGetFeatureMap = vi.mocked(getFeatureDynastyMap);

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function withIdentity(req: request.Test): request.Test {
  return req.set("x-org-id", ORG_ID).set("x-user-id", USER_ID).set("x-run-id", RUN_ID);
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

// ========================
// Filter: featureSlug
// ========================
describe("GET /outlets/stats?featureSlug=...", () => {
  it("filters by exact featureSlug", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 5, avg_relevance_score: "72.50", search_queries_used: 10 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      featureSlug: "cold-email-sophia",
    });

    expect(res.status).toBe(200);
    expect(res.body.outletsDiscovered).toBe(5);
    // Verify the SQL contains feature_slug filter
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.feature_slug = $2");
    expect(mockQuery.mock.calls[0][1]).toContain("cold-email-sophia");
  });
});

// ========================
// Filter: workflowSlug
// ========================
describe("GET /outlets/stats?workflowSlug=...", () => {
  it("filters by exact workflowSlug", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 3, avg_relevance_score: "80.00", search_queries_used: 6 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      workflowSlug: "cold-email-v2",
    });

    expect(res.status).toBe(200);
    expect(res.body.outletsDiscovered).toBe(3);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.workflow_slug = $2");
  });
});

// ========================
// Filter: workflowDynastySlug
// ========================
describe("GET /outlets/stats?workflowDynastySlug=...", () => {
  it("resolves dynasty and filters with IN clause", async () => {
    mockedResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2", "cold-email-v3"]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 12, avg_relevance_score: "75.00", search_queries_used: 20 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      workflowDynastySlug: "cold-email",
    });

    expect(res.status).toBe(200);
    expect(res.body.outletsDiscovered).toBe(12);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.workflow_slug IN ($2, $3, $4)");
    expect(mockQuery.mock.calls[0][1]).toEqual([ORG_ID, "cold-email", "cold-email-v2", "cold-email-v3"]);
  });

  it("returns zero stats when dynasty resolves to empty list", async () => {
    mockedResolveWorkflow.mockResolvedValueOnce([]);

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      workflowDynastySlug: "nonexistent-dynasty",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outletsDiscovered: 0, avgRelevanceScore: 0, searchQueriesUsed: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("dynasty takes priority over exact workflowSlug", async () => {
    mockedResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 8, avg_relevance_score: "70.00", search_queries_used: 15 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      workflowDynastySlug: "cold-email",
      workflowSlug: "cold-email-v2", // should be ignored
    });

    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("IN");
    expect(sql).not.toMatch(/co\.workflow_slug = \$\d+ AND.*co\.workflow_slug IN/);
  });
});

// ========================
// Filter: featureDynastySlug
// ========================
describe("GET /outlets/stats?featureDynastySlug=...", () => {
  it("resolves dynasty and filters with IN clause", async () => {
    mockedResolveFeature.mockResolvedValueOnce(["feat-alpha", "feat-alpha-v2"]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 7, avg_relevance_score: "65.00", search_queries_used: 14 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      featureDynastySlug: "feat-alpha",
    });

    expect(res.status).toBe(200);
    expect(res.body.outletsDiscovered).toBe(7);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.feature_slug IN ($2, $3)");
  });

  it("returns zero stats when dynasty resolves to empty list", async () => {
    mockedResolveFeature.mockResolvedValueOnce([]);

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      featureDynastySlug: "empty-dynasty",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outletsDiscovered: 0, avgRelevanceScore: 0, searchQueriesUsed: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ========================
// Combined filters
// ========================
describe("GET /outlets/stats with combined dynasty + other filters", () => {
  it("combines brandId with workflowDynastySlug", async () => {
    mockedResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlets_discovered: 4, avg_relevance_score: "80.00", search_queries_used: 8 }],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      brandId: "55555555-5555-5555-5555-555555555555",
      workflowDynastySlug: "cold-email",
    });

    expect(res.status).toBe(200);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toEqual([ORG_ID, "55555555-5555-5555-5555-555555555555", "cold-email", "cold-email-v2"]);
  });
});

// ========================
// GroupBy: featureSlug
// ========================
describe("GET /outlets/stats?groupBy=featureSlug", () => {
  it("groups by feature_slug column", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { group_key: "feat-alpha", outlets_discovered: 5, avg_relevance_score: "80.00", search_queries_used: 10 },
        { group_key: "feat-beta", outlets_discovered: 3, avg_relevance_score: "70.00", search_queries_used: 6 },
      ],
    });

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      groupBy: "featureSlug",
    });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].key).toBe("feat-alpha");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.feature_slug AS group_key");
  });
});

// ========================
// GroupBy: workflowDynastySlug
// ========================
describe("GET /outlets/stats?groupBy=workflowDynastySlug", () => {
  it("groups by dynasty, re-aggregating versioned slugs", async () => {
    // DB returns rows grouped by raw workflow_slug
    mockQuery.mockResolvedValueOnce({
      rows: [
        { group_key: "cold-email", outlets_discovered: 5, avg_relevance_score: "80.00", search_queries_used: 10 },
        { group_key: "cold-email-v2", outlets_discovered: 3, avg_relevance_score: "70.00", search_queries_used: 6 },
        { group_key: "warm-intro", outlets_discovered: 2, avg_relevance_score: "60.00", search_queries_used: 4 },
      ],
    });

    // Dynasty map: cold-email and cold-email-v2 → "cold-email" dynasty
    mockedGetWorkflowMap.mockResolvedValueOnce(
      new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
        ["warm-intro", "warm-intro"],
      ])
    );

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      groupBy: "workflowDynastySlug",
    });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);

    // cold-email dynasty: 5+3=8 outlets, weighted avg = (80*5 + 70*3)/(5+3) = 610/8 = 76.25
    const coldEmail = res.body.groups.find((g: any) => g.key === "cold-email");
    expect(coldEmail).toBeDefined();
    expect(coldEmail.outletsDiscovered).toBe(8);
    expect(coldEmail.avgRelevanceScore).toBe(76.25);
    expect(coldEmail.searchQueriesUsed).toBe(16);

    // warm-intro dynasty: 2 outlets
    const warmIntro = res.body.groups.find((g: any) => g.key === "warm-intro");
    expect(warmIntro).toBeDefined();
    expect(warmIntro.outletsDiscovered).toBe(2);
  });

  it("falls back to raw slug when slug is not in dynasty map", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { group_key: "orphan-slug", outlets_discovered: 1, avg_relevance_score: "50.00", search_queries_used: 2 },
      ],
    });

    mockedGetWorkflowMap.mockResolvedValueOnce(new Map()); // empty map

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      groupBy: "workflowDynastySlug",
    });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].key).toBe("orphan-slug"); // fallback to raw slug
  });
});

// ========================
// GroupBy: featureDynastySlug
// ========================
describe("GET /outlets/stats?groupBy=featureDynastySlug", () => {
  it("groups by feature dynasty, re-aggregating versioned slugs", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { group_key: "feat-alpha", outlets_discovered: 4, avg_relevance_score: "90.00", search_queries_used: 8 },
        { group_key: "feat-alpha-v2", outlets_discovered: 6, avg_relevance_score: "85.00", search_queries_used: 12 },
      ],
    });

    mockedGetFeatureMap.mockResolvedValueOnce(
      new Map([
        ["feat-alpha", "feat-alpha"],
        ["feat-alpha-v2", "feat-alpha"],
      ])
    );

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      groupBy: "featureDynastySlug",
    });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    // weighted avg = (90*4 + 85*6)/(4+6) = (360+510)/10 = 87
    expect(res.body.groups[0].key).toBe("feat-alpha");
    expect(res.body.groups[0].outletsDiscovered).toBe(10);
    expect(res.body.groups[0].avgRelevanceScore).toBe(87);
    expect(res.body.groups[0].searchQueriesUsed).toBe(20);
  });

  it("falls back to raw slug for orphan slugs", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { group_key: "orphan-feat", outlets_discovered: 2, avg_relevance_score: "60.00", search_queries_used: 4 },
      ],
    });

    mockedGetFeatureMap.mockResolvedValueOnce(new Map());

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      groupBy: "featureDynastySlug",
    });

    expect(res.status).toBe(200);
    expect(res.body.groups[0].key).toBe("orphan-feat");
  });
});

// ========================
// Empty dynasty + groupBy
// ========================
describe("GET /outlets/stats with empty dynasty filter + groupBy", () => {
  it("returns empty groups when dynasty resolves to empty list", async () => {
    mockedResolveWorkflow.mockResolvedValueOnce([]);

    const res = await withIdentity(request(app).get("/outlets/stats")).query({
      workflowDynastySlug: "nonexistent",
      groupBy: "brandId",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ========================
// Stats Costs
// ========================
const BRAND_ID = "55555555-5555-5555-5555-555555555555";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID_1 = "aaaa1111-1111-1111-1111-111111111111";
const RUN_ID_2 = "aaaa2222-2222-2222-2222-222222222222";
const OUTLET_ID_1 = "bbbb1111-1111-1111-1111-111111111111";
const OUTLET_ID_2 = "bbbb2222-2222-2222-2222-222222222222";
const OUTLET_ID_3 = "bbbb3333-3333-3333-3333-333333333333";

describe("GET /outlets/stats/costs", () => {
  it("returns empty groups when no outlets have run_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withIdentity(request(app).get("/outlets/stats/costs"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
  });

  it("returns flat totals without groupBy", async () => {
    // DB: distinct runs with outlet counts
    mockQuery.mockResolvedValueOnce({
      rows: [
        { run_id: RUN_ID_1, outlet_count: 3 },
        { run_id: RUN_ID_2, outlet_count: 2 },
      ],
    });

    // runs-service batch costs
    mockBatchRunCosts.mockResolvedValueOnce([
      { runId: RUN_ID_1, totalCostInUsdCents: 300, actualCostInUsdCents: 200, provisionedCostInUsdCents: 100 },
      { runId: RUN_ID_2, totalCostInUsdCents: 150, actualCostInUsdCents: 150, provisionedCostInUsdCents: 0 },
    ]);

    const res = await withIdentity(request(app).get("/outlets/stats/costs"));

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].totalCostInUsdCents).toBe(450);
    expect(res.body.groups[0].actualCostInUsdCents).toBe(350);
    expect(res.body.groups[0].provisionedCostInUsdCents).toBe(100);
    expect(res.body.groups[0].runCount).toBe(2);
  });

  it("groups by runId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { run_id: RUN_ID_1, outlet_count: 3 },
        { run_id: RUN_ID_2, outlet_count: 2 },
      ],
    });

    mockBatchRunCosts.mockResolvedValueOnce([
      { runId: RUN_ID_1, totalCostInUsdCents: 300, actualCostInUsdCents: 200, provisionedCostInUsdCents: 100 },
      { runId: RUN_ID_2, totalCostInUsdCents: 150, actualCostInUsdCents: 150, provisionedCostInUsdCents: 0 },
    ]);

    const res = await withIdentity(request(app).get("/outlets/stats/costs")).query({ groupBy: "runId" });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);

    const run1 = res.body.groups.find((g: any) => g.dimensions.runId === RUN_ID_1);
    expect(run1.totalCostInUsdCents).toBe(300);
    expect(run1.outletCount).toBe(3);
    expect(run1.runCount).toBe(1);

    const run2 = res.body.groups.find((g: any) => g.dimensions.runId === RUN_ID_2);
    expect(run2.totalCostInUsdCents).toBe(150);
    expect(run2.outletCount).toBe(2);
  });

  it("groups by outletId with cost = run cost / outlets in run", async () => {
    // Run 1 produced 2 outlets, run 2 produced 1 outlet
    mockQuery.mockResolvedValueOnce({
      rows: [
        { run_id: RUN_ID_1, outlet_count: 2 },
        { run_id: RUN_ID_2, outlet_count: 1 },
      ],
    });

    mockBatchRunCosts.mockResolvedValueOnce([
      { runId: RUN_ID_1, totalCostInUsdCents: 200, actualCostInUsdCents: 200, provisionedCostInUsdCents: 0 },
      { runId: RUN_ID_2, totalCostInUsdCents: 100, actualCostInUsdCents: 100, provisionedCostInUsdCents: 0 },
    ]);

    // Outlet-to-run mapping query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_id: OUTLET_ID_1, run_id: RUN_ID_1 },
        { outlet_id: OUTLET_ID_2, run_id: RUN_ID_1 },
        { outlet_id: OUTLET_ID_3, run_id: RUN_ID_2 },
      ],
    });

    const res = await withIdentity(request(app).get("/outlets/stats/costs")).query({ groupBy: "outletId" });

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(3);

    // Outlet 1 & 2: from run1 (200 cents / 2 outlets = 100 each)
    const o1 = res.body.groups.find((g: any) => g.dimensions.outletId === OUTLET_ID_1);
    expect(o1.totalCostInUsdCents).toBe(100);

    const o2 = res.body.groups.find((g: any) => g.dimensions.outletId === OUTLET_ID_2);
    expect(o2.totalCostInUsdCents).toBe(100);

    // Outlet 3: from run2 (100 cents / 1 outlet = 100)
    const o3 = res.body.groups.find((g: any) => g.dimensions.outletId === OUTLET_ID_3);
    expect(o3.totalCostInUsdCents).toBe(100);
  });

  it("filters by brandId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withIdentity(request(app).get("/outlets/stats/costs")).query({ brandId: BRAND_ID });

    expect(res.status).toBe(200);
    // Verify brandId was included in the WHERE clause
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain("co.brand_id");
    expect(queryCall[1]).toContain(BRAND_ID);
  });

  it("filters by campaignId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withIdentity(request(app).get("/outlets/stats/costs")).query({ campaignId: CAMPAIGN_ID });

    expect(res.status).toBe(200);
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain("co.campaign_id");
    expect(queryCall[1]).toContain(CAMPAIGN_ID);
  });

  it("returns 502 when runs-service is down", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ run_id: RUN_ID_1, outlet_count: 1 }],
    });

    mockBatchRunCosts.mockRejectedValueOnce(
      new Error("runs-service POST /v1/runs/costs/batch failed (503): Service Unavailable")
    );

    const res = await withIdentity(request(app).get("/outlets/stats/costs"));

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("runs-service");
  });

  it("handles runs with zero cost gracefully", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ run_id: RUN_ID_1, outlet_count: 5 }],
    });

    // Run exists but has no cost entries yet
    mockBatchRunCosts.mockResolvedValueOnce([]);

    const res = await withIdentity(request(app).get("/outlets/stats/costs"));

    expect(res.status).toBe(200);
    expect(res.body.groups[0].totalCostInUsdCents).toBe(0);
    expect(res.body.groups[0].runCount).toBe(1);
  });
});
