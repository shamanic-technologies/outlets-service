import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DB pool
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();
const mockClientQuery = vi.fn();

vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: () =>
      mockConnect().then(() => ({
        query: mockClientQuery,
        release: mockRelease,
      })),
  },
}));

// Mock chat service
const mockChatComplete = vi.fn();
vi.mock("../services/chat", () => ({
  chatComplete: (...args: unknown[]) => mockChatComplete(...args),
}));

// Mock google service
const mockValidateOutletBatch = vi.fn();
vi.mock("../services/google", () => ({
  validateOutletBatch: (...args: unknown[]) => mockValidateOutletBatch(...args),
  searchBatch: vi.fn(),
  searchSingle: vi.fn(),
}));

// Mock brand service
const mockExtractFields = vi.fn();
vi.mock("../services/brand", async () => {
  const actual = await vi.importActual("../services/brand");
  return {
    ...actual,
    extractFields: (...args: unknown[]) => mockExtractFields(...args),
  };
});

// Mock campaign service
const mockGetFeatureInputs = vi.fn();
vi.mock("../services/campaign", () => ({
  getFeatureInputs: (...args: unknown[]) => mockGetFeatureInputs(...args),
}));

// Mock journalists service
const mockIsOutletBlocked = vi.fn();
vi.mock("../services/journalists", () => ({
  isOutletBlocked: (...args: unknown[]) => mockIsOutletBlocked(...args),
}));

import {
  generateAllCategories,
  getActiveCategory,
  discoverOutletsInCategory,
  discoverCycle,
  reuseCycle,
  type CampaignCategory,
} from "../services/category-discovery";
import type { OrgContext } from "../middleware/org-context";

const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CATEGORY_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

const ctx: OrgContext = {
  orgId: ORG_ID,
  userId: USER_ID,
  runId: RUN_ID,
  campaignId: CAMPAIGN_ID,
  brandIds: [BRAND_ID],
  featureSlug: "outlets",
  workflowSlug: "discover",
};

const extractFieldsResponse = {
  brand_name: { value: "Acme Corp", byBrand: {} },
  elevator_pitch: { value: "SaaS platform for HR automation", byBrand: {} },
  categories: { value: "HR Tech", byBrand: {} },
  target_geo: { value: "US", byBrand: {} },
  target_audience: { value: "HR directors", byBrand: {} },
  angles: { value: null, byBrand: {} },
};

function setupBrandMocks() {
  mockExtractFields.mockResolvedValue(extractFieldsResponse);
  mockGetFeatureInputs.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
});

describe("generateAllCategories", () => {
  it("generates 100 categories in a single LLM call using Gemini Pro with score field", async () => {
    setupBrandMocks();

    // LLM returns 3 categories (test uses smaller subset for tractability)
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", score: 87, rationale: "Primary target" },
          { name: "SaaS Blogs", geo: "US", score: 65, rationale: "Niche fit" },
          { name: "Business News", geo: "US", score: 42, rationale: "Broad reach" },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "pro",
    });

    // 3 INSERTs
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateAllCategories(ctx);

    expect(result).toBe(3);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);

    // Verify LLM call uses google/pro
    const llmCall = mockChatComplete.mock.calls[0][0];
    expect(llmCall.provider).toBe("google");
    expect(llmCall.model).toBe("pro");

    // Verify responseSchema enforces score (not rank)
    expect(llmCall.responseSchema).toBeDefined();
    expect(llmCall.responseSchema.required).toEqual(["categories"]);
    expect(llmCall.responseSchema.properties.categories.items.required).toEqual([
      "name",
      "geo",
      "score",
      "rationale",
    ]);
    expect(llmCall.responseSchema.properties.categories.items.properties.score.minimum).toBe(0);
    expect(llmCall.responseSchema.properties.categories.items.properties.score.maximum).toBe(100);

    // Verify INSERT uses relevance_score column with category data
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INTO campaign_categories")
    );
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0][0]).toContain("relevance_score");
    expect(insertCalls[0][0]).not.toContain("relevance_rank");
    expect(insertCalls[0][1]).toContain("Tech News");
    expect(insertCalls[0][1]).toContain(87);
  });

  it("dedupes within batch by (name, geo)", async () => {
    setupBrandMocks();

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", score: 80, rationale: "X" },
          { name: "Tech News", geo: "US", score: 60, rationale: "Y" }, // dup
          { name: "Tech News", geo: "UK", score: 70, rationale: "Z" }, // different geo, OK
        ],
      },
      tokensInput: 100,
      tokensOutput: 50,
      model: "pro",
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateAllCategories(ctx);
    expect(result).toBe(2);
  });

  it("retries LLM up to 4 times on invalid JSON then returns 0", async () => {
    setupBrandMocks();

    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad response",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "pro",
      });
    }

    const result = await generateAllCategories(ctx);
    expect(result).toBe(0);
    expect(mockChatComplete).toHaveBeenCalledTimes(4);
  });

  it("succeeds on second attempt after first returns invalid JSON", async () => {
    setupBrandMocks();

    mockChatComplete.mockResolvedValueOnce({
      content: "bad",
      json: { invalid: true },
      tokensInput: 50,
      tokensOutput: 20,
      model: "pro",
    });
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", score: 80, rationale: "OK" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "pro",
    });

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateAllCategories(ctx);
    expect(result).toBe(1);
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
  });
});

