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
  generateCategoryBatch,
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

  it("retries LLM up to 4 times on invalid JSON then returns 0", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 0 }] });

    // All 4 attempts (1 + 3 retries) return invalid JSON
    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad response",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "flash-lite",
      });
    }

    const result = await generateCategoryBatch(ctx);
    expect(result).toBe(0);
    expect(mockChatComplete).toHaveBeenCalledTimes(4);
  });

  it("succeeds on second LLM attempt after first returns invalid JSON", async () => {
    setupBrandMocks();

    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 0 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 0 }] });

    // First attempt → invalid
    mockChatComplete.mockResolvedValueOnce({
      content: "bad",
      json: { invalid: true },
      tokensInput: 50,
      tokensOutput: 20,
      model: "flash-lite",
    });
    // Second attempt → valid
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "Tech News", geo: "US", rank: 1, rationale: "Good" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // INSERT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await generateCategoryBatch(ctx);
    expect(result).toBe(1);
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
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

  it("generates outlets, validates new ones via Google, and inserts valid ones", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 3 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Major tech pub", relevanceScore: 85 },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Tech culture", relevanceScore: 62 },
          { name: "Fake Outlet", domain: "fakeoutlet.xyz", whyRelevant: "Not real", relevanceScore: 40 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Check which domains already exist in outlets table → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Google validation: 2 valid, 1 invalid (all 3 need validation since none are known)
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", valid: true },
      { name: "The Verge", domain: "theverge.com", valid: true },
      { name: "Fake Outlet", domain: "fakeoutlet.xyz", valid: false },
    ]);

    // DB inserts (via client)
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets (TechCrunch)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets (The Verge)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter
    mockQuery.mockResolvedValueOnce({});
    // Check if category should be capped
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 2 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(2);
    expect(mockValidateOutletBatch).toHaveBeenCalledTimes(1);
    // Verify validation was called with all 3 candidates (none were pre-known)
    expect(mockValidateOutletBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("inserts outlets sorted by domain to prevent deadlocks under concurrency", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns outlets in NON-alphabetical domain order (z before a)
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Zebra News", domain: "zebranews.com", whyRelevant: "Z outlet", relevanceScore: 80 },
          { name: "Alpha Daily", domain: "alphadaily.com", whyRelevant: "A outlet", relevanceScore: 70 },
          { name: "Middle Post", domain: "middlepost.com", whyRelevant: "M outlet", relevanceScore: 60 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Check existing outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Google validation: all valid
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Zebra News", domain: "zebranews.com", valid: true },
      { name: "Alpha Daily", domain: "alphadaily.com", valid: true },
      { name: "Middle Post", domain: "middlepost.com", valid: true },
    ]);

    // DB inserts (via client) — 3 outlets, each with 3 queries + BEGIN/COMMIT
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-a" }] }) // INSERT outlets (alphadaily.com — sorted first)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "outlet-m" }] }) // INSERT outlets (middlepost.com — sorted second)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "outlet-z" }] }) // INSERT outlets (zebranews.com — sorted third)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter
    mockQuery.mockResolvedValueOnce({});
    // Check if category should be capped
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 3 }] });

    await discoverOutletsInCategory(category, ctx);

    // Verify inserts happen in alphabetical domain order (prevents deadlocks)
    const insertCalls = mockClientQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO outlets")
    );
    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0][1][2]).toBe("alphadaily.com");  // domain param is $3
    expect(insertCalls[1][1][2]).toBe("middlepost.com");
    expect(insertCalls[2][1][2]).toBe("zebranews.com");
  });

  it("skips Google validation for outlets already in outlets table", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 3 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Major tech pub", relevanceScore: 85 },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Tech culture", relevanceScore: 62 },
          { name: "New Outlet", domain: "newoutlet.com", whyRelevant: "Fresh", relevanceScore: 50 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Check existing outlets → TechCrunch and The Verge already exist
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    // Google validation: only called for newoutlet.com (the truly new one)
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "New Outlet", domain: "newoutlet.com", valid: true },
    ]);

    // DB inserts: 3 outlets (2 already validated + 1 Google-validated)
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      // TechCrunch (already validated)
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      // The Verge (already validated)
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      // New Outlet (Google-validated)
      .mockResolvedValueOnce({ rows: [{ id: "outlet-3" }] }) // INSERT outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter
    mockQuery.mockResolvedValueOnce({});
    // Check cap
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 3 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(3);
    // Google validation should only be called with 1 candidate (newoutlet.com)
    expect(mockValidateOutletBatch).toHaveBeenCalledTimes(1);
    expect(mockValidateOutletBatch.mock.calls[0][0]).toHaveLength(1);
    expect(mockValidateOutletBatch.mock.calls[0][0][0].domain).toBe("newoutlet.com");
  });

  it("returns 0 when campaign_outlets conflicts even if campaign_category_outlets succeeds", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 2 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Tech pub", relevanceScore: 85 },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Tech culture", relevanceScore: 62 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Both already exist in outlets table (skip Google)
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    // DB inserts: campaign_category_outlets succeeds, campaign_outlets conflicts (already in campaign)
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets (upsert)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets → SUCCESS
      .mockResolvedValueOnce({ rowCount: 0 }) // INSERT campaign_outlets → CONFLICT (already in campaign)
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets (upsert)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets → SUCCESS
      .mockResolvedValueOnce({ rowCount: 0 }) // INSERT campaign_outlets → CONFLICT (already in campaign)
      .mockResolvedValueOnce({}); // COMMIT

    // Check cap (no outlets_found update since inserted=0)
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 2 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    // Returns 0 — nothing was added to the campaign buffer
    expect(result).toBe(0);
    expect(mockValidateOutletBatch).not.toHaveBeenCalled();
  });

  it("counts only campaign_outlets inserts, not campaign_category_outlets", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns 2 outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Tech pub", relevanceScore: 85 },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Tech culture", relevanceScore: 62 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Both already exist in outlets table (skip Google)
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    // DB inserts: both campaign_category_outlets succeed, only 1 campaign_outlets succeeds
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets (upsert)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets → SUCCESS
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets → SUCCESS
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets (upsert)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets → SUCCESS
      .mockResolvedValueOnce({ rowCount: 0 }) // INSERT campaign_outlets → CONFLICT
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter (1 inserted)
    mockQuery.mockResolvedValueOnce({});
    // Check cap
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 3 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    // Returns 1 — only the outlet that was actually added to the buffer
    expect(result).toBe(1);
  });

  it("stores per-outlet relevanceScore from LLM instead of flat category-rank score", async () => {
    setupBrandMocks();

    // Get known domains for category → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // LLM returns outlets with distinct relevance scores
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Perfect audience fit", relevanceScore: 92 },
          { name: "Niche Blog", domain: "nicheblog.io", whyRelevant: "Tangential coverage", relevanceScore: 45 },
        ],
      },
      tokensInput: 200,
      tokensOutput: 150,
      model: "flash-lite",
    });

    // Neither exists in outlets table
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Both pass validation
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", relevanceScore: 92, valid: true },
      { name: "Niche Blog", domain: "nicheblog.io", relevanceScore: 45, valid: true },
    ]);

    // DB inserts (sorted by domain: nicheblog.io < techcrunch.com)
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-2" }] }) // INSERT outlets (nicheblog.io — sorted first)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets (techcrunch.com — sorted second)
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT

    // Update outlets_found counter
    mockQuery.mockResolvedValueOnce({});
    // Check cap
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 2 }] });

    const result = await discoverOutletsInCategory(category, ctx);

    expect(result).toBe(2);

    // Extract the campaign_outlets INSERT calls
    const campaignOutletInserts = mockClientQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INTO campaign_outlets")
    );
    expect(campaignOutletInserts).toHaveLength(2);

    // First insert is nicheblog.io (sorted first) with relevanceScore 45
    expect(campaignOutletInserts[0][1][8]).toBe(45);
    // Second insert is techcrunch.com (sorted second) with relevanceScore 92
    expect(campaignOutletInserts[1][1][8]).toBe(92);
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
          { name: "Fake 1", domain: "fake1.xyz", whyRelevant: "Not real", relevanceScore: 30 },
          { name: "Fake 2", domain: "fake2.xyz", whyRelevant: "Not real", relevanceScore: 25 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // Neither exists in outlets table
    mockQuery.mockResolvedValueOnce({ rows: [] });

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

    // Get known domains → all already known in this category
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_domain: "techcrunch.com" },
        { outlet_domain: "theverge.com" },
      ],
    });

    // LLM returns only domains that are already known in this category
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Already known", relevanceScore: 80 },
          { name: "The Verge", domain: "theverge.com", whyRelevant: "Already known", relevanceScore: 70 },
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
          { name: "Outlet A", domain: "outleta.com", whyRelevant: "Good", relevanceScore: 75 },
          { name: "Outlet B", domain: "outletb.com", whyRelevant: "Good", relevanceScore: 60 },
          { name: "Outlet C", domain: "outletc.com", whyRelevant: "Good", relevanceScore: 55 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // None exist in outlets table
    mockQuery.mockResolvedValueOnce({ rows: [] });

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
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "o2" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
      .mockResolvedValueOnce({ rows: [{ id: "o3" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
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
          { name: "TechCrunch", domain: "techcrunch.com", whyRelevant: "Tech news", relevanceScore: 88 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // Check existing outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Validation → valid
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "TechCrunch", domain: "techcrunch.com", valid: true },
    ]);
    // DB insert
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] }) // INSERT outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // INSERT campaign_outlets
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
    // Cap check → under limit
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "5" }] });

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
          { name: "SHRM", domain: "shrm.org", whyRelevant: "HR professional org", relevanceScore: 72 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // Check existing outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "SHRM", domain: "shrm.org", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT
    mockQuery.mockResolvedValueOnce({}); // counter
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] }); // cap check

    const result = await discoverCycle(ctx);

    expect(result).toBe(1);
    // Verify the "already used" categories were passed to the LLM
    const categoryGenCall = mockChatComplete.mock.calls[0][0];
    expect(categoryGenCall.message).toContain("Tech News");
    expect(categoryGenCall.message).toContain("SaaS Blogs");
  });

  it("loops to the next category when current one is exhausted", async () => {
    setupBrandMocks();

    // Check existing categories → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "5" }] });

    // getActiveCategory → first active category
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Tech News",
        category_geo: "US",
        relevance_rank: 1,
        status: "active",
        outlets_found: 50,
        batch_number: 1,
      }],
    });

    // discoverOutletsInCategory for "Tech News" → all duplicates, returns 0
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlet_domain: "techcrunch.com" }, { outlet_domain: "theverge.com" }],
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
      model: "flash-lite",
    });
    // markCategoryStatus → exhausted
    mockQuery.mockResolvedValueOnce({});

    // Loop iteration 2: getActiveCategory → second category
    const CATEGORY_ID_2 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID_2,
        campaign_id: CAMPAIGN_ID,
        category_name: "SaaS Blogs",
        category_geo: "US",
        relevance_rank: 2,
        status: "active",
        outlets_found: 0,
        batch_number: 1,
      }],
    });

    // discoverOutletsInCategory for "SaaS Blogs" → finds 1 outlet
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // known domains
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "SaaStr", domain: "saastr.com", whyRelevant: "SaaS community", relevanceScore: 78 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // Check existing outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "SaaStr", domain: "saastr.com", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-1" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT
    mockQuery.mockResolvedValueOnce({}); // counter
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] }); // cap check

    const result = await discoverCycle(ctx);

    expect(result).toBe(1);
    // Should have called chatComplete twice: once for exhausted category, once for successful one
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
  });

  it("generates new batch and continues when all categories exhausted during loop", async () => {
    setupBrandMocks();

    // Check existing categories → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "2" }] });

    // getActiveCategory → only one left, it's active
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CATEGORY_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "Last Category",
        category_geo: "US",
        relevance_rank: 2,
        status: "active",
        outlets_found: 20,
        batch_number: 1,
      }],
    });

    // discoverOutletsInCategory → all duplicates → exhausted → returns 0
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlet_domain: "example.com" }],
    });
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Example", domain: "example.com", whyRelevant: "Dup", relevanceScore: 70 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    mockQuery.mockResolvedValueOnce({}); // markCategoryStatus exhausted

    // Loop iteration 2: getActiveCategory → none (all exhausted now)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Cap check → under limit
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "2" }] });

    // generateCategoryBatch triggered
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { category_name: "Last Category", category_geo: "US" },
        { category_name: "Other", category_geo: "US" },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 2 }] });
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        categories: [
          { name: "New Niche", geo: "US", rank: 1, rationale: "Fresh" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT category

    // getActiveCategory → the new category
    const NEW_CAT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: NEW_CAT_ID,
        campaign_id: CAMPAIGN_ID,
        category_name: "New Niche",
        category_geo: "US",
        relevance_rank: 3,
        status: "active",
        outlets_found: 0,
        batch_number: 2,
      }],
    });

    // discoverOutletsInCategory for "New Niche" → finds 1 outlet
    setupBrandMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // known domains
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { name: "Niche Pub", domain: "nichepub.com", whyRelevant: "Perfect", relevanceScore: 85 },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });
    // Check existing outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockValidateOutletBatch.mockResolvedValueOnce([
      { name: "Niche Pub", domain: "nichepub.com", valid: true },
    ]);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "outlet-new" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_category_outlets
      .mockResolvedValueOnce({ rowCount: 1 }) // campaign_outlets
      .mockResolvedValueOnce({}); // COMMIT
    mockQuery.mockResolvedValueOnce({}); // counter
    mockQuery.mockResolvedValueOnce({ rows: [{ outlets_found: 1 }] }); // cap check

    const result = await discoverCycle(ctx);

    expect(result).toBe(1);
  });

  it("returns 0 when campaign reaches 100-category cap", async () => {
    setupBrandMocks();

    // Check existing categories → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "100" }] });

    // getActiveCategory → none active (all exhausted)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // COUNT check for cap → 100 categories already
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "100" }] });

    const result = await discoverCycle(ctx);

    expect(result).toBe(0);
    // Should NOT have called chatComplete — stopped at cap check
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  it("returns 0 when no new categories can be generated (LLM fails after retries)", async () => {
    setupBrandMocks();

    // Check existing → some exist
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "10" }] });
    // getActiveCategory → none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Cap check → under limit
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "10" }] });

    // generateCategoryBatch → all 4 LLM attempts fail
    mockQuery.mockResolvedValueOnce({ rows: [{ category_name: "X", category_geo: "Y" }] }); // existing
    mockQuery.mockResolvedValueOnce({ rows: [{ max_batch: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ max_rank: 20 }] });
    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "flash-lite",
      });
    }

    const result = await discoverCycle(ctx);
    expect(result).toBe(0);
  });
});

