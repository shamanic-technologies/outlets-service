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

// Mock runs service
const mockCreateChildRun = vi.fn();
const mockCloseRun = vi.fn();
vi.mock("../services/runs", () => ({
  createChildRun: (...args: unknown[]) => mockCreateChildRun(...args),
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
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
const CHILD_RUN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
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

const queryResponse = {
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

const searchResponse = {
  results: [
    { query: "HR tech publications", type: "web", results: [{ title: "HR Tech Weekly", url: "https://hrtechweekly.com", snippet: "HR tech news", domain: "hrtechweekly.com" }] },
    { query: "HR technology news", type: "news", results: [{ title: "TechCrunch HR", url: "https://techcrunch.com/hr", snippet: "TC HR", domain: "techcrunch.com" }] },
    { query: "HR SaaS blogs", type: "web", results: [{ title: "SaaS HR Blog", url: "https://saashrblog.com", snippet: "SaaS blog", domain: "saashrblog.com" }] },
  ],
};

const scoringResponse = {
  content: "",
  json: {
    outlets: [
      { name: "HR Tech Weekly", url: "https://hrtechweekly.com", domain: "hrtechweekly.com", relevanceScore: 92, whyRelevant: "Perfect fit", whyNotRelevant: "Small reach", overallRelevance: "high" },
      { name: "TechCrunch", url: "https://techcrunch.com", domain: "techcrunch.com", relevanceScore: 75, whyRelevant: "Big tech pub", whyNotRelevant: "Not HR-specific", overallRelevance: "medium" },
    ],
  },
  tokensInput: 400,
  tokensOutput: 200,
  model: "claude-sonnet-4-6",
};

function setupDiscoverMocks() {
  mockGetBrand.mockResolvedValue(brandResponse);
  mockExtractFields.mockResolvedValue(extractFieldsResponse);
  mockGetFeatureInputs.mockResolvedValue(null);
  mockChatComplete
    .mockResolvedValueOnce(queryResponse)
    .mockResolvedValueOnce(scoringResponse);
  mockSearchBatch.mockResolvedValueOnce(searchResponse);
}

function setupDbInsertMocks(outletCount: number) {
  mockQuery.mockResolvedValueOnce({}); // BEGIN
  for (let i = 0; i < outletCount; i++) {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: `${OUTLET_ID.slice(0, -1)}${i}` }] }); // INSERT outlet
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT campaign_outlet
  }
  mockQuery.mockResolvedValueOnce({}); // COMMIT
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
  mockCloseRun.mockResolvedValue(undefined);
  app = createApp();
});

describe("POST /outlets/discover", () => {
  it("creates a child run, discovers outlets, closes run as completed", async () => {
    setupDiscoverMocks();
    setupDbInsertMocks(2);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(CHILD_RUN_ID);
    expect(res.body.discovered).toBe(2);

    // Verify child run was created
    expect(mockCreateChildRun).toHaveBeenCalledWith("discover", expect.objectContaining({ orgId: ORG_ID, runId: RUN_ID }));
    // Verify run was closed as completed
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("uses default count of 15 when not specified", async () => {
    setupDiscoverMocks();
    setupDbInsertMocks(2);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(2);
  });

  it("closes run as failed on error", async () => {
    mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
    mockGetBrand.mockRejectedValueOnce(new Error("brand-service failed (503): down"));

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(502);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "failed", expect.anything());
  });

  it("returns 400 when x-campaign-id is missing", async () => {
    const res = await request(app)
      .post("/outlets/discover")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-brand-id", BRAND_ID)
      .send({ count: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
  });

  it("returns 400 when x-brand-id is missing", async () => {
    const res = await request(app)
      .post("/outlets/discover")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", CAMPAIGN_ID)
      .send({ count: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-brand-id");
  });

  it("returns 400 for count > 200", async () => {
    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 201 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 for count < 1", async () => {
    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("stops batching when a batch returns 0 discovered", async () => {
    // First batch: LLM returns invalid format → 0 discovered
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
      request(app).post("/outlets/discover")
    ).send({ count: 50 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(0);
    // Only 1 LLM call — stopped after first batch returned 0
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("passes the child run ID to the inserted campaign_outlets", async () => {
    setupDiscoverMocks();
    setupDbInsertMocks(2);

    await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 10 });

    // Find the campaign_outlet INSERT calls (they contain 'campaign_outlets')
    const campaignOutletInserts = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INTO campaign_outlets")
    );
    expect(campaignOutletInserts.length).toBe(2);
    // The run_id parameter (last param, $11) should be the child run ID
    for (const call of campaignOutletInserts) {
      const params = call[1] as unknown[];
      expect(params[params.length - 1]).toBe(CHILD_RUN_ID);
    }
  });

  it("runs multiple batches for large count", async () => {
    // count=30 → 2 batches of 15
    // Batch 1: discovers 2 outlets
    mockGetBrand.mockResolvedValue(brandResponse);
    mockExtractFields.mockResolvedValue(extractFieldsResponse);
    mockGetFeatureInputs.mockResolvedValue(null);
    mockChatComplete
      .mockResolvedValueOnce(queryResponse)
      .mockResolvedValueOnce(scoringResponse);
    mockSearchBatch.mockResolvedValueOnce(searchResponse);
    setupDbInsertMocks(2);

    // Batch 2: discovers 2 more outlets
    mockChatComplete
      .mockResolvedValueOnce(queryResponse)
      .mockResolvedValueOnce(scoringResponse);
    mockSearchBatch.mockResolvedValueOnce(searchResponse);
    // Need new DB mocks for batch 2
    mockQuery.mockResolvedValueOnce({}); // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "33333333-3333-3333-3333-333333333333" }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "44444444-4444-4444-4444-444444444444" }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 30 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(4); // 2 + 2
    // 4 LLM calls: 2 batches × (query gen + scoring)
    expect(mockChatComplete).toHaveBeenCalledTimes(4);
    expect(mockSearchBatch).toHaveBeenCalledTimes(2);
  });
});
