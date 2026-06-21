import { describe, it, expect } from "vitest";
import { buildServiceHeaders } from "../services/headers";
import type { OrgContext } from "../middleware/org-context";

const FULL_CTX: OrgContext = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  campaignId: "camp-1",
  brandIds: ["brand-1"],
  featureSlug: "outlets",
  workflowSlug: "discover",
  audienceId: "11111111-2222-3333-4444-555555555555",
};

const BASE_CTX: OrgContext = {
  orgId: "org-1",
  brandIds: [],
};

describe("buildServiceHeaders", () => {
  it("includes all headers when full context provided", () => {
    const h = buildServiceHeaders("sk-test", FULL_CTX);
    expect(h).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-test",
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-campaign-id": "camp-1",
      "x-brand-id": "brand-1",
      "x-feature-slug": "outlets",
      "x-workflow-slug": "discover",
      "x-audience-id": "11111111-2222-3333-4444-555555555555",
    });
  });

  it("forwards x-audience-id when present, omits when absent (cost attribution)", () => {
    const withAudience = buildServiceHeaders("sk-test", {
      orgId: "org-1",
      brandIds: [],
      audienceId: "aud-9",
    });
    expect(withAudience["x-audience-id"]).toBe("aud-9");

    const withoutAudience = buildServiceHeaders("sk-test", BASE_CTX);
    expect(withoutAudience).not.toHaveProperty("x-audience-id");
  });

  it("forwards multiple brand IDs as CSV", () => {
    const ctx: OrgContext = {
      ...FULL_CTX,
      brandIds: ["brand-1", "brand-2", "brand-3"],
    };
    const h = buildServiceHeaders("sk-test", ctx);
    expect(h["x-brand-id"]).toBe("brand-1,brand-2,brand-3");
  });

  it("only includes org-id when no optional headers are present", () => {
    const h = buildServiceHeaders("sk-test", BASE_CTX);
    expect(h).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-test",
      "x-org-id": "org-1",
    });
    expect(h).not.toHaveProperty("x-user-id");
    expect(h).not.toHaveProperty("x-run-id");
    expect(h).not.toHaveProperty("x-campaign-id");
    expect(h).not.toHaveProperty("x-brand-id");
    expect(h).not.toHaveProperty("x-feature-slug");
    expect(h).not.toHaveProperty("x-workflow-slug");
  });

  it("includes only the headers that are set", () => {
    const ctx: OrgContext = {
      orgId: "org-1",
      userId: "user-1",
      campaignId: "camp-1",
      brandIds: [],
    };
    const h = buildServiceHeaders("sk-test", ctx);
    expect(h["x-org-id"]).toBe("org-1");
    expect(h["x-user-id"]).toBe("user-1");
    expect(h["x-campaign-id"]).toBe("camp-1");
    expect(h).not.toHaveProperty("x-run-id");
    expect(h).not.toHaveProperty("x-brand-id");
    expect(h).not.toHaveProperty("x-feature-slug");
    expect(h).not.toHaveProperty("x-workflow-slug");
    expect(h).not.toHaveProperty("x-audience-id");
  });
});