describe("getActiveCategory", () => {
  it("returns the highest-scoring active category", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_score: 87,
        status: "active",
        outlets_found: 5,
      }],
    });

    const result = await getActiveCategory(CAMPAIGN_ID);

    expect(result).not.toBeNull();
    expect(result!.categoryName).toBe("Tech News");
    expect(result!.relevanceScore).toBe(87);

    // Verify ORDER BY uses score DESC NULLS LAST, name ASC
    const sql = (mockQuery.mock.calls[0][0] as string).replace(/\s+/g, " ");
    expect(sql).toContain("ORDER BY relevance_score DESC NULLS LAST, category_name ASC");
  });

  it("returns null when no active categories", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getActiveCategory(CAMPAIGN_ID);
    expect(result).toBeNull();
  });
});

describe("discoverOutletsInCategory", () => {
  const category: CampaignCategory = {
    id: CATEGORY_ID,
    campaignId: CAMPAIGN_ID,
    categoryName: "Tech News",
    categoryGeo: "US",
    relevanceScore: 87,
    status: "active",
    outletsFound: 0,
  };

  it("queries knownDomains as UNION of cco and rejected_domains tables", async () => {
    setupBrandMocks();

    // known domains union query
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TC", domain: "tc.com", whyRelevant: "X", relevanceScore: 80 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    // existing in outlets table → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // google validates
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TC", domain: "tc.com", valid: true },
    ]);

    // DB inserts
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] });

    await discoverOutletsInCategory(category, ctx);

    // Verify the knownDomains query is a UNION across cco and rejected_domains
    const knownDomainsQuery = (mockQuery.mock.calls[0][0] as string).replace(/\s+/g, " ");
    expect(knownDomainsQuery).toContain("campaign_category_outlets");
    expect(knownDomainsQuery).toContain("UNION");
    expect(knownDomainsQuery).toContain("campaign_category_rejected_domains");
  });

  it("inserts Google-rejected domains into rejected_domains table", async () => {
    setupBrandMocks();

    // known domains → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Good", domain: "good.com", whyRelevant: "X", relevanceScore: 80 },
          { name: "Bad1", domain: "bad1.xyz", whyRelevant: "Y", relevanceScore: 40 },
          { name: "Bad2", domain: "bad2.xyz", whyRelevant: "Z", relevanceScore: 35 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    // None exist in outlets table → all 3 need validation
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Good", domain: "good.com", valid: true },
      { name: "Bad1", domain: "bad1.xyz", valid: false },
      { name: "Bad2", domain: "bad2.xyz", valid: false },
    ]);

    // 2 INSERTs into rejected_domains for bad1.xyz and bad2.xyz
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    // DB inserts for the 1 valid outlet
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "outlet-good" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result.inserted).toBe(1);
    expect(result.domains).toEqual(["good.com"]);

    // Verify 2 INSERTs into rejected_domains
    const rejectedInserts = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INTO campaign_category_rejected_domains")
    );
    expect(rejectedInserts).toHaveLength(2);
    expect(rejectedInserts[0][1]).toContain("bad1.xyz");
    expect(rejectedInserts[1][1]).toContain("bad2.xyz");
  });

  it("marks category exhausted when all 10 LLM outlets are in known domains (cco OR rejected)", async () => {
    setupBrandMocks();

    // known domains union returns domains that match every LLM suggestion
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "tc.com" },
        { outlet_domain: "verge.com" },
      ],
    });

    // LLM returns outlets that are all already known
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TC", domain: "tc.com", whyRelevant: "Dup", relevanceScore: 80 },
          { name: "Verge", domain: "verge.com", whyRelevant: "Dup", relevanceScore: 70 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    // markCategoryStatus exhausted
    mockQuery.mockResolvedValueOnce({});

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result.inserted).toBe(0);
    expect(mockValidateOutletBatch).not.toHaveBeenCalled();

    const exhaustedCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("SET status")
    );
    expect(exhaustedCall).toBeDefined();
    expect(exhaustedCall![1][0]).toBe("exhausted");
  });

  it("marks category exhausted when all candidates fail Google validation", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Fake 1", domain: "fake1.xyz", whyRelevant: "Not real", relevanceScore: 30 },
          { name: "Fake 2", domain: "fake2.xyz", whyRelevant: "Not real", relevanceScore: 25 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Fake 1", domain: "fake1.xyz", valid: false },
      { name: "Fake 2", domain: "fake2.xyz", valid: false },
    ]);

    // 2 rejected_domain INSERTs
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    // mark exhausted
    mockQuery.mockResolvedValueOnce({});

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result.inserted).toBe(0);
    const exhaustedCall = mockQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("SET status") &&
        call[1]?.[0] === "exhausted"
    );
    expect(exhaustedCall).toBeDefined();
  });

  it("skips Google validation when all candidates are already in outlets table", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "X", relevanceScore: 85 },
          { name: "Verge", domain: "theverge.com", whyRelevant: "Y", relevanceScore: 70 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    // Both already exist in outlets table
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "o1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "o2" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 2 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result.inserted).toBe(2);
    expect(mockValidateOutletBatch).not.toHaveBeenCalled();
  });

  it("inserts outlets sorted by domain to avoid deadlocks", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Z", domain: "zebra.com", whyRelevant: "X", relevanceScore: 80 },
          { name: "A", domain: "alpha.com", whyRelevant: "Y", relevanceScore: 70 },
          { name: "M", domain: "mid.com", whyRelevant: "Z", relevanceScore: 60 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Z", domain: "zebra.com", valid: true },
      { name: "A", domain: "alpha.com", valid: true },
      { name: "M", domain: "mid.com", valid: true },
    ]);

    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "oa" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "om" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "oz" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT

    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 3 }] });

    await discoverOutletsInCategory(category, ctx);

    const insertCalls = mockClientQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO outlets")
    );
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0][1][2]).toBe("alpha.com");
    expect(insertCalls[1][1][2]).toBe("mid.com");
    expect(insertCalls[2][1][2]).toBe("zebra.com");
  });

  it("labels overall_relevance band using RELEVANCE_THRESHOLD (30)", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Three outlets at different score bands:
    //   score 80 → "high" (>= 60)
    //   score 45 → "medium" (>= 30, < 60)
    //   score 22 → "low" (>= 20 acceptance, < 30 relevance)
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "High", domain: "a-high.com", whyRelevant: "X", relevanceScore: 80 },
          { name: "Medium", domain: "b-medium.com", whyRelevant: "Y", relevanceScore: 45 },
          { name: "Low", domain: "c-low.com", whyRelevant: "Z", relevanceScore: 22 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "High", domain: "a-high.com", valid: true },
      { name: "Medium", domain: "b-medium.com", valid: true },
      { name: "Low", domain: "c-low.com", valid: true },
    ]);

    // sorted alphabetically by domain → a-high, b-medium, c-low
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "ohigh" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "omed" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "olow" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT

    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 3 }] });

    await discoverOutletsInCategory(category, ctx);

    const campaignOutletInserts = mockClientQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].includes("INTO campaign_outlets")
    );
    expect(campaignOutletInserts).toHaveLength(3);
    // overall_relevance is positional param $11 → index 10 in params array
    expect(campaignOutletInserts[0][1][10]).toBe("high");
    expect(campaignOutletInserts[1][1][10]).toBe("medium");
    expect(campaignOutletInserts[2][1][10]).toBe("low");
  });

  it("caps category at 100 outlets", async () => {
    setupBrandMocks();
    const almostFullCategory = { ...category, outletsFound: 98 };

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "A", domain: "a.com", whyRelevant: "Good", relevanceScore: 75 },
          { name: "B", domain: "b.com", whyRelevant: "Good", relevanceScore: 60 },
          { name: "C", domain: "c.com", whyRelevant: "Good", relevanceScore: 55 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "A", domain: "a.com", valid: true },
      { name: "B", domain: "b.com", valid: true },
      { name: "C", domain: "c.com", valid: true },
    ]);

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "o1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "o2" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "o3" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    mockQuery.mockResolvedValueOnce({}); // outlets_found update
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 101 }] }); // cap check
    mockQuery.mockResolvedValueOnce({}); // mark capped

    const result = await discoverOutletsInCategory(almostFullCategory, ctx);

    expect(result.inserted).toBe(3);
    const cappedCall = mockQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("SET status") &&
        call[1]?.[0] === "capped"
    );
    expect(cappedCall).toBeDefined();
  });
});

