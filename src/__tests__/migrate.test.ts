import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db/pool", () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    end: vi.fn(),
  },
}));

describe("runMigration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("runs enum setup, enum additions, and DDL as separate queries", async () => {
    const { runMigration } = await import("../db/migrate");
    await runMigration();

    // Should be at least 4 calls: enumSetup, 2x ALTER TYPE, migration DDL
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(4);

    // First call: CREATE TYPE enum
    expect(mockQuery.mock.calls[0][0]).toContain("CREATE TYPE outlet_status_enum");

    // Second and third calls: ALTER TYPE ADD VALUE (separate queries, not in a transaction)
    expect(mockQuery.mock.calls[1][0]).toContain("ADD VALUE IF NOT EXISTS 'served'");
    expect(mockQuery.mock.calls[2][0]).toContain("ADD VALUE IF NOT EXISTS 'skipped'");

    // Fourth call: main DDL (tables + indexes)
    expect(mockQuery.mock.calls[3][0]).toContain("CREATE TABLE IF NOT EXISTS outlets");

    // Verify enum ADD VALUE is NOT bundled into the main migration string
    const mainMigration = mockQuery.mock.calls[3][0] as string;
    expect(mainMigration).not.toContain("ADD VALUE");
  });

  it("ignores duplicate_object errors (42710) from enum additions", async () => {
    const { runMigration } = await import("../db/migrate");

    // Simulate enum values already existing
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // enumSetup
      .mockRejectedValueOnce({ code: "42710" }) // 'served' already exists
      .mockRejectedValueOnce({ code: "42710" }) // 'skipped' already exists
      .mockResolvedValueOnce({ rows: [] }); // migration DDL

    await expect(runMigration()).resolves.toBeUndefined();
  });

  it("rethrows non-duplicate errors from enum additions", async () => {
    const { runMigration } = await import("../db/migrate");

    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // enumSetup
      .mockRejectedValueOnce({ code: "42P01", message: "connection refused" }); // unexpected error

    await expect(runMigration()).rejects.toEqual(
      expect.objectContaining({ code: "42P01" })
    );
  });
});
