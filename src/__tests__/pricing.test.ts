import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB pool
const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Mock chat service (platform LLM)
const mockPlatformComplete = vi.fn();
vi.mock("../services/chat", () => ({
  platformComplete: (...args: unknown[]) => mockPlatformComplete(...args),
  chatComplete: vi.fn(),
}));

import {
  extractAndUpsertPricing,
  getInternalPricing,
  getPublicPricingForOrg,
  ensureSource,
  linkSourceOutlets,
  extractForSource,
  hasPriceSources,
} from "../services/pricing";

const OUTLET_ID = "11111111-1111-1111-1111-111111111111";
const BRONZE_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const bronzeRow = {
  id: BRONZE_ID,
  raw_text: "Sponsored post $500, 1 dofollow link, stays 12 months",
  source_type: "email",
  created_at: "2026-06-01T00:00:00Z",
};

function silver(overrides: Record<string, unknown> = {}) {
  return {
    outlet_id: OUTLET_ID,
    amount_cents: 50000,
    currency: "USD",
    sales_multiplier: "2.00",
    sell_price_cents: 100000,
    article_type: "sponsored",
    allows_dofollow_backlink: true,
    online_duration_months: 12,
    is_permanent: null,
    conditions_note: "2 images max",
    source_bronze_ids: [BRONZE_ID],
    extraction_rationale: "Stated $500",
    confidence: "0.900",
    model: "gemini-3.1-pro-preview",
    prompt_version: "v1",
    extracted_at: "2026-06-03T00:00:00Z",
    created_at: "2026-06-03T00:00:00Z",
    updated_at: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

function findUpsertCall() {
  return mockQuery.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO outlet_pricing")
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractAndUpsertPricing", () => {
  it("loads all bronzes and calls the platform LLM (google/pro) with the pricing responseSchema", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] }); // SELECT bronzes
    mockPlatformComplete.mockResolvedValueOnce({
      content: "",
      json: {
        amountCents: 50000,
        currency: "USD",
        articleType: "sponsored",
        allowsDofollowBacklink: true,
        onlineDurationMonths: 12,
        conditionsNote: "2 images max",
        confidence: 0.9,
        rationale: "Stated $500",
      },
      tokensInput: 200,
      tokensOutput: 100,
      model: "gemini-3.1-pro-preview",
    });
    mockQuery.mockResolvedValueOnce({ rows: [silver()] }); // upsert RETURNING *

    const dto = await extractAndUpsertPricing(OUTLET_ID);

    expect(mockPlatformComplete).toHaveBeenCalledTimes(1);
    const call = mockPlatformComplete.mock.calls[0][0];
    expect(call.provider).toBe("google");
    expect(call.model).toBe("pro");
    expect(call.responseFormat).toBe("json");
    expect(call.responseSchema.required).toEqual(["rationale"]);
    // The message feeds the raw bronze note to the model
    expect(call.message).toContain("Sponsored post $500");

    const upsert = findUpsertCall();
    expect(upsert).toBeDefined();
    expect(upsert![1][1]).toBe(50000); // amount_cents
    expect(upsert![1][2]).toBe("USD"); // currency

    expect(dto.amountCents).toBe(50000);
    expect(dto.salesMultiplier).toBe(2);
    expect(dto.sellPriceCents).toBe(100000);
    expect(dto.confidence).toBe(0.9);
    expect(dto.bronzeCount).toBe(1);
    expect(dto.promptVersion).toBe("v1");
  });

  it("maps omitted (unknown) fields to null — never fabricates", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete.mockResolvedValueOnce({
      content: "",
      json: { rationale: "No price stated in the note." },
      tokensInput: 50,
      tokensOutput: 20,
      model: "gemini-3.1-pro-preview",
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        silver({
          amount_cents: null,
          currency: null,
          article_type: null,
          allows_dofollow_backlink: null,
          online_duration_months: null,
          conditions_note: null,
          sell_price_cents: null,
          confidence: null,
        }),
      ],
    });

    const dto = await extractAndUpsertPricing(OUTLET_ID);

    const upsert = findUpsertCall();
    expect(upsert![1][1]).toBeNull(); // amount_cents
    expect(upsert![1][2]).toBeNull(); // currency
    expect(upsert![1][3]).toBeNull(); // article_type
    expect(dto.amountCents).toBeNull();
    expect(dto.sellPriceCents).toBeNull();
  });

  it("does NOT touch sales_multiplier on re-extraction (per-outlet override survives)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete.mockResolvedValueOnce({
      content: "",
      json: { rationale: "ok" },
      tokensInput: 10,
      tokensOutput: 10,
      model: "m",
    });
    mockQuery.mockResolvedValueOnce({ rows: [silver()] });

    await extractAndUpsertPricing(OUTLET_ID);

    const upsert = findUpsertCall();
    expect(upsert![0] as string).not.toContain("sales_multiplier");
  });

  it("retries on malformed JSON then succeeds", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete
      .mockResolvedValueOnce({ content: "bad", json: { amountCents: 1 }, tokensInput: 10, tokensOutput: 5, model: "m" }) // missing rationale → invalid
      .mockResolvedValueOnce({ content: "", json: { rationale: "ok" }, tokensInput: 10, tokensOutput: 5, model: "m" });
    mockQuery.mockResolvedValueOnce({ rows: [silver()] });

    const dto = await extractAndUpsertPricing(OUTLET_ID);
    expect(mockPlatformComplete).toHaveBeenCalledTimes(2);
    expect(dto.outletId).toBe(OUTLET_ID);
  });

  it("throws when the outlet has no bronze notes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(extractAndUpsertPricing(OUTLET_ID)).rejects.toThrow(/No price sources/);
    expect(mockPlatformComplete).not.toHaveBeenCalled();
  });
});

