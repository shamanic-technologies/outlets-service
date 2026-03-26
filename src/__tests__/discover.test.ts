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

const featureInputsResponse = { customAngle: "AI in HR", targetRegion: "Europe" };

const llmQueriesResponse = {
  content: "",
  json: {
    queries: [
      { query: "best HR tech publications", type: "web", rationale: "Find HR tech outlets" },
      { query: "HR technology news 2026", type: "news", rationale: "Find news outlets covering HR" },
    ],
  },
  tokensInput: 200,
  tokensOutput: 150,
  model: "claude-sonnet-4-6",
};

const googleBatchResponse = {
  results: [
    {
      query: "best HR tech publications",
      type: "web",
      results: [
        {
          title: "HR Tech Weekly - The Leading HR Technology Publication",
          url: "https://hrtechweekly.com",
          snippet: "Your source for HR technology news and analysis",
          domain: "hrtechweekly.com",
        },
        {
          title: "People Management - CIPD",
          url: "https://peoplemanagement.co.uk",
          snippet: "HR news, features and analysis from CIPD",
          domain: "peoplemanagement.co.uk",
        },
      ],
    },
    {
      query: "HR technology news 2026",
      type: "news",
      results: [
        {
          title: "HR Tech Startup Raises $50M",
          url: "https://techcrunch.com/2026/03/hr-startup",
          snippet: "TechCrunch article about HR startup funding",
          domain: "techcrunch.com",
        },
      ],
    },
  ],
};

const llmScoringResponse = {
  content: "",
  json: {
    outlets: [
      {
        name: "HR Tech Weekly",
        url: "https://hrtechweekly.com",
        domain: "hrtechweekly.com",
        relevanceScore: 92,
        whyRelevant: "Dedicated HR tech publication, perfect audience match",
        whyNotRelevant: "Smaller reach than mainstream tech press",
        overallRelevance: "high",
      },
      {
        name: "TechCrunch",
        url: "https://techcrunch.com",
        domain: "techcrunch.com",
        relevanceScore: 75,
        whyRelevant: "Top tech publication, covers SaaS and funding rounds",
        whyNotRelevant: "Not HR-specific, very competitive",
        overallRelevance: "medium",
      },
    ],
  },
  tokensInput: 800,
  tokensOutput: 400,
  model: "claude-sonnet-4-6",
};

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockGetBrand.mockResolvedValue(brandResponse);
  mockExtractFields.mockResolvedValue(extractFieldsResponse);
  mockGetFeatureInputs.mockResolvedValue(featureInputsResponse);
  app = createApp();
});