describe("discoverCycle", () => {
  it("generates 100 categories once then discovers outlets in the highest-scoring one", async () => {
    setupBrandMocks();

    // No existing categories
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "0" }] });

    // generateAllCategories LLM call
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", score: 87, rationale: "Primary" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "pro",
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT category

    // getActiveCategory returns the just-inserted category
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_score: 87,
        status: "active",
        outlets_found: 0,
      }],
    });

    // discoverOutletsInCategory pipeline
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // known domains union
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Tech news", relevanceScore: 88 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // existing outlets
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({}); // counter
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] }); // cap check

    const result = await discoverCycle(ctx);

    expect(result.inserted).toBe(1);
    expect(result.domains).toEqual(["techcrunch.com"]);
    // Exactly 2 LLM calls: 1 for category gen (pro) + 1 for outlet gen (flash)
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    expect(mockChatComplete.mock.calls[0][0].model).toBe("pro");
    expect(mockChatComplete.mock.calls[1][0].model).toBe("flash");
  });

  it("returns 0 when all categories are exhausted (no regeneration)", async () => {
    setupBrandMocks();

    // Categories exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "100" }] });
    // getActiveCategory → none active (all exhausted/capped)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await discoverCycle(ctx);

    expect(result.inserted).toBe(0);
    // No LLM call — no regeneration
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  it("loops to the next category when current one is exhausted", async () => {
    setupBrandMocks();

    // Categories exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "10" }] });

    // First active category
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_score: 90,
        status: "active",
        outlets_found: 50,
      }],
    });

    // discoverOutletsInCategory exhausts (all dups)
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlet_domain: "techcrunch.com" }],
    });
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Dup", relevanceScore: 80 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });
    mockQuery.mockResolvedValueOnce({}); // mark exhausted

    // Loop iteration 2: next category
    const CATEGORY_ID_2 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID_2,
        campaign_id: CAMPAIGN_ID,
        category_name: "SaaS Blogs",
        category_geo: "US",
        relevance_score: 80,
        status: "active",
        outlets_found: 0,
      }],
    });

    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // known domains
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "SaaStr", domain: "saastr.com", whyRelevant: "Good", relevanceScore: 78 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // existing outlets
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "SaaStr", domain: "saastr.com", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "outlet-s" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] });

    const result = await discoverCycle(ctx);
    expect(result.inserted).toBe(1);
  });

  it("returns 0 when initial category generation fails", async () => {
    setupBrandMocks();

    // No existing categories
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "0" }] });

    // generateAllCategories LLM fails all 4 attempts
    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "pro",
      });
    }

    const result = await discoverCycle(ctx);
    expect(result.inserted).toBe(0);
  });
});

