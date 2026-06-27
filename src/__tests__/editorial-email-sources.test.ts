import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Mock DB pool — route queries through a SQL-aware mock so ensureOutlet,
// curation upsert, bronze insert, and the curated-bronze read each resolve.
const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () => Promise.resolve({ query: mockQuery, release: vi.fn() }),
  },
}));

// Mock runs service (used by the discover route's child-run tracking).
vi.mock("../services/runs", () => ({
  createChildRun: vi.fn().mockResolvedValue("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
  closeRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock scraping + google so we can assert the curated bronze short-circuits them.
const mockScrape = vi.fn();
const mockMap = vi.fn();
vi.mock("../services/scraping", () => ({
  scrapeRawHtml: (...args: unknown[]) => mockScrape(...args),
  mapContactUrls: (...args: unknown[]) => mockMap(...args),
}));
const mockSerper = vi.fn();
vi.mock("../services/google", () => ({
  serperEditorialEmails: (...args: unknown[]) => mockSerper(...args),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OUTLET_ID = "11111111-1111-4111-8111-111111111111";

let app: Express;

beforeEach(() => {
  vi.resetAllMocks();
  mockMap.mockResolvedValue([]);
  mockSerper.mockResolvedValue([]);
  // Default: empty result. Override per-test via mockImplementation.
  mockQuery.mockResolvedValue({ rows: [] });
  app = createApp();
});

/** Route the SQL-aware mock: outlet upsert returns an id; everything else []. */
function routeQueries(overrides: (sql: string) => unknown[] | undefined = () => undefined) {
  mockQuery.mockImplementation(async (sql: string) => {
    const custom = overrides(sql);
    if (custom) return { rows: custom };
    if (/INSERT INTO outlets\b/.test(sql)) {
      return { rows: [{ id: OUTLET_ID, outlet_name: "X", outlet_domain: "outlet.com", created: true }] };
    }
    return { rows: [] };
  });
}

describe("POST /internal/editorial-emails/sources", () => {
  it("seeds a found entry: upserts outlet, curation=found, bronze rows (201)", async () => {
    routeQueries();
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .set("x-api-key", API_KEY)
      .send({
        entries: [
          {
            domain: "outlet.com",
            outletName: "Outlet",
            url: "https://outlet.com",
            status: "found",
            capturedBy: "curated-2026-06",
            emails: [
              { email: "press@outlet.com", role: "press", sourceUrl: "https://outlet.com/contact", captureMethod: "page", confidence: 0.9 },
            ],
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ outlets: 1, emailsUpserted: 1, found: 1, notFound: 0 });
    const sqls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /INSERT INTO outlets/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO outlet_editorial_curation/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO outlet_editorial_email_sources/.test(s))).toBe(true);
  });

  it("seeds a not_found entry: curation=not_found, no bronze insert (201)", async () => {
    routeQueries();
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .set("x-api-key", API_KEY)
      .send({
        entries: [
          { domain: "dead.com", outletName: "Dead", status: "not_found", capturedBy: "curated-2026-06", note: "form-only" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ outlets: 1, emailsUpserted: 0, found: 0, notFound: 1 });
    const sqls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /INSERT INTO outlet_editorial_curation/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO outlet_editorial_email_sources/.test(s))).toBe(false);
  });

  it("rejects found with no emails (400)", async () => {
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .set("x-api-key", API_KEY)
      .send({ entries: [{ domain: "x.com", outletName: "X", status: "found", capturedBy: "c", emails: [] }] });
    expect(res.status).toBe(400);
  });

  it("rejects not_found with emails (400)", async () => {
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .set("x-api-key", API_KEY)
      .send({
        entries: [{ domain: "x.com", outletName: "X", status: "not_found", capturedBy: "c", emails: [{ email: "a@x.com", captureMethod: "page" }] }],
      });
    expect(res.status).toBe(400);
  });

  it("requires only the api key — no org context (201)", async () => {
    routeQueries();
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .set("x-api-key", API_KEY)
      .send({ entries: [{ domain: "x.com", outletName: "X", status: "not_found", capturedBy: "c" }] });
    expect(res.status).toBe(201);
  });

  it("401 without the api key", async () => {
    const res = await request(app)
      .post("/internal/editorial-emails/sources")
      .send({ entries: [{ domain: "x.com", outletName: "X", status: "not_found", capturedBy: "c" }] });
    expect(res.status).toBe(401);
  });
});

describe("curated bronze precedence in discover", () => {
  const body = { outletName: "Outlet", domain: "outlet.com", url: "https://outlet.com" };

  it("found verdict serves curated emails and never scrapes", async () => {
    routeQueries((sql) => {
      if (/FROM outlet_editorial_curation/.test(sql)) return [{ status: "found", outlet_id: OUTLET_ID }];
      if (/FROM outlet_editorial_email_sources/.test(sql))
        return [{ email: "editorial@outlet.com", role: "editorial", source_url: "https://outlet.com/contact" }];
      return undefined;
    });

    const res = await request(app)
      .post("/orgs/outlets/editorial-emails/discover")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("found");
    expect(res.body.emails[0].email).toBe("editorial@outlet.com");
    expect(res.body.emails[0].source).toBe("https://outlet.com/contact");
    expect(mockScrape).not.toHaveBeenCalled();
  });

  it("not_found verdict serves terminal no_email_found and never scrapes", async () => {
    routeQueries((sql) => {
      if (/FROM outlet_editorial_curation/.test(sql)) return [{ status: "not_found", outlet_id: OUTLET_ID }];
      return undefined;
    });

    const res = await request(app)
      .post("/orgs/outlets/editorial-emails/discover")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_email_found");
    expect(res.body.emails).toEqual([]);
    expect(mockScrape).not.toHaveBeenCalled();
  });
});
