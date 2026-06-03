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

// Mock category discovery
const mockDiscoverCycle = vi.fn();
vi.mock("../services/category-discovery", () => ({
  discoverCycle: (...args: unknown[]) => mockDiscoverCycle(...args),
}));

// Mock ahref service (DR compute trigger)
const mockTriggerDrCompute = vi.fn();
vi.mock("../services/ahref", () => ({
  triggerDrCompute: (...args: unknown[]) => mockTriggerDrCompute(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CHILD_RUN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

function withHeaders(req: request.Test): request.Test {
  return req
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG_ID)
    .set("x-user-id", USER_ID)
    .set("x-run-id", RUN_ID)
    .set("x-campaign-id", CAMPAIGN_ID)
    .set("x-brand-id", BRAND_ID)
    .set("x-feature-slug", "outlets")
    .set("x-workflow-slug", "discover");
}

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
  mockCloseRun.mockResolvedValue(undefined);
  mockTriggerDrCompute.mockResolvedValue(undefined);
  app = createApp();
});

describe("POST /orgs/outlets/discover", () => {
  it("creates a child run, discovers outlets via discoverCycle, closes run as completed", async () => {
    // discoverCycle returns 5 outlets on first call, 3 on second, then 0 (done).
    // "b.com" repeats across cycles → must be deduped in the dr-compute trigger.
    mockDiscoverCycle
      .mockResolvedValueOnce({ inserted: 5, domains: ["a.com", "b.com"] })
      .mockResolvedValueOnce({ inserted: 3, domains: ["b.com", "c.com"] })
      .mockResolvedValueOnce({ inserted: 0, domains: [] });

    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(CHILD_RUN_ID);
    expect(res.body.discovered).toBe(8);

    // Verify child run was created
    expect(mockCreateChildRun).toHaveBeenCalledWith("discover", expect.objectContaining({ orgId: ORG_ID, runId: RUN_ID }));
    // Verify run was closed as completed
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
    // Verify ahref DR compute was triggered once with the deduped discovered domains
    expect(mockTriggerDrCompute).toHaveBeenCalledTimes(1);
    expect(mockTriggerDrCompute.mock.calls[0][0]).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("uses default count of 15 when not specified", async () => {
    // Returns 15 in two batches, then stops because count reached
    mockDiscoverCycle
      .mockResolvedValueOnce({ inserted: 10, domains: ["x.com"] })
      .mockResolvedValueOnce({ inserted: 5, domains: ["y.com"] });

    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(15);
  });

  it("stops when discoverCycle returns 0", async () => {
    mockDiscoverCycle.mockResolvedValueOnce({ inserted: 0, domains: [] });

    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 50 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(0);
    expect(mockDiscoverCycle).toHaveBeenCalledTimes(1);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
    // No domains discovered → no dr-compute trigger
    expect(mockTriggerDrCompute).not.toHaveBeenCalled();
  });

  it("succeeds even when the ahref dr-compute trigger fails (non-blocking)", async () => {
    mockDiscoverCycle
      .mockResolvedValueOnce({ inserted: 2, domains: ["a.com", "b.com"] })
      .mockResolvedValueOnce({ inserted: 0, domains: [] });
    mockTriggerDrCompute.mockRejectedValueOnce(new Error("ahref-service /orgs/domains/dr-compute failed (502): apify down"));

    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 10 });

    // Discover must not fail because the (fire-and-forget) DR trigger errored
    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(2);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
    expect(mockTriggerDrCompute).toHaveBeenCalledTimes(1);
  });

  it("closes run as failed on error", async () => {
    mockDiscoverCycle.mockRejectedValueOnce(new Error("brand-service /orgs/brands/extract-fields failed (503): down"));

    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(502);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "failed", expect.anything());
  });

  it("returns 400 when x-org-id is missing", async () => {
    const res = await request(app)
      .post("/orgs/outlets/discover")
      .set("x-api-key", API_KEY)
      .send({ count: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 400 for count > 200", async () => {
    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 201 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 for count < 1", async () => {
    const res = await withHeaders(
      request(app).post("/orgs/outlets/discover")
    ).send({ count: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});
