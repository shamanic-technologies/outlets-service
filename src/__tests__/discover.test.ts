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

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function withIdentity(req: request.Test): request.Test {
  return req.set("x-org-id", ORG_ID).set("x-user-id", USER_ID).set("x-run-id", RUN_ID);
}

const validDiscoverBody = {
  campaignId: CAMPAIGN_ID,
  brandName: "Acme Corp",
  brandDescription: "SaaS platform for HR automation",
  industry: "HR Tech",
  targetGeo: "US",
  targetAudience: "HR directors",
  angles: ["product launch"],
};

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
  app = createApp();
});

describe("POST /outlets/discover", () => {
  it("discovers outlets end-to-end", async () => {
    // LLM call 1: generate queries
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    // Google search
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    // LLM call 2: score outlets
    mockChatComplete.mockResolvedValueOnce(llmScoringResponse);

    // DB: BEGIN, (INSERT press_outlets + INSERT campaign_outlets) x2, COMMIT
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

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    expect(res.status).toBe(201);
    expect(res.body.discoveredCount).toBe(2);
    expect(res.body.outlets).toHaveLength(2);
    expect(res.body.outlets[0].outletName).toBe("HR Tech Weekly");
    expect(res.body.outlets[0].relevanceScore).toBe(92);
    expect(res.body.outlets[1].outletName).toBe("TechCrunch");
    expect(res.body.searchQueries).toBe(2);
    expect(res.body.tokensUsed).toBeDefined();

    // Verify chat-service was called twice
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    // Verify google-service was called once (batch)
    expect(mockSearchBatch).toHaveBeenCalledTimes(1);
    // Verify batch request contained 2 queries
    expect(mockSearchBatch.mock.calls[0][0].queries).toHaveLength(2);
  });

  it("returns 400 for invalid body", async () => {
    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send({ brandName: "Acme" }); // missing required fields

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 without identity headers", async () => {
    const res = await request(app)
      .post("/outlets/discover")
      .send(validDiscoverBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 502 when LLM returns invalid query format", async () => {
    mockChatComplete.mockResolvedValueOnce({
      content: "not valid json",
      json: { invalid: "format" },
      tokensInput: 100,
      tokensOutput: 50,
      model: "claude-sonnet-4-6",
    });

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("search queries");
  });

  it("returns 502 when LLM returns invalid scoring format", async () => {
    mockChatComplete
      .mockResolvedValueOnce(llmQueriesResponse) // valid queries
      .mockResolvedValueOnce({
        content: "bad scoring",
        json: { invalid: "scoring" },
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      });
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("score outlets");
  });

  it("returns 502 when chat-service is down", async () => {
    mockChatComplete.mockRejectedValueOnce(
      new Error("chat-service /complete failed (503): Service Unavailable")
    );

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("chat-service");
  });

  it("returns 502 when google-service is down", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockRejectedValueOnce(
      new Error("google-service /search/batch failed (503): Service Unavailable")
    );

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

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

    const res = await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    expect(res.status).toBe(200);
    expect(res.body.discoveredCount).toBe(0);
    expect(res.body.outlets).toEqual([]);
  });

  it("passes correct headers to chat-service", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: { outlets: [] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "claude-sonnet-4-6",
    });

    await withIdentity(
      request(app).post("/outlets/discover")
    ).send(validDiscoverBody);

    // Check headers passed to chatComplete
    const firstCallHeaders = mockChatComplete.mock.calls[0][1];
    expect(firstCallHeaders).toEqual({
      orgId: ORG_ID,
      userId: USER_ID,
      runId: RUN_ID,
    });
  });

  it("propagates x-feature-slug to downstream services", async () => {
    mockChatComplete.mockResolvedValueOnce(llmQueriesResponse);
    mockSearchBatch.mockResolvedValueOnce(googleBatchResponse);
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: { outlets: [] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "claude-sonnet-4-6",
    });

    await withIdentity(
      request(app).post("/outlets/discover")
    )
      .set("x-feature-slug", "discover-feature")
      .send(validDiscoverBody);

    // Check feature slug passed to chatComplete
    const chatHeaders = mockChatComplete.mock.calls[0][1];
    expect(chatHeaders.featureSlug).toBe("discover-feature");

    // Check feature slug passed to searchBatch
    const googleHeaders = mockSearchBatch.mock.calls[0][1];
    expect(googleHeaders.featureSlug).toBe("discover-feature");
  });
});
