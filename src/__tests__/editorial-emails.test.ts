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

// Mock scraping-service client
const mockScrape = vi.fn();
const mockMapSitemap = vi.fn();
vi.mock("../services/scraping", () => ({
  scrapeRawHtml: (...args: unknown[]) => mockScrape(...args),
  mapSitemapUrls: (...args: unknown[]) => mockMapSitemap(...args),
}));

// Mock google-service serper (top result URLs)
const mockSerperUrls = vi.fn();
vi.mock("../services/google", () => ({
  serperTopResultUrls: (...args: unknown[]) => mockSerperUrls(...args),
}));

// Mock the LLM categorize + URL-pick steps
const mockCategorize = vi.fn();
const mockPickUrls = vi.fn();
vi.mock("../services/editorial-categorize", () => ({
  categorizeEditorialEmails: (...args: unknown[]) => mockCategorize(...args),
  pickContactUrls: (...args: unknown[]) => mockPickUrls(...args),
}));

// Mock the curated-bronze Rung-0 (own feature, tested separately) → default no curated entry.
const mockCurated = vi.fn();
vi.mock("../services/editorial-email-sources", () => ({
  readCuratedEditorial: (...args: unknown[]) => mockCurated(...args),
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
  mockCreateChildRun.mockResolvedValue(CHILD_RUN_ID);
  mockCloseRun.mockResolvedValue(undefined);
  mockSerperUrls.mockResolvedValue([]);
  mockMapSitemap.mockResolvedValue([]);
  mockPickUrls.mockResolvedValue([]);
  mockCategorize.mockResolvedValue([]);
  mockCurated.mockResolvedValue(null); // no curated bronze entry by default
  mockScrape.mockResolvedValue("<html>nothing</html>");
  // Default: every DB query returns empty → cache miss + writes succeed.
  mockQuery.mockResolvedValue({ rows: [] });
  app = createApp();
});

const body = { outletName: "Outlet", domain: "outlet.com", url: URL };

describe("POST /orgs/outlets/editorial-emails/discover", () => {
  it("Path A: scrapes top Google result pages, LLM-vets, status=found_google", async () => {
    mockSerperUrls.mockResolvedValue(["https://press-db.example/outlet"]);
    mockScrape.mockResolvedValue(`editorial@outlet.com info@outlet.com`);
    mockCategorize.mockResolvedValueOnce([
      { email: "editorial@outlet.com", category: "editorial" },
      { email: "info@outlet.com", category: "generic" },
    ]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found_google");
    expect(res.body.emails[0].email).toBe("editorial@outlet.com"); // LLM rank, best-first
    expect(res.body.emails[0].score).toBe(0);
    expect(res.body.emails.map((e: { email: string }) => e.email)).toEqual([
      "editorial@outlet.com",
      "info@outlet.com",
    ]);
    expect(mockSerperUrls).toHaveBeenCalledWith("Outlet", "outlet.com", expect.anything(), 2);
    expect(mockMapSitemap).not.toHaveBeenCalled(); // Path B not reached
    expect(mockCloseRun).toHaveBeenCalledWith(CHILD_RUN_ID, "completed", expect.anything());
  });

  it("drops junk non-email tokens via the LLM (e.g. @apps.globoid)", async () => {
    mockSerperUrls.mockResolvedValue(["https://g1.globo.com/contato"]);
    mockScrape.mockResolvedValue(
      `cobertura-ao-vivo-frontend@apps.globoid redacao@g1.globo.com`
    );
    // LLM keeps only the real editorial inbox, drops the app identifier.
    mockCategorize.mockResolvedValueOnce([{ email: "redacao@g1.globo.com", category: "editorial" }]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send({ outletName: "GloboNews", domain: "g1.globo.com", url: "https://g1.globo.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found_google");
    expect(res.body.emails.map((e: { email: string }) => e.email)).toEqual(["redacao@g1.globo.com"]);
    // the categorize step received the junk token as a candidate but it was dropped
    expect(mockCategorize.mock.calls[0][2]).toContain("cobertura-ao-vivo-frontend@apps.globoid");
  });

  it("Path B: when Google yields nothing, sitemap → LLM picks URLs → status=found", async () => {
    mockSerperUrls.mockResolvedValue(["https://outlet.com/article"]);
    mockScrape.mockImplementation(async (url: string) =>
      url === "https://outlet.com/imprensa" ? "press@outlet.com" : "<html>no email</html>"
    );
    mockMapSitemap.mockResolvedValue([
      "https://outlet.com/article",
      "https://outlet.com/imprensa",
    ]);
    mockPickUrls.mockResolvedValue(["https://outlet.com/imprensa"]);
    // categorize: A (no emails) → [], then B → press@
    mockCategorize.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { email: "press@outlet.com", category: "press" },
    ]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found");
    expect(res.body.emails[0].email).toBe("press@outlet.com");
    expect(mockMapSitemap).toHaveBeenCalled();
    expect(mockPickUrls).toHaveBeenCalled();
  });

  it("returns no_email_found when neither path yields a vetted address", async () => {
    mockSerperUrls.mockResolvedValue(["https://outlet.com/article"]);
    mockScrape.mockResolvedValue("<html>nothing useful</html>");
    mockMapSitemap.mockResolvedValue(["https://outlet.com/article"]);
    mockPickUrls.mockResolvedValue(["https://outlet.com/article"]);
    mockCategorize.mockResolvedValue([]); // both paths vet to nothing

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_email_found");
    expect(res.body.emails).toEqual([]);
  });

  it("flags parked domains as parked_dead", async () => {
    mockSerperUrls.mockResolvedValue(["https://outlet.com/"]);
    mockScrape.mockResolvedValue(`<script>location.href="/lander?oref=x"</script>`);
    mockMapSitemap.mockResolvedValue(["https://outlet.com/"]);
    mockPickUrls.mockResolvedValue(["https://outlet.com/"]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover")
    ).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("parked_dead");
    expect(res.body.emails).toEqual([]);
  });

  it("serves a fresh cache hit without scraping or searching", async () => {
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
    expect(mockSerperUrls).not.toHaveBeenCalled();
  });

  it("returns 502 and closes the run as failed on upstream scrape error", async () => {
    mockSerperUrls.mockResolvedValue(["https://outlet.com/x"]);
    mockScrape.mockRejectedValue(
      new Error("[outlets-service] scraping-service POST /scrape failed (502) for https://outlet.com/x: down")
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
    mockSerperUrls.mockResolvedValue(["https://outlet.com/contact"]);
    mockScrape.mockResolvedValue("press@outlet.com");
    mockCategorize.mockResolvedValue([{ email: "press@outlet.com", category: "press" }]);

    const res = await withHeaders(
      request(app).post("/orgs/outlets/editorial-emails/discover-batch")
    ).send({ outlets: [body] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe("found_google");
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
