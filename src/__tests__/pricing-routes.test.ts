import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import type { Express } from "express";

// Pool is mocked so importing the routers doesn't touch a real DB.
const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () => Promise.resolve({ query: mockQuery, release: vi.fn() }),
  },
}));

// Mock the pricing service entirely — routes are thin pass-throughs.
const mockOutletExists = vi.fn();
const mockHasPriceSources = vi.fn();
const mockInsertPriceSource = vi.fn();
const mockExtract = vi.fn();
const mockGetInternal = vi.fn();
const mockGetPublic = vi.fn();
const mockEnsureOutlet = vi.fn();
const mockEnsureSource = vi.fn();
const mockSourceExists = vi.fn();
const mockLinkSourceOutlets = vi.fn();
const mockInsertBrokerPriceSource = vi.fn();
const mockExtractForSource = vi.fn();
const mockTriggerDrComputeIfMissing = vi.fn();
vi.mock("../services/pricing", () => ({
  outletExists: (...a: unknown[]) => mockOutletExists(...a),
  hasPriceSources: (...a: unknown[]) => mockHasPriceSources(...a),
  insertPriceSource: (...a: unknown[]) => mockInsertPriceSource(...a),
  extractAndUpsertPricing: (...a: unknown[]) => mockExtract(...a),
  getInternalPricing: (...a: unknown[]) => mockGetInternal(...a),
  getPublicPricingForOrg: (...a: unknown[]) => mockGetPublic(...a),
  ensureOutlet: (...a: unknown[]) => mockEnsureOutlet(...a),
  ensureSource: (...a: unknown[]) => mockEnsureSource(...a),
  sourceExists: (...a: unknown[]) => mockSourceExists(...a),
  linkSourceOutlets: (...a: unknown[]) => mockLinkSourceOutlets(...a),
  insertBrokerPriceSource: (...a: unknown[]) => mockInsertBrokerPriceSource(...a),
  extractForSource: (...a: unknown[]) => mockExtractForSource(...a),
  triggerDrComputeIfMissingForOutlet: (...a: unknown[]) => mockTriggerDrComputeIfMissing(...a),
}));

const API_KEY = "test-key";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OUTLET_ID = "11111111-1111-1111-1111-111111111111";
const BRONZE_ID = "22222222-2222-2222-2222-222222222222";

const internalDTO = {
  outletId: OUTLET_ID,
  amountCents: 50000,
  currency: "USD",
  salesMultiplier: 2,
  sellPriceCents: 100000,
  articleType: "sponsored",
  allowsDofollowBacklink: true,
  onlineDurationMonths: 12,
  isPermanent: null,
  conditionsNote: "2 images max",
  confidence: 0.9,
  model: "gemini-3.1-pro-preview",
  promptVersion: "v1",
  sourceBronzeIds: [BRONZE_ID],
  extractionRationale: "Stated $500",
  extractedAt: "2026-06-03T00:00:00Z",
  bronzeCount: 1,
  createdAt: "2026-06-03T00:00:00Z",
  updatedAt: "2026-06-03T00:00:00Z",
};

const publicDTO = {
  outletId: OUTLET_ID,
  sellPriceCents: 100000,
  currency: "USD",
  articleType: "sponsored",
  allowsDofollowBacklink: true,
  onlineDurationMonths: 12,
  isPermanent: null,
  conditionsNote: "2 images max",
};

let app: Express;

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerDrComputeIfMissing.mockResolvedValue(undefined);
  app = createApp();
});