describe("getPublicPricingForOrg", () => {
  it("returns SELL-only DTO (no retail, no multiplier) and is tenant-isolated", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID,
          sell_price_cents: 100000,
          currency: "USD",
          article_type: "sponsored",
          allows_dofollow_backlink: true,
          online_duration_months: 12,
          is_permanent: null,
          conditions_note: null,
        },
      ],
    });

    const dto = await getPublicPricingForOrg(OUTLET_ID, ORG_ID);

    expect(dto).not.toBeNull();
    expect(dto!.sellPriceCents).toBe(100000);
    expect(dto).not.toHaveProperty("amountCents");
    expect(dto).not.toHaveProperty("salesMultiplier");

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("campaign_outlets");
    expect(sql).toContain("co.org_id = $2");
    // Retail must never be selected on the org path
    expect(sql).not.toContain("amount_cents");
  });

  it("returns null when the org does not own the outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPublicPricingForOrg(OUTLET_ID, ORG_ID)).toBeNull();
  });
});

describe("getInternalPricing", () => {
  it("returns the full DTO including retail", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [silver()] });
    const dto = await getInternalPricing(OUTLET_ID);
    expect(dto!.amountCents).toBe(50000);
    expect(dto!.sellPriceCents).toBe(100000);
  });

  it("returns null when no pricing exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getInternalPricing(OUTLET_ID)).toBeNull();
  });
});

describe("broker / source pricing", () => {
  const SOURCE_ID = "33333333-3333-3333-3333-333333333333";
  const O1 = "aaaaaaaa-1111-1111-1111-111111111111";
  const O2 = "bbbbbbbb-2222-2222-2222-222222222222";

  it("extraction context unions direct notes with broker notes covering the outlet", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete.mockResolvedValueOnce({
      content: "",
      json: { rationale: "ok" },
      tokensInput: 10,
      tokensOutput: 5,
      model: "m",
    });
    mockQuery.mockResolvedValueOnce({ rows: [silver()] });

    await extractAndUpsertPricing(OUTLET_ID);

    const bronzeLoadSql = mockQuery.mock.calls[0][0] as string;
    expect(bronzeLoadSql).toContain("WHERE outlet_id = $1");
    expect(bronzeLoadSql).toContain("source_id IN (SELECT source_id FROM source_outlets WHERE outlet_id = $1)");
  });

  it("ensureSource upserts by domain", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: SOURCE_ID, name: "Matrix", domain: "matrixglobalbrands.com", kind: "broker" }],
    });
    const src = await ensureSource("Matrix", "matrixglobalbrands.com");
    expect(src.id).toBe(SOURCE_ID);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO pricing_sources");
    expect(sql).toContain("ON CONFLICT (domain) DO UPDATE");
  });

  it("linkSourceOutlets counts only newly-linked rows", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // O1 inserted
      .mockResolvedValueOnce({ rowCount: 0 }); // O2 already linked
    const linked = await linkSourceOutlets(SOURCE_ID, [O1, O2]);
    expect(linked).toBe(1);
  });

  it("hasPriceSources counts broker coverage, not just direct notes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    expect(await hasPriceSources(O1)).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("source_outlets"); // broker-coverage branch present
  });

  it("hasPriceSources false when neither direct nor broker note exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await hasPriceSources(O1)).toBe(false);
  });

  it("extractForSource fans out extraction over every member outlet", async () => {
    // listSourceOutletIds → 2 outlets
    mockQuery.mockResolvedValueOnce({ rows: [{ outlet_id: O1 }, { outlet_id: O2 }] });
    // O1: bronze load + upsert
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete.mockResolvedValueOnce({ content: "", json: { rationale: "o1" }, tokensInput: 10, tokensOutput: 5, model: "m" });
    mockQuery.mockResolvedValueOnce({ rows: [silver({ outlet_id: O1 })] });
    // O2: bronze load + upsert
    mockQuery.mockResolvedValueOnce({ rows: [bronzeRow] });
    mockPlatformComplete.mockResolvedValueOnce({ content: "", json: { rationale: "o2" }, tokensInput: 10, tokensOutput: 5, model: "m" });
    mockQuery.mockResolvedValueOnce({ rows: [silver({ outlet_id: O2 })] });

    const results = await extractForSource(SOURCE_ID);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.outletId).sort()).toEqual([O1, O2].sort());
    expect(mockPlatformComplete).toHaveBeenCalledTimes(2);
  });
});