describe("POST /outlets/discover", () => {
  it("discovers outlets end-to-end", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    mockChatComplete.mockResolvedValueOnce(llmScoringResponse);

    // DB: BEGIN, (INSERT outlets + INSERT campaign_outlets) x2, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: "11111111-1111-1111-1111-111111111111", outlet_name: "HR Tech Weekly", outlet_url: "https://hrtechweekly.com", outlet_domain: "hrtechweekly.com" }],
      })
      .mockResolvedValueOnce({ rows: [] }) // campaign_outlets
      .mockResolvedValueOnce({
        rows: [{ id: "22222222-2222-2222-2222-222222222222", outlet_name: "TechCrunch", outlet_url: "https://techcrunch.com", outlet_domain: "techcrunch.com" }],
      })
      .mockResolvedValueOnce({ rows: [] }) // campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(201);
    expect(res.body.discoveredCount).toBe(2);
    expect(res.body.outlets).toHaveLength(2);
    expect(res.body.outlets[0].outletName).toBe("HR Tech Weekly");
    expect(res.body.outlets[0].relevanceScore).toBe(92);
    expect(res.body.outlets[1].outletName).toBe("TechCrunch");
    expect(res.body.searchQueries).toBe(2);
    expect(res.body.tokensUsed).toBeDefined();

    expect(mockGetBrand).toHaveBeenCalledTimes(1);
    expect(mockGetBrand.mock.calls[0][0]).toBe(BRAND_ID);
    expect(mockExtractFields).toHaveBeenCalledTimes(1);
    expect(mockExtractFields.mock.calls[0][0]).toBe(BRAND_ID);
    expect(mockExtractFields.mock.calls[0][1]).toHaveLength(5); // 5 field requests
    expect(mockGetFeatureInputs).toHaveBeenCalledTimes(1);
    expect(mockGetFeatureInputs.mock.calls[0][0]).toBe(CAMPAIGN_ID);
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    expect(mockSearchBatch).toHaveBeenCalledTimes(1);
    expect(mockSearchBatch.mock.calls[0][0].queries).toHaveLength(2);
  });

  it("fetches featureInputs from campaign-service and injects into LLM calls", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({ content: "", json: { outlets: [] }, tokensInput: 100, tokensOutput: 20, model: "claude-sonnet-4-6" });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    // Verify featureInputs from campaign-service are included in the LLM message
    const queryGenMessage = mockChatComplete.mock.calls[0][0].message;
    expect(queryGenMessage).toContain("Additional Context");
    expect(queryGenMessage).toContain("AI in HR");
    expect(queryGenMessage).toContain("Europe");
  });

  it("works when campaign has no featureInputs", async () => {
    mockGetFeatureInputs.mockResolvedValue(null);
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({ content: "", json: { outlets: [] }, tokensInput: 100, tokensOutput: 20, model: "claude-sonnet-4-6" });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    // Should NOT contain "Additional Context" when featureInputs is null
    const queryGenMessage = mockChatComplete.mock.calls[0][0].message;
    expect(queryGenMessage).not.toContain("Additional Context");
  });

  it("calls extract-fields with specific field requests", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({ content: "", json: { outlets: [] }, tokensInput: 100, tokensOutput: 20, model: "claude-sonnet-4-6" });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    // Verify extract-fields is called with specific field descriptors
    const fields = mockExtractFields.mock.calls[0][1];
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "elevator_pitch", description: expect.any(String) }),
        expect.objectContaining({ key: "categories", description: expect.any(String) }),
        expect.objectContaining({ key: "target_geo", description: expect.any(String) }),
        expect.objectContaining({ key: "target_audience", description: expect.any(String) }),
        expect.objectContaining({ key: "angles", description: expect.any(String) }),
      ])
    );
  });

  it("returns 400 when x-campaign-id header is missing", async () => {
    const res = await request(app)
      .post("/outlets/discover")
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
      .post("/outlets/discover")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", CAMPAIGN_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-brand-id");
  });

  it("returns 400 without identity headers", async () => {
    const res = await request(app)
      .post("/outlets/discover")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 502 when brand-service is down", async () => {
    mockGetBrand.mockRejectedValueOnce(
      new Error("brand-service /brands/55555555-5555-5555-5555-555555555555 failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("brand-service");
  });

  it("returns 502 when campaign-service is down", async () => {
    mockGetFeatureInputs.mockRejectedValueOnce(
      new Error("campaign-service /campaigns/dddddddd-dddd-dddd-dddd-dddddddddddd failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("campaign-service");
  });

  it("filters out empty objects from LLM query array", async () => {
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        queries: [
          { query: "HR tech news", type: "web", rationale: "Find HR outlets" },
          {}, // empty object from malformed LLM output
          { query: "HR SaaS funding", type: "news", rationale: "Funding news" },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "claude-sonnet-4-6",
    });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: { outlets: [] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "claude-sonnet-4-6",
    });

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    expect(mockSearchBatch.mock.calls[0][0].queries).toHaveLength(2);
  });

  it("returns 502 when LLM returns invalid query format", async () => {
    mockChatComplete.mockResolvedValueOnce({
      content: "not valid json",
      json: { invalid: "format" },
      tokensInput: 100,
      tokensOutput: 50,
      model: "claude-sonnet-4-6",
    });

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("search queries");
  });

  it("returns 502 when LLM returns invalid scoring format", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({
        content: "bad scoring",
        json: { invalid: "scoring" },
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("score outlets");
  });

  it("returns 502 when chat-service is down", async () => {
    mockChatComplete.mockRejectedValueOnce(
      new Error("chat-service /complete failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("chat-service");
  });

  it("returns 502 when google-service is down", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockRejectedValueOnce(
      new Error("google-service /search/batch failed (503): Service Unavailable")
    );

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("google-service");
  });

  it("returns empty list when no outlets found", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({
        content: "",
        json: { outlets: [] },
        tokensInput: 400,
        tokensOutput: 20,
        model: "claude-sonnet-4-6",
      });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.discoveredCount).toBe(0);
    expect(res.body.outlets).toEqual([]);
  });

  it("forwards all headers to downstream services", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: { outlets: [] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "claude-sonnet-4-6",
    });

    await withHeaders(
      request(app).post("/outlets/discover")
    )
      .set("x-feature-slug", "discover-feature")
      .set("x-workflow-name", "test-workflow")
      .send({});

    // Verify brand-service received full context
    const brandCtx = mockGetBrand.mock.calls[0][1];
    expect(brandCtx.orgId).toBe(ORG_ID);
    expect(brandCtx.campaignId).toBe(CAMPAIGN_ID);
    expect(brandCtx.brandId).toBe(BRAND_ID);
    expect(brandCtx.workflowName).toBe("test-workflow");

    // Verify extract-fields received full context
    const extractCtx = mockExtractFields.mock.calls[0][2];
    expect(extractCtx.orgId).toBe(ORG_ID);
    expect(extractCtx.campaignId).toBe(CAMPAIGN_ID);
    expect(extractCtx.brandId).toBe(BRAND_ID);

    // Verify campaign-service received full context
    const campaignCtx = mockGetFeatureInputs.mock.calls[0][1];
    expect(campaignCtx.orgId).toBe(ORG_ID);
    expect(campaignCtx.campaignId).toBe(CAMPAIGN_ID);

    // Verify chat-service received full context
    const chatCtx = mockChatComplete.mock.calls[0][1];
    expect(chatCtx.orgId).toBe(ORG_ID);
    expect(chatCtx.campaignId).toBe(CAMPAIGN_ID);
    expect(chatCtx.brandId).toBe(BRAND_ID);
    expect(chatCtx.featureSlug).toBe("discover-feature");
    expect(chatCtx.workflowName).toBe("test-workflow");

    // Verify google-service received full context
    const googleCtx = mockSearchBatch.mock.calls[0][1];
    expect(googleCtx.campaignId).toBe(CAMPAIGN_ID);
    expect(googleCtx.brandId).toBe(BRAND_ID);
    expect(googleCtx.workflowName).toBe("test-workflow");
  });

  it("uses brand-service data for prompts, not body fields", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse)
      .mockResolvedValueOnce({ content: "", json: { outlets: [] }, tokensInput: 100, tokensOutput: 20, model: "claude-sonnet-4-6" });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    // Verify the query generation message uses brand-service data
    const queryGenMessage = mockChatComplete.mock.calls[0][0].message;
    expect(queryGenMessage).toContain("Acme Corp"); // from brand.name
    expect(queryGenMessage).toContain("SaaS platform for HR automation"); // from extracted elevator_pitch
    expect(queryGenMessage).toContain("HR Tech"); // from extracted categories
    expect(queryGenMessage).toContain("US"); // from extracted target_geo
    expect(queryGenMessage).toContain("HR directors"); // from extracted target_audience
  });
});
