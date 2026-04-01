import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pg", () => ({
  Pool: vi.fn().mockImplementation((opts: { connectionString: string }) => ({
    connectionString: opts.connectionString,
  })),
}));

describe("pool", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets sslmode=verify-full when sslmode=require", async () => {
    vi.doMock("../config", () => ({
      config: {
        databaseUrl:
          "postgresql://user:pass@host.neon.tech/db?sslmode=require",
      },
    }));
    const { pool } = await import("../db/pool");
    const url = new URL((pool as any).connectionString);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("sets sslmode=verify-full when no sslmode present", async () => {
    vi.doMock("../config", () => ({
      config: {
        databaseUrl: "postgresql://user:pass@host.neon.tech/db",
      },
    }));
    const { pool } = await import("../db/pool");
    const url = new URL((pool as any).connectionString);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("overrides sslmode=prefer with verify-full", async () => {
    vi.doMock("../config", () => ({
      config: {
        databaseUrl:
          "postgresql://user:pass@host.neon.tech/db?sslmode=prefer",
      },
    }));
    const { pool } = await import("../db/pool");
    const url = new URL((pool as any).connectionString);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("handles empty database URL gracefully", async () => {
    vi.doMock("../config", () => ({
      config: { databaseUrl: "" },
    }));
    const { pool } = await import("../db/pool");
    expect(pool).toBeDefined();
  });
});
