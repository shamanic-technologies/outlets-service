import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrgContext } from "../middleware/org-context";
import type { EditorialEmail } from "../services/editorial-emails";

const mockQuery = vi.fn();
vi.mock("../db/pool", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const mockVerify = vi.fn();
vi.mock("../services/apify", () => ({
  verifyEmails: (...args: unknown[]) => mockVerify(...args),
}));

import { pickDeliverableEmail } from "../services/email-verification";

const ctx: OrgContext = {
  orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  brandIds: [],
};

// Discovery sorts best-first (lowest score first).
function emails(...pairs: [string, number][]): EditorialEmail[] {
  return pairs.map(([email, score]) => ({ email, score, source: "https://x.com/contact" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no cached verdicts.
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("pickDeliverableEmail", () => {
  it("returns the highest-ranked valid candidate", async () => {
    mockVerify.mockResolvedValueOnce(
      new Map([
        ["editor@x.com", "valid"],
        ["info@x.com", "valid"],
      ])
    );

    const chosen = await pickDeliverableEmail(
      "x.com",
      emails(["editor@x.com", 0], ["info@x.com", 5]),
      ctx
    );

    expect(chosen?.email).toBe("editor@x.com");
  });

  it("skips non-valid higher rank, picks the first valid", async () => {
    mockVerify.mockResolvedValueOnce(
      new Map([
        ["catchall@x.com", "catch_all"],
        ["bad@x.com", "invalid"],
        ["real@x.com", "valid"],
      ])
    );

    const chosen = await pickDeliverableEmail(
      "x.com",
      emails(["catchall@x.com", 0], ["bad@x.com", 1], ["real@x.com", 2]),
      ctx
    );

    expect(chosen?.email).toBe("real@x.com");
  });

  it("returns null when no candidate verifies valid", async () => {
    mockVerify.mockResolvedValueOnce(
      new Map([
        ["a@x.com", "catch_all"],
        ["b@x.com", "invalid"],
      ])
    );

    const chosen = await pickDeliverableEmail("x.com", emails(["a@x.com", 0], ["b@x.com", 1]), ctx);
    expect(chosen).toBeNull();
  });

  it("returns null for no candidates without verifying", async () => {
    const chosen = await pickDeliverableEmail("x.com", [], ctx);
    expect(chosen).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("uses a fresh cached verdict and does NOT call apify", async () => {
    // readCachedVerdicts returns the only candidate as cached-valid.
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "cached@x.com", verification_status: "valid" }] });

    const chosen = await pickDeliverableEmail("x.com", emails(["cached@x.com", 0]), ctx);

    expect(chosen?.email).toBe("cached@x.com");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("verifies only the uncached candidates and persists fresh verdicts", async () => {
    // First query (read cache): one cached, one missing.
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "cached@x.com", verification_status: "invalid" }] });
    // Subsequent queries (persist UPDATE) resolve fine.
    mockQuery.mockResolvedValue({ rows: [] });
    mockVerify.mockResolvedValueOnce(new Map([["fresh@x.com", "valid"]]));

    const chosen = await pickDeliverableEmail(
      "x.com",
      emails(["cached@x.com", 0], ["fresh@x.com", 1]),
      ctx
    );

    // apify called only with the uncached address.
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify.mock.calls[0][0]).toEqual(["fresh@x.com"]);
    // chosen = the fresh valid one (cached was invalid).
    expect(chosen?.email).toBe("fresh@x.com");
    // a persist UPDATE ran for the freshly-verified verdict.
    const updateCalls = mockQuery.mock.calls.filter((c) => String(c[0]).includes("UPDATE outlet_editorial_emails"));
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][1]).toEqual([ctx.orgId, "x.com", "fresh@x.com", "valid"]);
  });

  it("propagates a verification error (fail-loud)", async () => {
    mockVerify.mockRejectedValueOnce(new Error("apify down"));
    await expect(pickDeliverableEmail("x.com", emails(["a@x.com", 0]), ctx)).rejects.toThrow("apify down");
  });
});
