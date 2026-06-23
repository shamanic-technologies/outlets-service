import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Mock DB pool
const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Mock runs service
const mockCreateChildRun = vi.fn();
const mockCloseRun = vi.fn();
vi.mock("../services/runs", () => ({
  createChildRun: (...args: unknown[]) => mockCreateChildRun(...args),
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
}));

// Mock editorial-email discovery (reused by the price-request flow)
const mockDiscover = vi.fn();
vi.mock("../services/editorial-emails", () => ({
  discoverEditorialEmails: (...args: unknown[]) => mockDiscover(...args),
}));

// Mock email-gateway send
const mockSend = vi.fn();
vi.mock("../services/email-gateway", () => ({
  sendBroadcastEmail: (...args: unknown[]) => mockSend(...args),
}));

// Mock deliverability verification (gates the send)
const mockPick = vi.fn();
vi.mock("../services/email-verification", () => ({
  pickDeliverableEmail: (...args: unknown[]) => mockPick(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CAMPAIGN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CHILD_RUN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const OUTLET_ID = "11111111-1111-1111-1111-111111111111";
const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";

function withHeaders(req: request.Test): request.Test {
  return req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID).set("x-campaign-id", CAMPAIGN_ID);
}

function withOrgOnlyHeaders(req: request.Test): request.Test {
  return req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID);
}

function ownedRow(id: string, domain: string) {
  return { id, outlet_name: "Outlet " + domain, outlet_url: `https://${domain}`, outlet_domain: domain };
}

let app: Express;

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
  mockCloseRun.mockResolvedValue(undefined);
  mockDiscover.mockResolvedValue({
    domain: "outlet.com",
    status: "found",
    emails: [{ email: "editorial@outlet.com", score: 0, source: "https://outlet.com/contact" }],
  });
  mockSend.mockResolvedValue({ success: true, messageId: "msg-1", provider: "broadcast" });
  // Default: discovered email verifies as deliverable.
  mockPick.mockResolvedValue({ email: "editorial@outlet.com", score: 0, source: "https://outlet.com/contact" });
  mockQuery.mockResolvedValue({ rows: [] }); // default: record-insert + anything else
  app = createApp();
});

describe("POST /orgs/outlets/price-requests", () => {
  it("sends a broadcast rate-card request and records the request (status=ongoing)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownedRow(OUTLET_ID, "outlet.com")] }); // loadOwnedOutlets

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      outletId: OUTLET_ID,
      status: "ongoing",
      editorialEmail: "editorial@outlet.com",
      messageId: "msg-1",
    });

    // email-gateway called with the broadcast rate-card request
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendReq = mockSend.mock.calls[0][0];
    expect(sendReq.to).toBe("editorial@outlet.com");
    expect(sendReq.subject).toBe("Branded content placement — rate card request");
    expect(sendReq.sequence[0].step).toBe(1);
    expect(sendReq.sequence[0].bodyHtml).toContain("branded content placement on Outlet outlet.com");
    expect(sendReq.campaignId).toBe(CAMPAIGN_ID);
    expect(sendReq.idempotencyKey).toBe(`price-request:${OUTLET_ID}`);

    // request row persisted
    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO outlet_price_requests"));
    expect(insertCall).toBeTruthy();

    expect(mockCreateChildRun).toHaveBeenCalledWith("outlet-price-request", expect.objectContaining({ orgId: ORG_ID }));
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("handles a batch of owned outlets", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ownedRow(OUTLET_ID, "a.com"), ownedRow(OUTLET_ID_2, "b.com")],
    });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID, OUTLET_ID_2],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r: { status: string }) => r.status === "ongoing")).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("returns a per-outlet error when no editorial email is found (no send, no row)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownedRow(OUTLET_ID, "outlet.com")] });
    mockDiscover.mockResolvedValue({ domain: "outlet.com", status: "no_email_found", emails: [] });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].error).toContain("No editorial email found");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO outlet_price_requests"))).toBe(false);
  });

  it("skips the send when no candidate verifies as deliverable (no send, no row)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownedRow(OUTLET_ID, "outlet.com")] });
    mockDiscover.mockResolvedValue({
      domain: "outlet.com",
      status: "found",
      emails: [{ email: "info@outlet.com", score: 0, source: "https://outlet.com/contact" }],
    });
    mockPick.mockResolvedValue(null); // verification rejected every candidate

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].error).toContain("No deliverable editorial email");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO outlet_price_requests"))).toBe(false);
  });

  it("sends to the verified deliverable email chosen by verification", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownedRow(OUTLET_ID, "outlet.com")] });
    mockDiscover.mockResolvedValue({
      domain: "outlet.com",
      status: "found",
      emails: [
        { email: "catchall@outlet.com", score: 0, source: "https://outlet.com/contact" },
        { email: "real@outlet.com", score: 5, source: "https://outlet.com/contact" },
      ],
    });
    // verification skips the catch-all (rank 0), picks the lower-ranked valid one
    mockPick.mockResolvedValue({ email: "real@outlet.com", score: 5, source: "https://outlet.com/contact" });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: "ongoing", editorialEmail: "real@outlet.com" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toBe("real@outlet.com");
  });

  it("returns a per-outlet error for an outlet the org does not own", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // loadOwnedOutlets → none owned

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].error).toContain("not owned");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("surfaces a send failure as a per-item error without aborting the batch", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ownedRow(OUTLET_ID, "a.com"), ownedRow(OUTLET_ID_2, "b.com")],
    });
    mockSend
      .mockRejectedValueOnce(new Error("[outlets-service] email-gateway /orgs/send failed (502): boom"))
      .mockResolvedValueOnce({ success: true, messageId: "msg-2", provider: "broadcast" });

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID, OUTLET_ID_2],
    });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.results.map((r: { outletId: string }) => [r.outletId, r]));
    expect(byId[OUTLET_ID].status).toBe("error");
    expect(byId[OUTLET_ID].error).toContain("502");
    expect(byId[OUTLET_ID_2].status).toBe("ongoing");
  });

  it("returns 400 on empty outletIds", async () => {
    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({ outletIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 when x-org-id is missing", async () => {
    const res = await request(app)
      .post("/orgs/outlets/price-requests")
      .set("x-api-key", API_KEY)
      .send({ outletIds: [OUTLET_ID] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("does not invent campaign context when x-campaign-id is missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownedRow(OUTLET_ID, "outlet.com")] });

    const res = await withOrgOnlyHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("ongoing");
    expect(mockCreateChildRun).toHaveBeenCalled();
    expect(mockDiscover).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);

    const [sendReq, sendCtx] = mockSend.mock.calls[0];
    expect(sendReq.campaignId).toBeUndefined();
    expect(sendReq.workflowSlug).toBeUndefined();
    expect(sendCtx.campaignId).toBeUndefined();
    expect(sendCtx.brandIds).toEqual([]);
    expect(sendCtx.workflowSlug).toBeUndefined();
  });

  it("returns 5xx and closes the run as failed on a handler-level DB failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down")); // loadOwnedOutlets throws

    const res = await withHeaders(request(app).post("/orgs/outlets/price-requests")).send({
      outletIds: [OUTLET_ID],
    });

    expect(res.status).toBe(500);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "failed", expect.anything());
  });
});
