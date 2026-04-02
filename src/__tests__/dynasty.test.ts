import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: {
    workflowServiceUrl: "http://workflow-service",
    workflowServiceApiKey: "wf-key",
    featuresServiceUrl: "http://features-service",
    featuresServiceApiKey: "feat-key",
  },
}));

import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} from "../services/dynasty";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkflowDynastySlugs", () => {
  it("returns versioned slugs from workflow-service", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] }),
    });

    const result = await resolveWorkflowDynastySlugs("cold-email", "wf-key");
    expect(result).toEqual(["cold-email", "cold-email-v2", "cold-email-v3"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://workflow-service/workflows/dynasty/slugs?dynastySlug=cold-email",
      expect.objectContaining({ headers: { "x-api-key": "wf-key" } })
    );
  });

  it("returns empty array on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await resolveWorkflowDynastySlugs("bad-slug", "wf-key");
    expect(result).toEqual([]);
  });
});

describe("resolveFeatureDynastySlugs", () => {
  it("returns versioned slugs from features-service", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ slugs: ["feat-alpha", "feat-alpha-v2"] }),
    });

    const result = await resolveFeatureDynastySlugs("feat-alpha", "feat-key");
    expect(result).toEqual(["feat-alpha", "feat-alpha-v2"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://features-service/features/dynasty/slugs?dynastySlug=feat-alpha",
      expect.objectContaining({ headers: { "x-api-key": "feat-key" } })
    );
  });

  it("returns empty array on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await resolveFeatureDynastySlugs("missing", "feat-key");
    expect(result).toEqual([]);
  });
});

describe("getWorkflowDynastyMap", () => {
  it("builds reverse map from workflow-service dynasties", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        dynasties: [
          { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
          { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2", "warm-intro-v3"] },
        ],
      }),
    });

    const map = await getWorkflowDynastyMap("wf-key");
    expect(map.get("cold-email")).toBe("cold-email");
    expect(map.get("cold-email-v2")).toBe("cold-email");
    expect(map.get("warm-intro-v3")).toBe("warm-intro");
    expect(map.size).toBe(5);
  });

  it("returns empty map on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    const map = await getWorkflowDynastyMap("wf-key");
    expect(map.size).toBe(0);
  });
});

describe("getFeatureDynastyMap", () => {
  it("builds reverse map from features-service dynasties", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        dynasties: [
          { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
        ],
      }),
    });

    const map = await getFeatureDynastyMap("feat-key");
    expect(map.get("feat-alpha")).toBe("feat-alpha");
    expect(map.get("feat-alpha-v2")).toBe("feat-alpha");
    expect(map.size).toBe(2);
  });
});
