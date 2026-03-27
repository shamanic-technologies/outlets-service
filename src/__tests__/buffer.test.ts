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
const mockGetBrand = vi.fn();
const mockExtractFields = vi.fn();
vi.mock("../services/brand", async () => {
  const actual = await vi.importActual("../services/brand");
  return {
    ...actual,
    getBrand: (...args: unknown[]) => mockGetBrand(...args),
    extractFields: (...args: unknown[]) => mockExtractFields(...args),
  };
});

// Mock campaign service
const mockGetFeatureInputs = vi.fn();
vi.mock("../services/campaign", () => ({
  getFeatureInputs: (...args: unknown[]) => mockGetFeatureInputs(...args),
}));

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";
const OUTLET_ID = "11111111-1111-1111-1111-111111111111";

function withHeaders(req: request.Test): request.Test {
  return req
    .set("x-org-id", ORG_ID)
    .set("x-user-id", USER_ID)
    .set("x-run-id", RUN_ID)
    .set("x-campaign-id", CAMPAIGN_ID)
    .set("x-brand-id", BRAND_ID);
}

// --- Mini-discover fixtures ---
const brandResponse = {
  id: BRAND_ID,
  name: "Acme Corp",
  domain: "acme.com",
  brandUrl: "https://acme.com",
  elevatorPitch: null,
  bio: null,
  mission: null,
  location: null,
  categories: null,
};

const extractFieldsResponse = [
  { key: "elevator_pitch", value: "SaaS platform for HR automation", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: ["https://acme.com"] },
  { key: "categories", value: "HR Tech", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: ["https://acme.com"] },
  { key: "target_geo", value: "US", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null },
  { key: "target_audience", value: "HR directors", cached: true, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null },
  { key: "angles", value: null, cached: false, extractedAt: "2026-03-01T00:00:00Z", expiresAt: null, sourceUrls: null },
];

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
  mockGetBrand.mockResolvedValue(brandResponse);
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
  it("returns the top outlet from the buffer", async () => {
    // idempotency check → no cache
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // claimNext → found an outlet
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID,
          outlet_name: "HR Tech Weekly",
          outlet_url: "https://hrtechweekly.com",
          outlet_domain: "hrtechweekly.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
          relevance_score: "92.00",
          why_relevant: "Perfect fit",
          why_not_relevant: "Small reach",
          overall_relevance: "high",
        },
      ],
    });
    // dedup check → not a duplicate
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // save idempotency cache
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({ idempotencyKey: "test-key-1" });

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.outlet.outletId).toBe(OUTLET_ID);
    expect(res.body.outlet.outletName).toBe("HR Tech Weekly");
    expect(res.body.outlet.relevanceScore).toBe(92);
    expect(res.body.outlet.campaignId).toBe(CAMPAIGN_ID);
  });

  it("returns cached response for duplicate idempotencyKey", async () => {
    const cachedResponse = { found: true, outlet: { outletId: OUTLET_ID, outletName: "Cached Outlet" } };
    mockQuery.mockResolvedValueOnce({ rows: [{ response: cachedResponse }] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({ idempotencyKey: "already-used-key" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedResponse);
    // Should NOT attempt to claim
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate outlets and tries the next one", async () => {
    // no idempotency key, so no cache check

    // claimNext iteration 1 → found outlet that is a cross-campaign dup
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID,
          outlet_name: "Dup Outlet",
          outlet_url: "https://dup.com",
          outlet_domain: "dup.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
          relevance_score: "90.00",
          why_relevant: "Good",
          why_not_relevant: "None",
          overall_relevance: "high",
        },
      ],
    });
    // dedup check → IS a duplicate
    mockQuery.mockResolvedValueOnce({ rows: [{ "1": 1 }] });
    // markSkipped
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // claimNext iteration 2 → found a good outlet
    const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID_2,
          outlet_name: "Good Outlet",
          outlet_url: "https://good.com",
          outlet_domain: "good.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
          relevance_score: "85.00",
          why_relevant: "Great fit",
          why_not_relevant: "None",
          overall_relevance: "high",
        },
      ],
    });
    // dedup check → not a dup
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.outlet.outletId).toBe(OUTLET_ID_2);
    expect(res.body.outlet.outletName).toBe("Good Outlet");
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
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID,
          outlet_name: "HR Tech Weekly",
          outlet_url: "https://hrtechweekly.com",
          outlet_domain: "hrtechweekly.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
          relevance_score: "92.00",
          why_relevant: "Perfect fit",
          why_not_relevant: "Small reach",
          overall_relevance: "high",
        },
      ],
    });
    // dedup check → not a dup
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.outlet.outletName).toBe("HR Tech Weekly");

    // Verify mini-discover was triggered
    expect(mockChatComplete).toHaveBeenCalledTimes(2); // query gen + scoring
    expect(mockSearchBatch).toHaveBeenCalledTimes(1);
    // Verify mini-discover uses small query count (3 queries × 5 results)
    const searchCall = mockSearchBatch.mock.calls[0][0];
    expect(searchCall.queries.length).toBeLessThanOrEqual(3);
    expect(searchCall.queries[0].num).toBe(5);
  });

  it("returns { found: false } when mini-discover finds nothing", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover mocks → scoring returns empty outlets
    mockGetBrand.mockResolvedValue(brandResponse);
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
    expect(res.body.found).toBe(false);
    expect(res.body.outlet).toBeUndefined();
  });

  it("returns 400 when x-campaign-id header is missing", async () => {
    const res = await request(app)
      .post("/buffer/next")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-brand-id", BRAND_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
  });

  it("returns 400 when x-brand-id header is missing", async () => {
    const res = await request(app)
      .post("/buffer/next")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", CAMPAIGN_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-brand-id");
  });

  it("returns 502 when brand-service is down during mini-discover", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockGetBrand.mockRejectedValueOnce(
      new Error("brand-service /brands/55555555-5555-5555-5555-555555555555 failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("brand-service");
  });

  it("works without idempotencyKey", async () => {
    // claimNext → found outlet
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID,
          outlet_name: "Test Outlet",
          outlet_url: "https://test.com",
          outlet_domain: "test.com",
          campaign_id: CAMPAIGN_ID,
          brand_id: BRAND_ID,
          relevance_score: "80.00",
          why_relevant: "Good",
          why_not_relevant: "None",
          overall_relevance: "medium",
        },
      ],
    });
    // dedup check → not a dup
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    // No idempotency cache save
    expect(mockQuery).toHaveBeenCalledTimes(2); // claim + dedup only
  });

  it("does not refill twice if first refill was empty", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // mini-discover → LLM returns invalid format
    mockGetBrand.mockResolvedValue(brandResponse);
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
    expect(res.body.found).toBe(false);
    // Should only have called LLM once (query gen), not retry
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
  });
});
