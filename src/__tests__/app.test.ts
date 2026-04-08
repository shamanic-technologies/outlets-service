import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Mock the pool
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();

vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () =>
      mockConnect().then(() => ({
        query: mockQuery,
        release: mockRelease,
      })),
  },
}));

// Mock outlet-status service (used by GET /orgs/outlets for outreach status enrichment)
const mockFetchOutletStatuses = vi.fn();
vi.mock("../services/outlet-status", () => ({
  fetchOutletStatuses: (...args: unknown[]) => mockFetchOutletStatuses(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

/** Only x-org-id — for read/stats endpoints under /org */
function withBaseIdentity(req: request.Test): request.Test {
  return req
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG_ID);
}

/** x-org-id + all optional workflow headers — for write/workflow endpoints */
function withIdentity(req: request.Test): request.Test {
  return withBaseIdentity(req)
    .set("x-user-id", USER_ID)
    .set("x-run-id", RUN_ID)
    .set("x-campaign-id", CAMPAIGN_ID)
    .set("x-brand-id", BRAND_ID)
    .set("x-feature-slug", "outlets")
    .set("x-workflow-slug", "discover");
}

function withFullHeaders(req: request.Test): request.Test {
  return withIdentity(req);
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockFetchOutletStatuses.mockResolvedValue(new Map());
  app = createApp();
});

// ========================
// Health check
// ========================
describe("GET /health", () => {
  it("returns 200 with service info", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "outlets-service" });
  });
});

