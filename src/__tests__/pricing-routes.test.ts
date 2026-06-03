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
vi.mock("../services/pricing", () => ({
  outletExists: (...a: unknown[]) => mockOutletExists(...a),
  hasPriceSources: (...a: unknown[]) => mockHasPriceSources(...a),
  insertPriceSource: (...a: unknown[]) => mockInsertPriceSource(...a),
  extractAndUpsertPricing: (...a: unknown[]) => mockExtract(...a),
  getInternalPricing: (...a: unknown[]) => mockGetInternal(...a),
  getPublicPricingForOrg: (...a: unknown[]) => mockGetPublic(...a),
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
  });

  it("returns 404 when the outlet has no price sources", async () => {
    mockHasPriceSources.mockResolvedValueOnce(false);
    const res = await request(app)
      .post(`/internal/outlets/${OUTLET_ID}/pricing/reextract`)
      .set("x-api-key", API_KEY)
      .send({});

    expect(res.status).toBe(404);
    expect(mockExtract).not.toHaveBeenCalled();
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