describe("POST /internal/outlets/:id/price-sources", () => {
  it("appends a note and returns the refreshed pricing (201)", async () => {
    mockOutletExists.mockResolvedValueOnce(true);
    mockInsertPriceSource.mockResolvedValueOnce(BRONZE_ID);
    mockExtract.mockResolvedValueOnce(internalDTO);

    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "Sponsored post $500, 1 dofollow, 12 months", sourceType: "email" });

    expect(res.status).toBe(201);
    expect(res.body.priceSourceId).toBe(BRONZE_ID);
    expect(res.body.pricing.amountCents).toBe(50000);
    expect(res.body.pricing.sellPriceCents).toBe(100000);
    expect(mockExtract).toHaveBeenCalledWith(OUTLET_ID);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledWith(OUTLET_ID, null);
  });

  it("passes optional org headers to the fire-and-forget DR trigger", async () => {
    mockOutletExists.mockResolvedValueOnce(true);
    mockInsertPriceSource.mockResolvedValueOnce(BRONZE_ID);
    mockExtract.mockResolvedValueOnce(internalDTO);

    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-run-id", "cccccccc-cccc-cccc-cccc-cccccccccccc")
      .send({ rawText: "Sponsored post $500, 1 dofollow, 12 months", sourceType: "email" });

    expect(res.status).toBe(201);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledWith(
      OUTLET_ID,
      expect.objectContaining({
        orgId: ORG_ID,
        runId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      })
    );
  });

  it("returns 404 when the outlet does not exist", async () => {
    mockOutletExists.mockResolvedValueOnce(false);
    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "anything" });

    expect(res.status).toBe(404);
    expect(mockInsertPriceSource).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockTriggerDrComputeIfMissing).not.toHaveBeenCalled();
  });

  it("returns 400 when rawText is missing", async () => {
    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ sourceType: "email" });

    expect(res.status).toBe(400);
  });

  it("returns 502 when extraction fails (note already stored)", async () => {
    mockOutletExists.mockResolvedValueOnce(true);
    mockInsertPriceSource.mockResolvedValueOnce(BRONZE_ID);
    mockExtract.mockRejectedValueOnce(new Error("chat-service down"));

    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "Sponsored post $500" });

    expect(res.status).toBe(502);
    expect(mockTriggerDrComputeIfMissing).not.toHaveBeenCalled();
  });

  it("returns 401 without x-api-key", async () => {
    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/price-sources`)
      .send({ rawText: "x" });
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/outlets/:id/pricing/reextract", () => {
  it("re-extracts and returns pricing (200)", async () => {
    mockHasPriceSources.mockResolvedValueOnce(true);
    mockExtract.mockResolvedValueOnce(internalDTO);

    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/pricing/reextract`)
      .set("x-api-key", API_KEY)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.pricing.amountCents).toBe(50000);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledWith(OUTLET_ID, null);
  });

  it("returns 404 when the outlet has no price sources", async () => {
    mockHasPriceSources.mockResolvedValueOnce(false);
    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/pricing/reextract`)
      .set("x-api-key", API_KEY)
      .send({});

    expect(res.status).toBe(404);
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockTriggerDrComputeIfMissing).not.toHaveBeenCalled();
  });
});

describe("GET /internal/outlets/:id/pricing", () => {
  it("returns the full internal pricing incl. retail (200)", async () => {
    mockGetInternal.mockResolvedValueOnce(internalDTO);
    const res = await request(app)
      .get(`/internal/outlets/${OUTLET_ID}/pricing`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(50000);
    expect(res.body.salesMultiplier).toBe(2);
  });

  it("returns 404 when no pricing exists", async () => {
    mockGetInternal.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(`/internal/outlets/${OUTLET_ID}/pricing`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
  });
});

describe("GET /orgs/outlets/:id/pricing", () => {
  it("returns SELL-only pricing — no retail, no multiplier (200)", async () => {
    mockGetPublic.mockResolvedValueOnce(publicDTO);
    const res = await request(app)
      .get(`/orgs/outlets/${OUTLET_ID}/pricing`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID);

    expect(res.status).toBe(200);
    expect(res.body.sellPriceCents).toBe(100000);
    expect(res.body).not.toHaveProperty("amountCents");
    expect(res.body).not.toHaveProperty("salesMultiplier");
    expect(mockGetPublic).toHaveBeenCalledWith(OUTLET_ID, ORG_ID);
  });

  it("returns 404 when the org does not own the outlet (or no pricing)", async () => {
    mockGetPublic.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(`/orgs/outlets/${OUTLET_ID}/pricing`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG_ID);
    expect(res.status).toBe(404);
  });

  it("returns 400 without x-org-id", async () => {
    const res = await request(app)
      .get(`/orgs/outlets/${OUTLET_ID}/pricing`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });
});

const SOURCE_ID = "33333333-3333-3333-3333-333333333333";

describe("POST /internal/outlets/ensure", () => {
  it("returns 201 when created", async () => {
    mockEnsureOutlet.mockResolvedValueOnce({ id: OUTLET_ID, outletName: "TechBullion", outletDomain: "techbullion.com", created: true });
    const res = await request(app)
      .post("/internal/outlets/ensure")
      .set("x-api-key", API_KEY)
      .send({ outletName: "TechBullion", outletUrl: "https://techbullion.com", outletDomain: "techbullion.com" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(OUTLET_ID);
  });

  it("returns 200 when it already existed", async () => {
    mockEnsureOutlet.mockResolvedValueOnce({ id: OUTLET_ID, outletName: "TechBullion", outletDomain: "techbullion.com", created: false });
    const res = await request(app)
      .post("/internal/outlets/ensure")
      .set("x-api-key", API_KEY)
      .send({ outletName: "TechBullion", outletUrl: "https://techbullion.com", outletDomain: "techbullion.com" });
    expect(res.status).toBe(200);
  });

  it("returns 400 on invalid url", async () => {
    const res = await request(app)
      .post("/internal/outlets/ensure")
      .set("x-api-key", API_KEY)
      .send({ outletName: "X", outletUrl: "not-a-url", outletDomain: "x.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/pricing-sources", () => {
  it("creates a broker source (201)", async () => {
    mockEnsureSource.mockResolvedValueOnce({ id: SOURCE_ID, name: "Matrix Global Brands", domain: "matrixglobalbrands.com", kind: "broker" });
    const res = await request(app)
      .post("/internal/pricing-sources")
      .set("x-api-key", API_KEY)
      .send({ name: "Matrix Global Brands", domain: "matrixglobalbrands.com" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(SOURCE_ID);
    expect(res.body.kind).toBe("broker");
  });
});

describe("POST /internal/pricing-sources/:id/outlets", () => {
  it("links outlets (200)", async () => {
    mockSourceExists.mockResolvedValueOnce(true);
    mockLinkSourceOutlets.mockResolvedValueOnce(2);
    const res = await request(app)
      .post(`/internal/pricing-sources/${SOURCE_ID}/outlets`)
      .set("x-api-key", API_KEY)
      .send({ outletIds: [OUTLET_ID, "44444444-4444-4444-4444-444444444444"] });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(2);
    expect(res.body.requested).toBe(2);
  });

  it("returns 404 when source missing", async () => {
    mockSourceExists.mockResolvedValueOnce(false);
    const res = await request(app)
      .post(`/internal/pricing-sources/${SOURCE_ID}/outlets`)
      .set("x-api-key", API_KEY)
      .send({ outletIds: [OUTLET_ID] });
    expect(res.status).toBe(404);
    expect(mockLinkSourceOutlets).not.toHaveBeenCalled();
  });
});

describe("POST /internal/pricing-sources/:id/price-sources", () => {
  it("stores broker note + fan-out extracts member outlets (201)", async () => {
    mockSourceExists.mockResolvedValueOnce(true);
    mockInsertBrokerPriceSource.mockResolvedValueOnce("note-id-1");
    mockExtractForSource.mockResolvedValueOnce([
      { outletId: OUTLET_ID, pricing: internalDTO },
      { outletId: "44444444-4444-4444-4444-444444444444", pricing: { ...internalDTO, outletId: "44444444-4444-4444-4444-444444444444" } },
    ]);
    const res = await request(app)
      .post(`/internal/pricing-sources/${SOURCE_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "Single article $150, permanent, 1 dofollow.", sourceType: "email" });
    expect(res.status).toBe(201);
    expect(res.body.priceSourceId).toBe("note-id-1");
    expect(res.body.extracted).toHaveLength(2);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledTimes(2);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledWith(OUTLET_ID, null);
    expect(mockTriggerDrComputeIfMissing).toHaveBeenCalledWith("44444444-4444-4444-4444-444444444444", null);
  });

  it("returns 404 when source missing", async () => {
    mockSourceExists.mockResolvedValueOnce(false);
    const res = await request(app)
      .post(`/internal/pricing-sources/${SOURCE_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "x" });
    expect(res.status).toBe(404);
    expect(mockInsertBrokerPriceSource).not.toHaveBeenCalled();
    expect(mockTriggerDrComputeIfMissing).not.toHaveBeenCalled();
  });

  it("returns 502 when fan-out extraction fails (note stored)", async () => {
    mockSourceExists.mockResolvedValueOnce(true);
    mockInsertBrokerPriceSource.mockResolvedValueOnce("note-id-1");
    mockExtractForSource.mockRejectedValueOnce(new Error("chat down"));
    const res = await request(app)
      .post(`/internal/pricing-sources/${SOURCE_ID}/price-sources`)
      .set("x-api-key", API_KEY)
      .send({ rawText: "x" });
    expect(res.status).toBe(502);
    expect(mockTriggerDrComputeIfMissing).not.toHaveBeenCalled();
  });
});