describe("reuseCycle", () => {
  const OUTLET_ID_1 = "11111111-1111-1111-1111-111111111111";
  const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";
  const OUTLET_ID_3 = "33333333-3333-3333-3333-333333333333";

  it("returns 0 when no reusable outlets exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await reuseCycle(ctx);
    expect(result).toBe(0);
    expect(mockIsOutletBlocked).not.toHaveBeenCalled();
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  it("inserts blocked outlets as skipped without calling LLM", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          outlet_id: OUTLET_ID_1,
          outlet_name: "Blocked",
          outlet_domain: "blocked.com",
          why_relevant: "Strong vertical fit",
          why_not_relevant: "Small audience",
          relevance_score: "88.00",
          overall_relevance: "high",
          relevance_rationale: "Previous campaign assessment",
        },
        {
          outlet_id: OUTLET_ID_2,
          outlet_name: "Also Blocked",
          outlet_domain: "alsoblocked.com",
          why_relevant: "Relevant niche readership",
          why_not_relevant: "Lower DR",
          relevance_score: "72.00",
          overall_relevance: null,
          relevance_rationale: null,
        },
      ],
    });

    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reuseCycle(ctx);

    expect(result).toBe(2);
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(2);
    expect(mockChatComplete).not.toHaveBeenCalled();
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO campaign_outlets")
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][0]).toContain("'skipped'");
    expect(insertCalls[0][1][6]).toBe("Strong vertical fit");
    expect(insertCalls[0][1][7]).toBe("Small audience");
    expect(insertCalls[0][1][8]).toBe(88);
    expect(insertCalls[0][1][10]).toBe("high");
    expect(insertCalls[0][1][11]).toBe("Previous campaign assessment");
    expect(insertCalls[1][1][8]).toBe(72);
    expect(insertCalls[1][1][10]).toBe("high");
    expect(insertCalls[0][1][7]).not.toContain("Blocked");
  });

  it("scores non-blocked outlets via LLM and inserts all", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_id: OUTLET_ID_1, outlet_name: "Blocked", outlet_domain: "blocked.com" },
        { outlet_id: OUTLET_ID_2, outlet_name: "Good", outlet_domain: "good.com" },
        { outlet_id: OUTLET_ID_3, outlet_name: "Great", outlet_domain: "great.com" },
      ],
    });

    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // blocked insert

    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { outletId: OUTLET_ID_2, relevanceScore: 75, whyRelevant: "Good fit" },
          { outletId: OUTLET_ID_3, relevanceScore: 15, whyRelevant: "Not great" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash",
    });

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reuseCycle(ctx);

    expect(result).toBe(3);
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(3);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);

    const llmCall = mockChatComplete.mock.calls[0][0];
    expect(llmCall.message).toContain("Good");
    expect(llmCall.message).toContain("Great");
    expect(llmCall.message).not.toContain("Blocked");
    expect(llmCall.responseSchema).toBeDefined();
    expect(llmCall.responseSchema.required).toEqual(["outlets"]);
    expect(llmCall.responseSchema.properties.outlets.items.required).toEqual([
      "outletId",
      "relevanceScore",
      "whyRelevant",
    ]);
  });

  it("inserts with default score 50 when LLM fails", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({
      rows: [{ outlet_id: OUTLET_ID_1, outlet_name: "Some", outlet_domain: "some.com" }],
    });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "flash",
      });
    }

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reuseCycle(ctx);

    expect(result).toBe(1);
    const insertCall = mockQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO campaign_outlets") &&
        call[0].includes("'open'")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][8]).toBe(50);
  });
});
