import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () => Promise.resolve({ query: mockQuery, release: vi.fn() }),
  },
}));

vi.mock("../services/runs", () => ({
  createChildRun: vi.fn().mockResolvedValue("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
  closeRun: vi.fn().mockResolvedValue(undefined),
}));

const mockSend = vi.fn();
vi.mock("../services/email-gateway", () => ({
  sendBroadcastEmail: (...args: unknown[]) => mockSend(...args),
}));

// Discovery must NEVER be called on the send-only path.
const mockDiscover = vi.fn();
vi.mock("../services/editorial-emails", () => ({
  discoverEditorialEmails: (...args: unknown[]) => mockDiscover(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OUTLET_A = "11111111-1111-4111-8111-111111111111";
const OUTLET_B = "22222222-2222-4222-8222-222222222222";

let app: Express;

beforeEach(() => {
  vi.resetAllMocks();
  mockSend.mockResolvedValue({ success: true, messageId: "mid-1", provider: "instantly" });
  mockQuery.mockResolvedValue({ rows: [] });
  app = createApp();
});

function withHeaders(req: request.Test): request.Test {
  return req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID);
}

/** Route the SQL-aware mock. `curatedByOutlet` maps outletId -> curated email rows. */
function routeQueries(
  existingOutletIds: string[],
  curatedByOutlet: Record<string, Array<{ email: string; role: string | null }>>
) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM outlets WHERE id = ANY/.test(sql)) {
      const ids = (params?.[0] as string[]) ?? [];
      return {
        rows: ids
          .filter((id) => existingOutletIds.includes(id))
          .map((id) => ({ id, outlet_name: `Outlet ${id.slice(0, 4)}`, outlet_url: "https://x.com", outlet_domain: "x.com" })),
      };
    }
    if (/FROM outlet_editorial_email_sources/.test(sql)) {
      const outletId = params?.[0] as string;
      return { rows: curatedByOutlet[outletId] ?? [] };
    }
    return { rows: [] }; // INSERT outlet_price_requests, etc.
  });
}

describe("POST /orgs/outlets/price-requests/send", () => {
  it("sends the 3-step sequence to curated emails (to + bcc), never discovers", async () => {
    routeQueries([OUTLET_A], {
      [OUTLET_A]: [
        { email: "press@x.com", role: "press" },
        { email: "info@x.com", role: "general" },
      ],
    });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests/send")).send({ outletIds: [OUTLET_A] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outletId: OUTLET_A, status: "ongoing", editorialEmail: "press@x.com", messageId: "mid-1" });
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0][0];
    expect(sendArg.to).toBe("press@x.com"); // editorial-first
    expect(sendArg.bcc).toBe("info@x.com");
    expect(sendArg.sequence).toHaveLength(3);
    expect(sendArg.idempotencyKey).toBe(`price-request:${OUTLET_A}`);
  });

  it("skips an outlet with no curated email (error result, no send)", async () => {
    routeQueries([OUTLET_A], { [OUTLET_A]: [] });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests/send")).send({ outletIds: [OUTLET_A] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outletId: OUTLET_A, status: "error", error: "No curated editorial email" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns error for an outlet not in the registry", async () => {
    routeQueries([], {});

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests/send")).send({ outletIds: [OUTLET_B] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outletId: OUTLET_B, status: "error", error: "Outlet not found" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("400 on empty outletIds", async () => {
    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests/send")).send({ outletIds: [] });
    expect(res.status).toBe(400);
  });

  it("400 on more than 100 outletIds", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `1111111${(i % 10)}-1111-4111-8111-111111111111`);
    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests/send")).send({ outletIds: ids });
    expect(res.status).toBe(400);
  });

  it("401 without the api key", async () => {
    const res = await request(app).post("/orgs/outlets/price-requests/send").set("x-org-id", ORG_ID).send({ outletIds: [OUTLET_A] });
    expect(res.status).toBe(401);
  });
});
