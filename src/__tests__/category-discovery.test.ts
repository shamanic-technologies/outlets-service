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

import {
  generateCategoryBatch,
  getActiveCategory,
  discoverOutletsInCategory,
  discoverCycle,
  type CampaignCategory,
} from "../services/category-discovery";
import type { FullOrgContext } from "../middleware/org-context";

const CAMPAIGN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CATEGORY_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const ORG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BRAND_ID = "55555555-5555-5555-5555-555555555555";

const ctx: FullOrgContext = {
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

describe("generateCategoryBatch", () => {
  it("generates 10 categories and inserts them", async () => {
    setupBrandMocks();

    // getAllCategories → none yet
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // max batch_number
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 0 }] });
    // max relevance_rank
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 0 }] });

    // LLM returns categories
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", rank: 1, rationale: "Primary target" },
          { name: "SaaS Blogs", geo: "US", rank: 2, rationale: "Niche fit" },
          { name: "Business News", geo: "US", rank: 3, rationale: "Broad reach" },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // 3 INSERTs
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateCategoryBatch(ctx);

    expect(result).toBe(3);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    // Verify INSERT calls include category data
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INTO campaign_categories")
    );
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0][1]).toContain("Tech News");
  });

  it("deduplicates against already-used categories", async () => {
    setupBrandMocks();

    // getAllCategories → already has "Tech News / US"
    mockQuery.mockResolvedValueOnce({
      rows: [{ category_name: "Tech News", category_geo: "US" }],
    });
    // max batch_number
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 1 }] });
    // max relevance_rank
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 10 }] });

    // LLM returns 2 categories, one is a duplicate
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", rank: 1, rationale: "Already used" },
          { name: "HR Trade Publications", geo: "US", rank: 2, rationale: "New" },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Only 1 INSERT (the non-duplicate)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateCategoryBatch(ctx);

    expect(result).toBe(1);
  });

  it("returns 0 when LLM returns invalid JSON", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 0 }] });

    mockChatComplete.mockResolvedValueOnce({
      content: "bad response",
      json: { invalid: true },
      tokensInput: 50,
      tokensOutput: 20,
      model: "flash-lite",
    });

    const result = await generateCategoryBatch(ctx);
    expect(result).toBe(0);
  });
});

describe("getActiveCategory", () => {
  it("returns the lowest-rank active category", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_rank: 1,
        status: "active",
        outlets_found: 5,
        batch_number: 1,
      }],
    });

    const result = await getActiveCategory(CAMPAIGN_ID);

    expect(result).not.toBeNull();
    expect(result!.categoryName).toBe("Tech News");
    expect(result!.relevanceRank).toBe(1);
  });

  it("returns null when all categories are exhausted", async () => {
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
    relevanceRank: 1,
    status: "active",
    outletsFound: 0,
    batchNumber: 1,
  };

  it("generates outlets, validates them, and inserts valid ones", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 3 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Major tech pub" },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Tech culture" },
          { name: "Fake Outlet", domain: "fakeoutlet.xyz", whyRelevant: "Not real" },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Google validation: 2 valid, 1 invalid
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", valid: true },
      { name: "The Verge", domain: "theverge.com", valid: true },
      { name: "Fake Outlet", domain: "fakeoutlet.xyz", valid: false },
    ]);

    // DB inserts (via client)
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets (TechCrunch)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets (The Verge)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter
    mockQuery.mockResolvedValueOnce({});
    // Check if category should be capped
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 2 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(2);
    expect(mockValidateOutletBatch).toHaveBeenCalledTimes(1);
    // Verify validation was called with 3 candidates
    expect(mockValidateOutletBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("marks category exhausted when all outlets fail validation", async () => {
    setupBrandMocks();

    // Get known domains → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Fake 1", domain: "fake1.xyz", whyRelevant: "Not real" },
          { name: "Fake 2", domain: "fake2.xyz", whyRelevant: "Not real" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // All fail validation
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Fake 1", domain: "fake1.xyz", valid: false },
      { name: "Fake 2", domain: "fake2.xyz", valid: false },
    ]);

    // Mark exhausted
    mockQuery.mockResolvedValueOnce({});

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(0);
    // Verify category was marked exhausted
    const exhaustedCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("SET status")
    );
    expect(exhaustedCall).toBeDefined();
    expect(exhaustedCall![1]).toContain("exhausted");
  });

  it("marks category exhausted when all outlets are duplicates", async () => {
    setupBrandMocks();

    // Get known domains → all already known
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    // LLM returns only domains that are already known
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Already known" },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Already known" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // Mark exhausted
    mockQuery.mockResolvedValueOnce({});

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(0);
    // Should NOT have called Google validation (filtered before)
    expect(mockValidateOutletBatch).not.toHaveBeenCalled();
  });

  it("caps category at 100 outlets", async () => {
    setupBrandMocks();

    const almostFullCategory = { ...category, outletsFound: 98 };

    // Get known domains → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 3 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Outlet A", domain: "outleta.com", whyRelevant: "Good" },
          { name: "Outlet B", domain: "outletb.com", whyRelevant: "Good" },
          { name: "Outlet C", domain: "outletc.com", whyRelevant: "Good" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // All valid
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Outlet A", domain: "outleta.com", valid: true },
      { name: "Outlet B", domain: "outletb.com", valid: true },
      { name: "Outlet C", domain: "outletc.com", valid: true },
    ]);

    // DB inserts
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "o1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "o2" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "o3" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found
    mockQuery.mockResolvedValueOnce({});
    // Check cap → 98 + 3 = 101 → should cap
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 101 }] });
    // Mark capped
    mockQuery.mockResolvedValueOnce({});

    const result = await discoverOutletsInCategory(almostFullCategory, ctx);

    expect(result).toBe(3);
    // Verify category was marked capped
    const cappedCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("SET status") && call[1]?.[0] === "capped"
    );
    expect(cappedCall).toBeDefined();
  });
});

