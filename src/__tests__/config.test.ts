import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("prefers OUTLETS_SERVICE_DATABASE_URL over DATABASE_URL", async () => {
    process.env.OUTLETS_SERVICE_DATABASE_URL = "postgresql://outlets-service-url";
    process.env.DATABASE_URL = "postgresql://generic-url";

    const { config } = await import("../config");
    expect(config.databaseUrl).toBe("postgresql://outlets-service-url");
  });

  it("falls back to DATABASE_URL when OUTLETS_SERVICE_DATABASE_URL is not set", async () => {
    delete process.env.OUTLETS_SERVICE_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://generic-url";

    const { config } = await import("../config");
    expect(config.databaseUrl).toBe("postgresql://generic-url");
  });

  it("defaults to empty string when neither env var is set", async () => {
    delete process.env.OUTLETS_SERVICE_DATABASE_URL;
    delete process.env.DATABASE_URL;

    const { config } = await import("../config");
    expect(config.databaseUrl).toBe("");
  });
});
