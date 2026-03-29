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

  it("runs all migration steps in correct order", async () => {
    const { runMigration } = await import("../db/migrate");
    await runMigration();

    // Should be at least 8 calls:
    // 1. enumSetup
    // 2-3. ALTER TYPE ADD VALUE (served, skipped)
    // 4. columnRename
    // 5. migration DDL (first run — creates tables)
    // 6. dedupByDomain
    // 7. switchUniqueConstraint
    // 8. migration DDL (second run — creates unique index on outlet_domain)
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(8);

    // First call: CREATE TYPE enum
    expect(mockQuery.mock.calls[0][0]).toContain("CREATE TYPE outlet_status_enum");

    // Second and third calls: ALTER TYPE ADD VALUE
    expect(mockQuery.mock.calls[1][0]).toContain("ADD VALUE IF NOT EXISTS 'served'");
    expect(mockQuery.mock.calls[2][0]).toContain("ADD VALUE IF NOT EXISTS 'skipped'");

    // Fourth call: column rename
    expect(mockQuery.mock.calls[3][0]).toContain("RENAME COLUMN workflow_name TO workflow_slug");

    // Fifth call: main DDL (tables + indexes)
    const mainDDL = mockQuery.mock.calls[4][0] as string;
    expect(mainDDL).toContain("CREATE TABLE IF NOT EXISTS outlets");
    expect(mainDDL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_outlets_domain");

    // Sixth call: dedup by domain
    const dedupSQL = mockQuery.mock.calls[5][0] as string;
    expect(dedupSQL).toContain("outlet_domain");
    expect(dedupSQL).toContain("GREATEST");

    // Seventh call: switch unique constraint
    const switchSQL = mockQuery.mock.calls[6][0] as string;
    expect(switchSQL).toContain("DROP CONSTRAINT IF EXISTS outlets_outlet_url_key");
    expect(switchSQL).toContain("DROP INDEX IF EXISTS idx_outlets_domain");

    // Eighth call: re-run DDL (creates unique index now that old one is dropped)
    expect(mockQuery.mock.calls[7][0]).toContain("CREATE TABLE IF NOT EXISTS outlets");
  });

  it("outlets table DDL no longer has UNIQUE on outlet_url", async () => {
    const { runMigration } = await import("../db/migrate");
    await runMigration();

    const mainDDL = mockQuery.mock.calls[4][0] as string;
    // outlet_url should NOT be UNIQUE in the DDL
    expect(mainDDL).not.toMatch(/outlet_url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/);
    // outlet_domain index should be UNIQUE
    expect(mainDDL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_outlets_domain ON outlets(outlet_domain)");
  });

  it("ignores duplicate_object errors (42710) from enum additions", async () => {
    const { runMigration } = await import("../db/migrate");

    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // enumSetup
      .mockRejectedValueOnce({ code: "42710" }) // 'served' already exists
      .mockRejectedValueOnce({ code: "42710" }) // 'skipped' already exists
      .mockResolvedValue({ rows: [] }); // all remaining steps

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
