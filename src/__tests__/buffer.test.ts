import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Mock DB pool
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

// Mock chat service
const mockChatComplete = vi.fn();
vi.mock("../services/chat", () => ({
  chatComplete: (...args: unknown[]) => mockChatComplete(...args),
}));

// Mock google service
const mockSearchBatch = vi.fn();
vi.mock("../services/google", () => ({
  searchBatch: (...args: unknown[]) => mockSearchBatch(...args),
}));

// Mock brand service
const mockExtractFields = vi.fn();
vi.mock("../services/brand", async () => {
  const actual = await vi.importActual("../services/brand");
  return {
    ...actual,
    extractFields: (...args: unknown[]) => mockExtractFields(...args),
  };
});

// Mock campaign service
const mockGetFeatureInputs = vi.fn();
vi.mock("../services/campaign", () => ({
  getFeatureInputs: (...args: unknown[]) => mockGetFeatureInputs(...args),
}));

// Mock journalists service
const mockIsOutletBlocked = vi.fn();
vi.mock("../services/journalists", () => ({
  isOutletBlocked: (...args: unknown[]) => mockIsOutletBlocked(...args),
}));

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";
const OUTLET_ID = "11111111-1111-1111-1111-111111111111";

const FEATURE_SLUG = "outlets";
const WORKFLOW_SLUG = "discover";

function withHeaders(req: request.Test): request.Test {
  return req
    .set("x-org-id", ORG_ID)
    .set("x-user-id", USER_ID)
    .set("x-run-id", RUN_ID)
    .set("x-campaign-id", CAMPAIGN_ID)
    .set("x-brand-id", BRAND_ID)
    .set("x-feature-slug", FEATURE_SLUG)
    .set("x-workflow-slug", WORKFLOW_SLUG);
}

function makeOutletRow(overrides: Record<string, unknown> = {}) {
  return {
    outlet_id: OUTLET_ID,
    outlet_name: "HR Tech Weekly",
    outlet_url: "https://hrtechweekly.com",
    outlet_domain: "hrtechweekly.com",
    campaign_id: CAMPAIGN_ID,
    brand_ids: [BRAND_ID],
    relevance_score: "92.00",
    why_relevant: "Perfect fit",
    why_not_relevant: "Small reach",
    overall_relevance: "high",
    ...overrides,
  };
}

// --- Mini-discover fixtures ---
const extractFieldsResponse = {
  brand_name: { value: "Acme Corp", byBrand: { "acme.com": { value: "Acme Corp", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: ["https://acme.com"] } } },
  elevator_pitch: { value: "SaaS platform for HR automation", byBrand: { "acme.com": { value: "SaaS platform for HR automation", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: ["https://acme.com"] } } },
  categories: { value: "HR Tech", byBrand: { "acme.com": { value: "HR Tech", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: ["https://acme.com"] } } },
  target_geo: { value: "US", byBrand: { "acme.com": { value: "US", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null } } },
  target_audience: { value: "HR directors", byBrand: { "acme.com": { value: "HR directors", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null } } },
  angles: { value: null, byBrand: { "acme.com": { value: null, cached: false, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null } } },
};

const miniDiscoverQueryResponse = {
  content: "",
  json: {
    queries: [
      { query: "HR tech publications", type: "web", rationale: "Find HR outlets" },
      { query: "HR technology news", type: "news", rationale: "Find news outlets" },
      { query: "HR SaaS blogs", type: "web", rationale: "Niche outlets" },
    ],
  },
  tokensInput: 150,
  tokensOutput: 100,
  model: "claude-sonnet-4-6",
};

const miniDiscoverSearchResponse = {
  results: [
    {
      query: "HR tech publications",
      type: "web",
      results: [
        { title: "HR Tech Weekly", url: "https://hrtechweekly.com", snippet: "HR tech news", domain: "hrtechweekly.com" },
      ],
    },
    {
      query: "HR technology news",
      type: "news",
      results: [
        { title: "TechCrunch HR", url: "https://techcrunch.com/hr", snippet: "TC HR coverage", domain: "techcrunch.com" },
      ],
    },
    {
      query: "HR SaaS blogs",
      type: "web",
      results: [
        { title: "SaaS HR Blog", url: "https://saashrblog.com", snippet: "SaaS blog", domain: "saashrblog.com" },
      ],
    },
  ],
};

const miniDiscoverScoringResponse = {
  content: "",
  json: {
    outlets: [
      {
        name: "HR Tech Weekly",
        url: "https://hrtechweekly.com",
        domain: "hrtechweekly.com",
        relevanceScore: 92,
        whyRelevant: "Perfect fit",
        whyNotRelevant: "Small reach",
        overallRelevance: "high",
      },
      {
        name: "TechCrunch",
        url: "https://techcrunch.com",
        domain: "techcrunch.com",
        relevanceScore: 75,
        whyRelevant: "Big tech pub",
        whyNotRelevant: "Not HR-specific",
        overallRelevance: "medium",
      },
    ],
  },
  tokensInput: 400,
  tokensOutput: 200,
  model: "claude-sonnet-4-6",
};