describe("reuseCycle", () => {
  const OUTLET_ID_1 = "11111111-1111-1111-1111-111111111111";
  const OUTLET_ID_2 = "22222222-2222-2222-2222-222222222222";
  const OUTLET_ID_3 = "33333333-3333-3333-3333-333333333333";

  it("returns 0 when no reusable outlets exist", async () => {
    // Query for reusable outlets → none
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await reuseCycle(ctx);
    expect(result).toBe(0);
    expect(mockIsOutletBlocked).not.toHaveBeenCalled();
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  it("inserts blocked outlets as skipped without calling LLM", async () => {
    // Query for reusable outlets → 2 found
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_id: OUTLET_ID_1, outlet_name: "Blocked Outlet", outlet_domain: "blocked.com" },
        { outlet_id: OUTLET_ID_2, outlet_name: "Also Blocked", outlet_domain: "alsoblocked.com" },
      ],
    });

    // Both blocked
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });

    // INSERT skipped for each
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // outlet 1
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // outlet 2

    const result = await reuseCycle(ctx);

    expect(result).toBe(2);
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(2);
    // LLM should NOT have been called — all blocked
    expect(mockChatComplete).not.toHaveBeenCalled();
    // Verify skipped status in INSERT
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO campaign_outlets")
    );
    expect(insertCalls).toHaveLength(2);
    // Status is 'skipped' (10th positional param in VALUES)
    expect(insertCalls[0][0]).toContain("'skipped'");
  });

  it("scores non-blocked outlets via LLM and inserts all", async () => {
    setupBrandMocks();

    // Query for reusable outlets → 3 found
    mockQuery.mockResolvedValueOnce({
      rows: [
        { outlet_id: OUTLET_ID_1, outlet_name: "Blocked One", outlet_domain: "blocked.com" },
        { outlet_id: OUTLET_ID_2, outlet_name: "Good Outlet", outlet_domain: "good.com" },
        { outlet_id: OUTLET_ID_3, outlet_name: "Great Outlet", outlet_domain: "great.com" },
      ],
    });

    // 1 blocked, 2 not
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: true });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    // INSERT skipped for blocked outlet
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    // LLM scores the 2 non-blocked outlets
    mockChatComplete.mockResolvedValueOnce({
      content: "",
      json: {
        outlets: [
          { outletId: OUTLET_ID_2, relevanceScore: 75, whyRelevant: "Good fit" },
          { outletId: OUTLET_ID_3, relevanceScore: 15, whyRelevant: "Not great fit" },
        ],
      },
      tokensInput: 100,
      tokensOutput: 80,
      model: "flash-lite",
    });

    // INSERT open for each scored outlet
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // outlet 2
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // outlet 3

    const result = await reuseCycle(ctx);

    expect(result).toBe(3); // 1 blocked + 2 scored = 3 total
    expect(mockIsOutletBlocked).toHaveBeenCalledTimes(3);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);

    // Verify LLM was only called with the 2 non-blocked outlets
    const llmCall = mockChatComplete.mock.calls[0][0];
    expect(llmCall.message).toContain("Good Outlet");
    expect(llmCall.message).toContain("Great Outlet");
    expect(llmCall.message).not.toContain("Blocked One");
  });

  it("inserts with default score 50 when LLM fails", async () => {
    setupBrandMocks();

    // Query for reusable outlets → 1 found, not blocked
    mockQuery.mockResolvedValueOnce({
      rows: [{ outlet_id: OUTLET_ID_1, outlet_name: "Some Outlet", outlet_domain: "some.com" }],
    });
    mockIsOutletBlocked.mockResolvedValueOnce({ blocked: false });

    // LLM fails all retries (4 attempts)
    for (let i = 0; i < 4; i++) {
      mockChatComplete.mockResolvedValueOnce({
        content: "bad",
        json: { invalid: true },
        tokensInput: 50,
        tokensOutput: 20,
        model: "flash-lite",
      });
    }

    // INSERT with default score
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await reuseCycle(ctx);

    expect(result).toBe(1);
    // Verify default score 50 was used
    const insertCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO campaign_outlets") && call[0].includes("'open'")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][8]).toBe(50); // relevance_score param
  });
});
