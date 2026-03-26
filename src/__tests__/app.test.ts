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

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

function withIdentity(req: request.Test): request.Test {
  return req.set("x-org-id", ORG_ID).set("x-user-id", USER_ID).set("x-run-id", RUN_ID);
}

function withFullHeaders(req: request.Test): request.Test {
  return withIdentity(req)
    .set("x-campaign-id", CAMPAIGN_ID)
    .set("x-brand-id", BRAND_ID);
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
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
describe("POST /outlets", () => {
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

    const res = await withFullHeaders(request(app).post("/outlets")).send({
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
    expect(res.body.brandId).toBe(BRAND_ID);
    expect(res.body.relevanceScore).toBe(85);
    expect(res.body.outletStatus).toBe("open");
  });

  it("returns 400 when x-campaign-id header is missing", async () => {
    const res = await withIdentity(request(app).post("/outlets"))
      .set("x-brand-id", BRAND_ID)
      .send({
        outletName: "TechCrunch",
        outletUrl: "https://techcrunch.com",
        outletDomain: "techcrunch.com",
        whyRelevant: "Good",
        whyNotRelevant: "None",
        relevanceScore: 85,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
  });

  it("returns 400 for invalid body", async () => {
    const res = await withFullHeaders(request(app).post("/outlets")).send({
      outletName: "",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});

describe("GET /outlets", () => {
  it("lists outlets with campaign data", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
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
      rowCount: 1,
    });

    const res = await withIdentity(request(app).get("/outlets")).query({
      campaignId: CAMPAIGN_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
    expect(res.body.outlets[0].relevanceScore).toBe(85);
    expect(res.body.outlets[0].brandId).toBe(BRAND_ID);
  });

  it("lists outlets without filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await withIdentity(request(app).get("/outlets"));
    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([]);
  });
});

describe("GET /outlets/:id", () => {
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

    const res = await withIdentity(
      request(app).get("/outlets/11111111-1111-1111-1111-111111111111")
    );
    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("TechCrunch");
  });

  it("returns 404 for missing outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await withIdentity(
      request(app).get("/outlets/99999999-9999-9999-9999-999999999999")
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /outlets/:id", () => {
  it("updates an outlet", async () => {
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

    const res = await withIdentity(
      request(app).patch("/outlets/11111111-1111-1111-1111-111111111111")
    ).send({ outletName: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("Updated Name");
  });

  it("returns 404 when outlet not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await withIdentity(
      request(app).patch("/outlets/99999999-9999-9999-9999-999999999999")
    ).send({ outletName: "X" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /outlets/:id/status", () => {
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
        .patch("/outlets/11111111-1111-1111-1111-111111111111/status")
        .set("x-campaign-id", CAMPAIGN_ID)
    ).send({ status: "ended", reason: "No longer relevant" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
  });

  it("returns 400 without x-campaign-id header", async () => {
    const res = await withIdentity(
      request(app).patch(
        "/outlets/11111111-1111-1111-1111-111111111111/status"
      )
    ).send({ status: "ended" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
  });
});

// ========================
// Bulk & Search
// ========================
describe("POST /outlets/bulk", () => {
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

    const res = await withFullHeaders(request(app).post("/outlets/bulk")).send({
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

  it("returns 400 without x-campaign-id and x-brand-id headers", async () => {
    const res = await withIdentity(request(app).post("/outlets/bulk")).send({
      outlets: [
        {
          outletName: "Outlet1",
          outletUrl: "https://outlet1.com",
          outletDomain: "outlet1.com",
          whyRelevant: "Good",
          whyNotRelevant: "None",
          relevanceScore: 90,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
  });
});

describe("POST /outlets/search", () => {
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

    const res = await withIdentity(
      request(app).post("/outlets/search")
    ).send({ query: "tech" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
  });
});

// ========================
// Internal
// ========================
describe("GET /internal/outlets/by-ids", () => {
  it("returns outlets by IDs", async () => {
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

    const res = await withIdentity(
      request(app).get("/internal/outlets/by-ids")
    ).query({ ids: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
  });

  it("returns 400 without ids", async () => {
    const res = await withIdentity(
      request(app).get("/internal/outlets/by-ids")
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /internal/outlets/by-campaign/:campaignId", () => {
  it("returns campaign outlets sorted by relevance", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          brand_id: BRAND_ID,
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

    const res = await withIdentity(
      request(app).get(`/internal/outlets/by-campaign/${CAMPAIGN_ID}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
    expect(res.body.outlets[0].brandId).toBe(BRAND_ID);
    expect(res.body.outlets[0].relevanceScore).toBe(85);
  });
});

// ========================
// Identity headers
// ========================
describe("Identity headers", () => {
  it("returns 400 without identity headers", async () => {
    const res = await request(app).get("/outlets");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});