function setupMiniDiscoverMocks() {
  mockExtractFields.mockResolvedValue(extractFieldsResponse);
  mockGetFeatureInputs.mockResolvedValue(null);
  mockChatComplete
    .mockResolvedValueOnce(miniDiscoverQueryResponse)
    .mockResolvedValueOnce(miniDiscoverScoringResponse);
  mockSearchBatch.mockResolvedValueOnce(miniDiscoverSearchResponse);
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  // Stub Math.random to avoid probabilistic idempotency cleanup in tests
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  app = createApp();
});

describe("POST /buffer/next", () => {
  it("returns one outlet by default (count=1)", async () => {
    // claimNext → found an outlet
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID);
    expect(res.body.outlets[0].outletName).toBe("HR Tech Weekly");
    expect(res.body.outlets[0].relevanceScore).toBe(92);
  });

  it("returns multiple outlets when count > 1", async () => {
    const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

    // claimNext → outlet 1
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });
    // claimNext → outlet 2
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_id: OUTLET_ID_2,
        outlet_name: "TechCrunch",
        outlet_url: "https://techcrunch.com",
        outlet_domain: "techcrunch.com",
        relevance_score: "80.00",
      })],
    });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({ count: 2 });

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(2);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID);
    expect(res.body.outlets[1].outletId).toBe(OUTLET_ID_2);
  });

  it("returns cached response for duplicate idempotencyKey", async () => {
    const cachedResponse = { outlets: [{ outletId: OUTLET_ID, outletName: "Cached Outlet" }] };
    mockQuery.mockResolvedValueOnce({ rows: [{ response: cachedResponse }] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({ idempotencyKey: "already-used-key" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedResponse);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("skips low-relevance outlets (score < 30) and tries the next one", async () => {
    const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

    // claimNext iteration 1 → found outlet with low relevance score
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_name: "Distant Outlet",
        outlet_url: "https://distant.com",
        outlet_domain: "distant.com",
        relevance_score: "15.00",
      })],
    });
    // markSkipped
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // claimNext iteration 2 → found a good outlet
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_id: OUTLET_ID_2,
        outlet_name: "Good Outlet",
        outlet_url: "https://good.com",
        outlet_domain: "good.com",
        relevance_score: "85.00",
      })],
    });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID_2);
    expect(res.body.outlets[0].outletName).toBe("Good Outlet");
    // Should NOT have called journalists-service for the low-score outlet
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(1);
  });

  it("skips blocked outlets and tries the next one", async () => {
    const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

    // claimNext iteration 1 → found outlet that is blocked
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_name: "Blocked Outlet",
        outlet_url: "https://blocked.com",
        outlet_domain: "blocked.com",
        relevance_score: "90.00",
      })],
    });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true, reason: "journalist replied negatively" });
    // markSkipped
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // claimNext iteration 2 → found a good outlet
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_id: OUTLET_ID_2,
        outlet_name: "Good Outlet",
        outlet_url: "https://good.com",
        outlet_domain: "good.com",
        relevance_score: "85.00",
        why_relevant: "Great fit",
      })],
    });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID_2);
    expect(res.body.outlets[0].outletName).toBe("Good Outlet");
  });

  it("skips outlet from local cache without calling journalists-service", async () => {
    const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

    // claimNext iteration 1 → found outlet with existing skip cache
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_name: "Cached Blocked",
        outlet_url: "https://cached.com",
        outlet_domain: "cached.com",
      })],
    });
    // block cache check → HIT (skipped within 30 days)
    mockQuery.mockResolvedValueOnce({ rows: [{ "1": 1 }] });
    // markSkipped
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // claimNext iteration 2 → good outlet
    mockQuery.mockResolvedValueOnce({
      rows: [makeOutletRow({
        outlet_id: OUTLET_ID_2,
        outlet_name: "Good Outlet",
        outlet_url: "https://good.com",
        outlet_domain: "good.com",
      })],
    });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID_2);
    // journalists-service should only be called once (for the second outlet), not for the cached one
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(1);
  });

  it("triggers mini-discover when buffer is empty, then returns top outlet", async () => {
    // claimNext iteration 1 → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover mocks
    setupMiniDiscoverMocks();

    // mini-discover DB: BEGIN, (INSERT outlet + INSERT campaign_outlet) x2, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: OUTLET_ID }] }) // INSERT outlet 1
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlet 1
      .mockResolvedValueOnce({ rows: [{ id: "22222222-2222-2222-2222-222222222222" }] }) // INSERT outlet 2
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlet 2
      .mockResolvedValueOnce({}); // COMMIT

    // claimNext iteration 2 (after refill) → found outlet
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletName).toBe("HR Tech Weekly");

    // Verify mini-discover was triggered
    expect(mockChatComplete).toHaveBeenCalledTimes(2); // query gen + scoring
    expect(mockSearchBatch).toHaveBeenCalledTimes(1);
    // Verify mini-discover uses small query count (3 queries × 5 results)
    const searchCall = mockSearchBatch.mock.calls[0][0];
    expect(searchCall.queries.length).toBeLessThanOrEqual(3);
    expect(searchCall.queries[0].num).toBe(5);
  });

  it("returns empty outlets array when mini-discover finds nothing", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover mocks → scoring returns empty outlets
    mockExtractFields.mockResolvedValue(extractFieldsResponse);
    mockGetFeatureInputs.mockResolvedValue(null);
    mockChatComplete
      .mockResolvedValueOnce(miniDiscoverQueryResponse)
      .mockResolvedValueOnce({
        content: "",
        json: { outlets: [] },
        tokensInput: 100,
        tokensOutput: 20,
        model: "claude-sonnet-4-6",
      });
    mockSearchBatch.mockResolvedValueOnce(miniDiscoverSearchResponse);

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(0);
  });

  it("returns partial results when buffer runs dry mid-collection", async () => {
    // claimNext → outlet 1
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover mocks → finds nothing
    mockExtractFields.mockResolvedValue(extractFieldsResponse);
    mockGetFeatureInputs.mockResolvedValue(null);
    mockChatComplete
      .mockResolvedValueOnce(miniDiscoverQueryResponse)
      .mockResolvedValueOnce({
        content: "",
        json: { outlets: [] },
        tokensInput: 100,
        tokensOutput: 20,
        model: "claude-sonnet-4-6",
      });
    mockSearchBatch.mockResolvedValueOnce(miniDiscoverSearchResponse);

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({ count: 5 });

    expect(res.status).toBe(200);
    // Got 1 out of 5 requested — partial result
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].outletId).toBe(OUTLET_ID);
  });

  it("returns 400 listing all missing identity headers", async () => {
    const res = await request(app)
      .post("/buffer/next")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
    expect(res.body.error).toContain("x-brand-id");
    expect(res.body.error).toContain("x-feature-slug");
    expect(res.body.error).toContain("x-workflow-slug");
  });

  it("returns 400 when no headers are sent", async () => {
    const res = await request(app)
      .post("/buffer/next")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
    expect(res.body.error).toContain("x-user-id");
    expect(res.body.error).toContain("x-run-id");
  });

  it("returns 502 when brand-service is down during mini-discover", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockExtractFields.mockRejectedValueOnce(
      new Error("brand-service /brands/extract-fields failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("brand-service");
  });

  it("works without idempotencyKey", async () => {
    // claimNext → found outlet
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    // No idempotency cache save
    expect(mockQuery).toHaveBeenCalledTimes(2); // claim + block cache check only
  });

  it("passes provider and model to chatComplete calls", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover mocks
    setupMiniDiscoverMocks();

    // mini-discover DB: BEGIN, (INSERT outlet + INSERT campaign_outlet) x2, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: OUTLET_ID }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "22222222-2222-2222-2222-222222222222" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT

    // claimNext iteration 2 → found outlet
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    // block cache check → no cache hit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // journalists-service → not blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    // Both chatComplete calls (query gen + scoring) must include provider and model
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    for (const call of mockChatComplete.mock.calls) {
      expect(call[0]).toMatchObject({ provider: "google", model: "flash-lite" });
    }

    // Scoring call (2nd) must include thinkingBudget
    const scoringCall = mockChatComplete.mock.calls[1][0];
    expect(scoringCall).toMatchObject({ thinkingBudget: 8000, maxTokens: 16000 });

    // Query gen call (1st) must NOT include thinkingBudget
    const queryGenCall = mockChatComplete.mock.calls[0][0];
    expect(queryGenCall.thinkingBudget).toBeUndefined();
  });

  it("does not refill twice if first refill was empty", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover → LLM returns invalid format
    mockExtractFields.mockResolvedValue(extractFieldsResponse);
    mockGetFeatureInputs.mockResolvedValue(null);
    mockChatComplete.mockResolvedValueOnce({
      content: "bad",
      json: { invalid: true },
      tokensInput: 50,
      tokensOutput: 20,
      model: "claude-sonnet-4-6",
    });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(0);
    // Should only have called LLM once (query gen), not retry
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
  });
});
