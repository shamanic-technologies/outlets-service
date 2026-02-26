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
      status: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    // BEGIN, INSERT press_outlets, INSERT campaign_outlets, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT press_outlets
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).post("/outlets").send({
      outletName: "TechCrunch",
      outletUrl: "https://techcrunch.com",
      outletDomain: "techcrunch.com",
      campaignId: "22222222-2222-2222-2222-222222222222",
      whyRelevant: "Top tech publication",
      whyNotRelevant: "Might be too competitive",
      relevanceScore: 85,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(outletRow.id);
    expect(res.body.outletName).toBe("TechCrunch");
    expect(res.body.campaignId).toBe("22222222-2222-2222-2222-222222222222");
    expect(res.body.relevanceScore).toBe(85);
    expect(res.body.outletStatus).toBe("open");
  });

  it("returns 400 for invalid body", async () => {
    const res = await request(app).post("/outlets").send({
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
          status: null,
          campaign_id: "22222222-2222-2222-2222-222222222222",
          why_relevant: "Top tech",
          why_not_relevant: "Competitive",
          relevance_score: "85.00",
          outlet_status: "open",
          overal_relevance: null,
          relevance_rationale: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/outlets").query({
      campaignId: "22222222-2222-2222-2222-222222222222",
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
    expect(res.body.outlets[0].relevanceScore).toBe(85);
  });

  it("lists outlets without filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/outlets");
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
          status: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get(
      "/outlets/11111111-1111-1111-1111-111111111111"
    );
    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("TechCrunch");
  });

  it("returns 404 for missing outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(
      "/outlets/99999999-9999-9999-9999-999999999999"
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
          status: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .patch("/outlets/11111111-1111-1111-1111-111111111111")
      .send({ outletName: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.outletName).toBe("Updated Name");
  });

  it("returns 404 when outlet not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch("/outlets/99999999-9999-9999-9999-999999999999")
      .send({ outletName: "X" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /outlets/:id/status", () => {
  it("updates outlet status with campaignId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: "11111111-1111-1111-1111-111111111111",
          campaign_id: "22222222-2222-2222-2222-222222222222",
          status: "ended",
          relevance_rationale: "No longer relevant",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .patch("/outlets/11111111-1111-1111-1111-111111111111/status")
      .query({ campaignId: "22222222-2222-2222-2222-222222222222" })
      .send({ status: "ended", reason: "No longer relevant" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
  });

  it("returns 400 without campaignId", async () => {
    const res = await request(app)
      .patch("/outlets/11111111-1111-1111-1111-111111111111/status")
      .send({ status: "ended" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("campaignId");
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

    const res = await request(app)
      .post("/outlets/bulk")
      .send({
        outlets: [
          {
            outletName: "Outlet1",
            outletUrl: "https://outlet1.com",
            outletDomain: "outlet1.com",
            campaignId: "33333333-3333-3333-3333-333333333333",
            whyRelevant: "Good",
            whyNotRelevant: "None",
            relevanceScore: 90,
          },
          {
            outletName: "Outlet2",
            outletUrl: "https://outlet2.com",
            outletDomain: "outlet2.com",
            campaignId: "33333333-3333-3333-3333-333333333333",
            whyRelevant: "Also good",
            whyNotRelevant: "None",
            relevanceScore: 80,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.outlets).toHaveLength(2);
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
          status: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/outlets/search")
      .send({ query: "tech" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("TechCrunch");
  });
});

// ========================
// Categories
// ========================
describe("POST /categories", () => {
  it("creates a category", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          campaign_id: "22222222-2222-2222-2222-222222222222",
          category_name: "Tech News",
          scope: "international",
          region: null,
          example_outlets: "TechCrunch, Wired",
          why_relevant: "Core topic",
          why_not_relevant: "",
          relevance_score: "95.00",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).post("/categories").send({
      campaignId: "22222222-2222-2222-2222-222222222222",
      categoryName: "Tech News",
      scope: "international",
      exampleOutlets: "TechCrunch, Wired",
      whyRelevant: "Core topic",
      relevanceScore: 95,
    });

    expect(res.status).toBe(201);
    expect(res.body.categoryName).toBe("Tech News");
    expect(res.body.relevanceScore).toBe(95);
  });
});

describe("GET /categories", () => {
  it("lists categories by campaign", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          campaign_id: "22222222-2222-2222-2222-222222222222",
          category_name: "Tech News",
          scope: "international",
          region: null,
          example_outlets: null,
          why_relevant: "",
          why_not_relevant: "",
          relevance_score: "90.00",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get("/categories").query({
      campaignId: "22222222-2222-2222-2222-222222222222",
    });

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
  });

  it("returns 400 without campaignId", async () => {
    const res = await request(app).get("/categories");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /categories/:id", () => {
  it("updates a category", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          campaign_id: "22222222-2222-2222-2222-222222222222",
          category_name: "Updated Tech",
          scope: "international",
          region: null,
          example_outlets: null,
          why_relevant: "",
          why_not_relevant: "",
          relevance_score: "90.00",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .patch("/categories/44444444-4444-4444-4444-444444444444")
      .send({ categoryName: "Updated Tech" });

    expect(res.status).toBe(200);
    expect(res.body.categoryName).toBe("Updated Tech");
  });

  it("returns 400 with empty body", async () => {
    const res = await request(app)
      .patch("/categories/44444444-4444-4444-4444-444444444444")
      .send({});
    expect(res.status).toBe(400);
  });
});

// ========================
// Views
// ========================
describe("GET /outlets/status", () => {
  it("returns outlet targeting readiness", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          campaign_id: "22222222-2222-2222-2222-222222222222",
          outlet_id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          relevance_score: "85.00",
          why_relevant: "Top tech",
          why_not_relevant: "",
          outlet_status: "open",
          overal_relevance: null,
          relevance_rationale: null,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get("/outlets/status").query({
      campaignId: "22222222-2222-2222-2222-222222222222",
    });

    expect(res.status).toBe(200);
    expect(res.body.outlets[0].outletStatus).toBe("open");
  });
});

describe("GET /outlets/has-topics-articles", () => {
  it("returns outlets list", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get("/outlets/has-topics-articles");
    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
  });
});

describe("GET /outlets/has-recent-articles", () => {
  it("returns outlets list", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/outlets/has-recent-articles");
    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([]);
  });
});

describe("GET /outlets/has-journalists", () => {
  it("returns outlets list", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/outlets/has-journalists");
    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([]);
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
          status: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .get("/internal/outlets/by-ids")
      .query({ ids: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
  });

  it("returns 400 without ids", async () => {
    const res = await request(app).get("/internal/outlets/by-ids");
    expect(res.status).toBe(400);
  });
});

describe("GET /internal/outlets/by-campaign/:campaignId", () => {
  it("returns campaign outlets", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          outlet_name: "TechCrunch",
          outlet_url: "https://techcrunch.com",
          outlet_domain: "techcrunch.com",
          status: null,
          why_relevant: "Top tech",
          why_not_relevant: "",
          relevance_score: "85.00",
          outlet_status: "open",
          overal_relevance: null,
          relevance_rationale: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get(
      "/internal/outlets/by-campaign/22222222-2222-2222-2222-222222222222"
    );

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].campaignId).toBe(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(res.body.outlets[0].relevanceScore).toBe(85);
  });
});

// ========================
// Auth middleware
// ========================
describe("API key auth", () => {
  it("allows health check without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

// ========================
// Org context headers
// ========================
describe("Org context headers", () => {
  it("accepts requests with x-org-id and x-user-id headers", async () => {
    const outletRow = {
      id: "11111111-1111-1111-1111-111111111111",
      outlet_name: "TechCrunch",
      outlet_url: "https://techcrunch.com",
      outlet_domain: "techcrunch.com",
      status: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT press_outlets
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .post("/outlets")
      .set("x-org-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
      .set("x-user-id", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
      .send({
        outletName: "TechCrunch",
        outletUrl: "https://techcrunch.com",
        outletDomain: "techcrunch.com",
        campaignId: "22222222-2222-2222-2222-222222222222",
        whyRelevant: "Top tech publication",
        whyNotRelevant: "Might be too competitive",
        relevanceScore: 85,
      });

    expect(res.status).toBe(201);
    expect(res.body.outletName).toBe("TechCrunch");
  });

  it("works without org context headers", async () => {
    const outletRow = {
      id: "11111111-1111-1111-1111-111111111111",
      outlet_name: "Wired",
      outlet_url: "https://wired.com",
      outlet_domain: "wired.com",
      status: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [outletRow] }) // INSERT press_outlets
      .mockResolvedValueOnce({ rows: [] }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).post("/outlets").send({
      outletName: "Wired",
      outletUrl: "https://wired.com",
      outletDomain: "wired.com",
      campaignId: "22222222-2222-2222-2222-222222222222",
      whyRelevant: "Tech coverage",
      whyNotRelevant: "None",
      relevanceScore: 80,
    });

    expect(res.status).toBe(201);
    expect(res.body.outletName).toBe("Wired");
  });

  it("exposes org context on the request object", async () => {
    // Use the health endpoint - we'll verify by checking the middleware runs without error
    const res = await request(app)
      .get("/health")
      .set("x-org-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
      .set("x-user-id", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    expect(res.status).toBe(200);
  });
});

// ========================
// Validation
// ========================
describe("Validation", () => {
  it("rejects invalid outlet URL", async () => {
    const res = await request(app).post("/outlets").send({
      outletName: "Test",
      outletUrl: "not-a-url",
      outletDomain: "test.com",
      campaignId: "22222222-2222-2222-2222-222222222222",
      whyRelevant: "Test",
      whyNotRelevant: "Test",
      relevanceScore: 50,
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid campaign ID", async () => {
    const res = await request(app).post("/outlets").send({
      outletName: "Test",
      outletUrl: "https://test.com",
      outletDomain: "test.com",
      campaignId: "not-a-uuid",
      whyRelevant: "Test",
      whyNotRelevant: "Test",
      relevanceScore: 50,
    });
    expect(res.status).toBe(400);
  });

  it("rejects relevance score out of range", async () => {
    const res = await request(app).post("/outlets").send({
      outletName: "Test",
      outletUrl: "https://test.com",
      outletDomain: "test.com",
      campaignId: "22222222-2222-2222-2222-222222222222",
      whyRelevant: "Test",
      whyNotRelevant: "Test",
      relevanceScore: 150,
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid status enum", async () => {
    const res = await request(app)
      .patch("/outlets/11111111-1111-1111-1111-111111111111/status")
      .query({ campaignId: "22222222-2222-2222-2222-222222222222" })
      .send({ status: "invalid" });
    expect(res.status).toBe(400);
  });
});
