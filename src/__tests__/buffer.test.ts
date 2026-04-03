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

// Mock category discovery
const mockDiscoverCycle = vi.fn();
vi.mock("../services/category-discovery", () => ({
  discoverCycle: (...args: unknown[]) => mockDiscoverCycle(...args),
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

  it("triggers discover cycle when buffer is empty, then returns top outlet", async () => {
    // claimNext iteration 1 → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // discoverCycle fills the buffer with 3 outlets
    mockDiscoverCycle.mockResolvedValueOnce(3);

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

    // Verify discover cycle was triggered
    expect(mockDiscoverCycle).toHaveBeenCalledTimes(1);
  });

  it("returns empty outlets array when discover cycle finds nothing", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // discoverCycle → 0 outlets
    mockDiscoverCycle.mockResolvedValueOnce(0);

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(0);
  });

  it("retries discover cycle up to MAX_DISCOVER_ATTEMPTS when buffer keeps emptying", async () => {
    // First claim → empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Discover attempt 1 → fills 2 outlets
    mockDiscoverCycle.mockResolvedValueOnce(2);
    // Claim → gets one but it's blocked
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow({ relevance_score: "90.00" })] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // block cache
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // markSkipped
    // Claim → gets another but also blocked
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow({ relevance_score: "85.00" })] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // block cache
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // markSkipped
    // Claim → empty again
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Discover attempt 2 → fills 1 outlet
    mockDiscoverCycle.mockResolvedValueOnce(1);
    // Claim → gets one, not blocked
    mockQuery.mockResolvedValueOnce({ rows: [makeOutletRow()] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // block cache
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(mockDiscoverCycle).toHaveBeenCalledTimes(2);
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

    // discoverCycle → finds nothing
    mockDiscoverCycle.mockResolvedValueOnce(0);

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

  it("returns 502 when discover cycle fails with upstream error", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockDiscoverCycle.mockRejectedValueOnce(
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

  it("does not retry discover when first attempt returns 0", async () => {
    // claimNext → buffer empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // discoverCycle → 0
    mockDiscoverCycle.mockResolvedValueOnce(0);

    const res = await withHeaders(
      request(app).post("/buffer/next")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.outlets).toHaveLength(0);
    // Should only have called discoverCycle once — breaks on 0
    expect(mockDiscoverCycle).toHaveBeenCalledTimes(1);
  });
});
