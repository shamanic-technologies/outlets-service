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
      mockConnect().then(() => ({ query: mockQuery, release: mockRelease })),
  },
}));

// Mock runs service
const mockCreateChildRun = vi.fn();
const mockCloseRun = vi.fn();
vi.mock("../services/runs", () => ({
  createChildRun: (...args: unknown[]) => mockCreateChildRun(...args),
  closeRun: (...args: unknown[]) => mockCloseRun(...args),
}));

// Mock scraping-service client
const mockScrape = vi.fn();
const mockMap = vi.fn();
vi.mock("../services/scraping", () => ({
  scrapeRawHtml: (...args: unknown[]) => mockScrape(...args),
  mapContactUrls: (...args: unknown[]) => mockMap(...args),
}));

// Mock google-service serper fallback
const mockSerper = vi.fn();
vi.mock("../services/google", () => ({
  serperEditorialEmails: (...args: unknown[]) => mockSerper(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHILD_RUN_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const URL = "https://outlet.com";

function withHeaders(req: request.Test): request.Test {
  return req.set("x-api-key", API_KEY).set("x-org-id", ORG_ID);
}

let app: Express;

beforeEach(() => {
  vi.resetAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
  mockCloseRun.mockResolvedValue(undefined);
  mockMap.mockResolvedValue([]);
  mockSerper.mockResolvedValue([]);
  // Default: every DB query returns empty → cache miss + writes succeed.
  mockQuery.mockResolvedValue({ rows: [] });
  app = createApp();
});

const body = { outletName: "Outlet", domain: "outlet.com", url: URL };

describe("POST /orgs/outlets/editorial-emails/discover", () => {
  it("finds emails on /contact, early-stops, sorts editorial first, status=found", async () => {
    mockScrape.mockImplementation(async (url: string) => {
      if (url === URL) return "<html>homepage, no email</html>";
      if (url === `${URL}/contact`)
        return `<a href="mailto:editorial@outlet.com">editorial@outlet.com</a> info@outlet.com`;
      return "";
    });

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found");
    expect(res.body.domain).toBe("outlet.com");
    expect(res.body.emails[0].email).toBe("editorial@outlet.com"); // editorial scored first
    expect(res.body.emails.map((e: { email: string }) => e.email)).toContain("info@outlet.com");
    // early-stop: only homepage + /contact fetched
    expect(mockScrape).toHaveBeenCalledTimes(2);
    expect(mockCreateChildRun).toHaveBeenCalledWith("editorial-email-discover", expect.objectContaining({ orgId: ORG_ID }));
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("flags parked domains and stops the ladder", async () => {
    mockScrape.mockResolvedValue(`<script>location.href="/lander?oref=x"</script>`);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("parked_dead");
    expect(res.body.emails).toEqual([]);
    expect(mockScrape).toHaveBeenCalledTimes(1); // stopped on homepage lander
    expect(mockSerper).not.toHaveBeenCalled();
  });

  it("falls back to serper Google and tags status=found_google", async () => {
    mockScrape.mockResolvedValue("<html>no contact email here</html>");
    mockSerper.mockResolvedValue(["news@outlet.com"]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found_google");
    expect(res.body.emails[0].email).toBe("news@outlet.com");
    expect(mockSerper).toHaveBeenCalledWith("Outlet", "outlet.com", expect.anything());
  });

  it("returns no_email_found when every rung is empty", async () => {
    mockScrape.mockResolvedValue("<html>nothing</html>");

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_email_found");
    expect(res.body.emails).toEqual([]);
  });

  it("serves a fresh cache hit without calling any scraper", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: "found" }] }) // lookup
      .mockResolvedValueOnce({ rows: [{ email: "cached@outlet.com", score: 0, source: "cache" }] }); // emails

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found");
    expect(res.body.emails[0].email).toBe("cached@outlet.com");
    expect(mockScrape).not.toHaveBeenCalled();
    expect(mockSerper).not.toHaveBeenCalled();
  });

  it("returns 502 and closes the run as failed on upstream error", async () => {
    mockScrape.mockRejectedValue(
      new Error("[outlets-service] scraping-service POST /scrape failed (502) for https://outlet.com: down")
    );

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(502);
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "failed", expect.anything());
  });

  it("returns 400 on validation error (missing url)", async () => {
    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send({ outletName: "Outlet", domain: "outlet.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("returns 400 when x-org-id is missing", async () => {
    const res = await request(app)
      .post("/orgs/outlets/editorial-emails/discover")
      .set("x-api-key", API_KEY)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

describe("POST /orgs/outlets/editorial-emails/discover-batch", () => {
  it("returns one result per outlet", async () => {
    mockScrape.mockImplementation(async (url: string) =>
      url.endsWith("/contact") ? "press@outlet.com" : "<html>no email</html>"
    );

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover-batch")
    ).send({ outlets: [body] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe("found");
    expect(res.body.results[0].emails[0].email).toBe("press@outlet.com");
    expect(mockCreateChildRun).toHaveBeenCalledWith("editorial-email-discover-batch", expect.anything());
  });

  it("returns 400 when batch exceeds 50 outlets", async () => {
    const outlets = Array.from({ length: 51 }, () => body);
    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover-batch")
    ).send({ outlets });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});