// ========================
// Outlets CRUD
// ========================
describe("POST /orgs/outlets", () => {
  it("creates an outlet with upsert", async () => {
    const outletRow = {
      id: "11111111-1111-1111-1111-111111111111",
      outlet_name: "TechCrunch",
      outlet_url: "https://techcrunch.com",
      outlet_domain: "techcrunch.com",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    // BEGIN, INSERT outlets, INSERT campaign_outlets, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT outlets
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await withFullHeaders(request(app).post("/orgs/outlets")).send({
      outletName: "TechCrunch",
      outletUrl: "https://techcrunch.com",
      outletDomain: "techcrunch.com",
      whyRelevant: "Top tech publication",
      whyNotRelevant: "Might be too competitive",
      relevanceScore: 85,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(outletRow.id);
    expect(res.body.outletName).toBe("TechCrunch");
    expect(res.body.campaignId).toBe(CAMPAIGN_ID);
    expect(res.body.brandIds).toEqual([BRAND_ID]);
    expect(res.body.relevanceScore).toBe(85);
    expect(res.body.status).toBe("open");
  });

  it("deduplicates by domain, not URL", async () => {
    const outletRow = {
      id: "11111111-1111-1111-1111-111111111111",
      outlet_name: "TechCrunch",
      outlet_url: "https://techcrunch.com/some/path",
      outlet_domain: "techcrunch.com",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT outlets (domain conflict → returns existing)
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await withFullHeaders(request(app).post("/orgs/outlets")).send({
      outletName: "TechCrunch",
      outletUrl: "https://techcrunch.com/different/path",
      outletDomain: "techcrunch.com",
      whyRelevant: "Good",
      whyNotRelevant: "None",
      relevanceScore: 90,
    });

    expect(res.status).toBe(201);
    // Verify the INSERT uses ON CONFLICT (outlet_domain)
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("ON CONFLICT (outlet_domain)");
    // The returned outlet is the existing one (same id)
    expect(res.body.id).toBe(outletRow.id);
  });

  it("returns 400 for invalid body", async () => {
    const res = await withFullHeaders(request(app).post("/orgs/outlets")).send({
      outletName: "",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});

describe("GET /orgs/outlets", () => {
  it("returns 400 without brandId or campaignId", async () => {
    const res = await withBaseIdentity(request(app).get("/orgs/outlets"));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("brandId or campaignId");
  });

  it("returns deduplicated outlets with outreachStatus (campaign-scoped)", async () => {
    // Step 1: paginated distinct outlet IDs
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
      rowCount: 1,
    });
    // Step 2: count total
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: 1 }],
    });
    // Step 3: all campaign_outlet rows for those outlet IDs
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          feature_slug: "pr-outreach",
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "served",
          overall_relevance: null,
          relevance_rationale: null,
          run_id: RUN_ID,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    // Enrichment returns "contacted" for this outlet
    mockFetchOutletStatuses.mockResolvedValueOnce(
      new Map([["11111111-1111-1111-1111-111111111111", { outreachStatus: "contacted", replyClassification: null }]])
    );

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      campaignId: CAMPAIGN_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    const outlet = res.body.outlets[0];
    expect(outlet.outletName).toBe("TechCrunch");
    expect(outlet.relevanceScore).toBe(85);
    expect(outlet.outreachStatus).toBe("contacted");
    expect(outlet.replyClassification).toBeNull();
    expect(outlet.campaigns).toHaveLength(1);
    expect(outlet.campaigns[0].campaignId).toBe(CAMPAIGN_ID);
    expect(outlet.campaigns[0].outreachStatus).toBe("contacted");
    expect(outlet.campaigns[0].relevanceScore).toBe(85);
    expect(outlet.campaigns[0].brandIds).toEqual([BRAND_ID]);
    // scopeFilters should be passed with campaignId
    expect(mockFetchOutletStatuses).toHaveBeenCalledWith(
      ["11111111-1111-1111-1111-111111111111"],
      expect.any(Object),
      { campaignId: CAMPAIGN_ID }
    );
  });

  it("enriches ALL outlets (not just served) with base identity only", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          feature_slug: "pr-outreach",
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "open",
          overall_relevance: null,
          relevance_rationale: null,
          run_id: RUN_ID,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    mockFetchOutletStatuses.mockResolvedValueOnce(
      new Map([["11111111-1111-1111-1111-111111111111", { outreachStatus: "delivered", replyClassification: null }]])
    );

    const res = await withBaseIdentity(request(app).get("/orgs/outlets")).query({
      campaignId: CAMPAIGN_ID,
    });

    expect(res.status).toBe(200);
    const outlet = res.body.outlets[0];
    expect(outlet.outreachStatus).toBe("delivered");
    expect(outlet.campaigns[0].outreachStatus).toBe("delivered");
    expect(mockFetchOutletStatuses).toHaveBeenCalledOnce();
  });

  it("outreachStatus uses enriched high watermark (brand-scoped with byCampaign breakdown)", async () => {
    const OUTLET_ID = "11111111-1111-1111-1111-111111111111";
    const CAMPAIGN_ID_2 = "33333333-3333-3333-3333-333333333333";

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: OUTLET_ID }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: OUTLET_ID,
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          feature_slug: "pr-outreach-v2",
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "90.00",
          outlet_status: "open",
          overall_relevance: "high",
          relevance_rationale: null,
          run_id: RUN_ID,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-03T00:00:00Z",
        },
        {
          id: OUTLET_ID,
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID_2,
          feature_slug: "pr-outreach",
          brand_ids: [BRAND_ID],
          why_relevant: "Good publication",
          why_not_relevant: "None",
          relevance_score: "85.00",
          outlet_status: "served",
          overall_relevance: null,
          relevance_rationale: null,
          run_id: null,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    // Enrichment returns brand-level high watermark + per-campaign breakdown
    mockFetchOutletStatuses.mockResolvedValueOnce(
      new Map([[OUTLET_ID, {
        outreachStatus: "delivered",
        replyClassification: null,
        byCampaign: {
          [CAMPAIGN_ID]: { outreachStatus: "contacted", replyClassification: null },
          [CAMPAIGN_ID_2]: { outreachStatus: "delivered", replyClassification: null },
        },
      }]])
    );

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      brandId: BRAND_ID,
    });

    expect(res.status).toBe(200);
    const outlet = res.body.outlets[0];
    // Outlet-level relevanceScore = max(90, 85) = 90
    expect(outlet.relevanceScore).toBe(90);
    // Outlet-level = enriched high watermark for the brand
    expect(outlet.outreachStatus).toBe("delivered");
    // Per-campaign = from byCampaign breakdown
    expect(outlet.campaigns[0].outreachStatus).toBe("contacted");
    expect(outlet.campaigns[1].outreachStatus).toBe("delivered");
  });

  it("falls back to DB status when no journalist data exists", async () => {
    const OUTLET_ID = "11111111-1111-1111-1111-111111111111";
    const CAMPAIGN_ID_2 = "33333333-3333-3333-3333-333333333333";

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: OUTLET_ID }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: OUTLET_ID,
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          feature_slug: "pr-outreach-v2",
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "90.00",
          outlet_status: "served",
          overall_relevance: "high",
          relevance_rationale: null,
          run_id: RUN_ID,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-03T00:00:00Z",
        },
        {
          id: OUTLET_ID,
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID_2,
          feature_slug: "pr-outreach",
          brand_ids: [BRAND_ID],
          why_relevant: "Good publication",
          why_not_relevant: "None",
          relevance_score: "85.00",
          outlet_status: "open",
          overall_relevance: null,
          relevance_rationale: null,
          run_id: null,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    // No journalist data for this outlet
    mockFetchOutletStatuses.mockResolvedValueOnce(new Map());

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      brandId: BRAND_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.total).toBe(1);
    const outlet = res.body.outlets[0];
    expect(outlet.campaigns).toHaveLength(2);
    expect(outlet.campaigns[0].campaignId).toBe(CAMPAIGN_ID);
    expect(outlet.campaigns[1].campaignId).toBe(CAMPAIGN_ID_2);
    // Outlet-level relevanceScore = max(90, 85) = 90
    expect(outlet.relevanceScore).toBe(90);
    // Fallback: most advanced DB status = "served"
    expect(outlet.outreachStatus).toBe("served");
    // Per-campaign fallback to DB status
    expect(outlet.campaigns[0].outreachStatus).toBe("served");
    expect(outlet.campaigns[1].outreachStatus).toBe("open");
  });

  it("filters by featureSlugs (comma-separated)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      brandId: BRAND_ID,
      featureSlugs: "pr-outreach,pr-outreach-sophia",
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([]);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.feature_slug IN");
  });

  it("filters by featureSlugs with single slug", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      brandId: BRAND_ID,
      featureSlugs: "pr-outreach",
    });

    expect(res.status).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.feature_slug IN");
  });

  it("crashes with 500 when status enrichment fails", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          feature_slug: "pr-outreach",
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "served",
          overall_relevance: null,
          relevance_rationale: null,
          run_id: RUN_ID,
          created_at: "2026-01-01T00:00:00Z",
          campaign_updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    mockFetchOutletStatuses.mockRejectedValueOnce(
      new Error("[outlets-service] journalists-service /orgs/outlets/status failed (502): email-gateway error")
    );

    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      campaignId: CAMPAIGN_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  it("returns empty array when no outlets match", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await withIdentity(request(app).get("/orgs/outlets")).query({
      campaignId: CAMPAIGN_ID,
    });
    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe("GET /orgs/outlets/:id", () => {
  it("returns an outlet by ID", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await withBaseIdentity(
      request(app).get("/orgs/outlets/11111111-1111-1111-1111-111111111111")
    );
    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("TechCrunch");
  });

  it("returns 404 for missing outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await withBaseIdentity(
      request(app).get("/orgs/outlets/99999999-9999-9999-9999-999999999999")
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /orgs/outlets/:id", () => {
  it("updates an outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "Updated Name",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await withBaseIdentity(
      request(app).patch("/orgs/outlets/11111111-1111-1111-1111-111111111111")
    ).send({ outletName: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("Updated Name");
  });

  it("returns 404 when outlet not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await withBaseIdentity(
      request(app).patch("/orgs/outlets/99999999-9999-9999-9999-999999999999")
    ).send({ outletName: "X" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /orgs/outlets/:id/status", () => {
  it("updates outlet status with x-campaign-id header", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: "11111111-1111-1111-1111-111111111111",
          campaign_id: CAMPAIGN_ID,
          status: "ended",
          relevance_rationale: "No longer relevant",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await withIdentity(
      request(app)
        .patch("/orgs/outlets/11111111-1111-1111-1111-111111111111/status")
        .set("x-campaign-id", CAMPAIGN_ID)
    ).send({ status: "ended", reason: "No longer relevant" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
  });
});

// ========================
// Bulk & Search
// ========================
describe("POST /orgs/outlets/bulk", () => {
  it("bulk upserts outlets", async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            outlet_name: "Outlet1",
            outlet_url: "https://outlet1.com",
            outlet_domain: "outlet1.com",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // campaign_outlets
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            outlet_name: "Outlet2",
            outlet_url: "https://outlet2.com",
            outlet_domain: "outlet2.com",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await withFullHeaders(request(app).post("/orgs/outlets/bulk")).send({
      outlets: [
        {
          outletName: "Outlet1",
          outletUrl: "https://outlet1.com",
          outletDomain: "outlet1.com",
          whyRelevant: "Good",
          whyNotRelevant: "None",
          relevanceScore: 90,
        },
        {
          outletName: "Outlet2",
          outletUrl: "https://outlet2.com",
          outletDomain: "outlet2.com",
          whyRelevant: "Also good",
          whyNotRelevant: "None",
          relevanceScore: 80,
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.outlets).toHaveLength(2);
    expect(res.body.outlets[0].campaignId).toBe(CAMPAIGN_ID);
  });
});

describe("POST /orgs/outlets/search", () => {
  it("searches outlets by name", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });

    const res = await withBaseIdentity(
      request(app).post("/orgs/outlets/search")
    ).send({ query: "tech" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
  });
});

// ========================
// Internal (unified GET /internal/outlets)
// ========================
describe("GET /internal/outlets", () => {
  it("returns outlets by IDs (no campaignId — no enrichment)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY)
      .query({ ids: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
    // No enrichment call for ids-only path
    expect(mockFetchOutletStatuses).not.toHaveBeenCalled();
  });

  it("returns 400 without ids or campaignId", async () => {
    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });

  it("returns campaign outlets by campaignId with outreachStatus enrichment", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          org_id: ORG_ID,
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "open",
          overall_relevance: "high",
          relevance_rationale: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    mockFetchOutletStatuses.mockResolvedValueOnce(
      new Map([["11111111-1111-1111-1111-111111111111", { outreachStatus: "contacted", replyClassification: null }]])
    );

    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY)
      .query({ campaignId: CAMPAIGN_ID });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
    expect(res.body.outlets[0].brandIds).toEqual([BRAND_ID]);
    expect(res.body.outlets[0].relevanceScore).toBe(85);
    expect(res.body.outlets[0].campaignId).toBe(CAMPAIGN_ID);
    expect(res.body.outlets[0].outreachStatus).toBe("contacted");
    expect(res.body.outlets[0].replyClassification).toBeNull();
  });

  it("falls back to DB status when no journalist data for internal outlets", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          org_id: ORG_ID,
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "served",
          overall_relevance: null,
          relevance_rationale: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    mockFetchOutletStatuses.mockResolvedValueOnce(new Map());

    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY)
      .query({ campaignId: CAMPAIGN_ID });

    expect(res.status).toBe(200);
    expect(res.body.outlets[0].outreachStatus).toBe("served");
  });

  it("filters by both ids and campaignId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          org_id: ORG_ID,
          brand_ids: [BRAND_ID],
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "open",
          overall_relevance: null,
          relevance_rationale: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    mockFetchOutletStatuses.mockResolvedValueOnce(new Map());

    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY)
      .query({ ids: "11111111-1111-1111-1111-111111111111", campaignId: CAMPAIGN_ID });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].campaignId).toBe(CAMPAIGN_ID);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("co.campaign_id = $1");
    expect(sql).toContain("o.id IN");
  });

  it("works with only x-api-key (no org headers needed)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .get("/internal/outlets")
      .set("x-api-key", API_KEY)
      .query({ ids: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
  });
});

