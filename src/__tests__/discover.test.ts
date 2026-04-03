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

const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CHILD_RUN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

function withHeaders(req: request.Test): request.Test {
  return req
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
  app = createApp();
});

describe("POST /outlets/discover", () => {
  it("creates a child run, discovers outlets via discoverCycle, closes run as completed", async () => {
    // discoverCycle returns 5 outlets on first call, 3 on second, then 0 (done)
    mockDiscoverCycle
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(CHILD_RUN_ID);
    expect(res.body.discovered).toBe(8);

    // Verify child run was created
    expect(mockCreateChildRun).toHaveBeenCalledWith("discover", expect.objectContaining({ orgId: ORG_ID, runId: RUN_ID }));
    // Verify run was closed as completed
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("uses default count of 15 when not specified", async () => {
    // Returns 15 in two batches, then stops because count reached
    mockDiscoverCycle
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(5);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({});

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(15);
  });

  it("stops when discoverCycle returns 0", async () => {
    mockDiscoverCycle.mockResolvedValueOnce(0);

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 50 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(0);
    expect(mockDiscoverCycle).toHaveBeenCalledTimes(1);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("closes run as failed on error", async () => {
    mockDiscoverCycle.mockRejectedValueOnce(new Error("brand-service /brands/extract-fields failed (503): down"));

    const res = await withHeaders(
      request(app).post("/outlets/discover")
    ).send({ count: 10 });

    expect(res.status).toBe(502);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "failed", expect.anything());
  });

  it("returns 400 listing all missing identity headers", async () => {
    const res = await request(app)
      .post("/outlets/discover")
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .send({ count: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-campaign-id");
    expect(res.body.error).toContain("x-brand-id");
    expect(res.body.error).toContain("x-feature-slug");
    expect(res.body.error).toContain("x-workflow-slug");
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
});