describe("discoverCycle", () => {
  it("generates initial categories then discovers outlets in the first one", async () => {
    setupBrandMocks();

    // Check existing categories → none
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "0" }] });

    // generateCategoryBatch:
    // getAllCategories → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // max batch_number
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 0 }] });
    // max rank
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 0 }] });
    // LLM → categories
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", rank: 1, rationale: "Primary" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // INSERT category
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    // getActiveCategory
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_rank: 1,
        status: "active",
        outlets_found: 0,
        batch_number: 1,
      }],
    });

    // discoverOutletsInCategory:
    // brand context (already cached from generateCategoryBatch, but new call)
    setupBrandMocks();
    // known domains → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // LLM → outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Tech news" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // Validation → valid
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", valid: true },
    ]);
    // DB insert
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({}); // COMMIT
    // Update counter
    mockQuery.mockResolvedValueOnce({});
    // Check cap
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] });

    const result = await discoverCycle(ctx);

    expect(result).toBe(1);
    // 2 LLM calls: category generation + outlet generation
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
  });

  it("generates new category batch when all are exhausted", async () => {
    setupBrandMocks();

    // Check existing categories → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "5" }] });
    // getActiveCategory → none active (all exhausted)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // generateCategoryBatch (new batch):
    // getAllCategories → existing exhausted ones
    mockQuery.mockResolvedValueOnce({
      rows: [
        { category_name: "Tech News", category_geo: "US" },
        { category_name: "SaaS Blogs", category_geo: "US" },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 10 }] });
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "HR Trade Publications", geo: "US", rank: 1, rationale: "New category" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT

    // getActiveCategory → the new one
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "HR Trade Publications",
        category_geo: "US",
        relevance_rank: 11,
        status: "active",
        outlets_found: 0,
        batch_number: 2,
      }],
    });

    // discoverOutletsInCategory
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // known domains
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "SHRM", domain: "shrm.org", whyRelevant: "HR professional org" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "SHRM", domain: "shrm.org", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    mockQuery.mockResolvedValueOnce({}); // counter
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] }); // cap check

    const result = await discoverCycle(ctx);

    expect(result).toBe(1);
    // Verify the "already used" categories were passed to the LLM
    const categoryGenCall = mockChatComplete.mock.calls[0][0];
    expect(categoryGenCall.message).toContain("Tech News");
    expect(categoryGenCall.message).toContain("SaaS Blogs");
  });

  it("returns 0 when no new categories can be generated", async () => {
    setupBrandMocks();

    // Check existing → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "10" }] });
    // getActiveCategory → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // generateCategoryBatch → fails
    mockQuery.mockResolvedValueOnce({ rows: [{ category_name: "X", category_geo: "Y" }] }); // existing
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 20 }] });
    mockChatComplete.mockResolvedValueOnce({
      content: "bad",
      json: { invalid: true },
      tokensInput: 50,
      tokensOutput: 20,
      model: "flash-lite",
    });

    const result = await discoverCycle(ctx);
    expect(result).toBe(0);
  });
});