// ========================
// Auth: API key + org-id
// ========================
describe("Auth middleware", () => {
  it("returns 401 without x-api-key", async () => {
    const res = await request(app)
      .get("/orgs/outlets")
      .set("x-org-id", ORG_ID);
    expect(res.status).toBe(401);
  });

  it("returns 400 without x-org-id on /orgs routes", async () => {
    const res = await request(app)
      .get("/orgs/outlets")
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("read endpoints require brandId or campaignId", async () => {
    const res = await withBaseIdentity(request(app).get("/orgs/outlets"));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("brandId or campaignId");
  });
});

// ========================
// Multi-brand support
// ========================
const BRAND_ID_2 = "66666666-6666-6666-6666-666666666666";

describe("Multi-brand x-brand-id CSV header", () => {
  it("parses comma-separated brand IDs and stores as brand_ids array", async () => {
    const outletRow = {
      id: "11111111-1111-1111-1111-111111111111",
      outlet_name: "TechCrunch",
      outlet_url: "https://techcrunch.com",
      outlet_domain: "techcrunch.com",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT outlets
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await withIdentity(request(app).post("/orgs/outlets"))
      .set("x-campaign-id", CAMPAIGN_ID)
      .set("x-brand-id", `${BRAND_ID},${BRAND_ID_2}`)
      .send({
        outletName: "TechCrunch",
        outletUrl: "https://techcrunch.com",
        outletDomain: "techcrunch.com",
        whyRelevant: "Top tech publication",
        whyNotRelevant: "Might be too competitive",
        relevanceScore: 85,
      });

    expect(res.status).toBe(201);
    expect(res.body.brandIds).toEqual([BRAND_ID, BRAND_ID_2]);

    const campaignInsertCall = mockQuery.mock.calls[2];
    expect(campaignInsertCall[1][3]).toEqual([BRAND_ID, BRAND_ID_2]);
  });
});
