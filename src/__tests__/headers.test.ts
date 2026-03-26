import { describe, it, expect } from "vitest";
import { buildServiceHeaders } from "../services/headers";
import type { OrgContext } from "../middleware/org-context";

const BASE_CTX: OrgContext = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
};

describe("buildServiceHeaders", () => {
  it("always includes required headers", () => {
    const h = buildServiceHeaders("sk-test", BASE_CTX);
    expect(h).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-test",
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
    });
  });

  it("forwards all optional context headers when present", () => {
    const ctx: OrgContext = {
      ...BASE_CTX,
      featureSlug: "outlets",
      campaignId: "camp-1",
      brandId: "brand-1",
      workflowName: "discover",
    };
    const h = buildServiceHeaders("sk-test", ctx);
    expect(h["x-feature-slug"]).toBe("outlets");
    expect(h["x-campaign-id"]).toBe("camp-1");
    expect(h["x-brand-id"]).toBe("brand-1");
    expect(h["x-workflow-name"]).toBe("discover");
  });

  it("omits optional headers when context values are undefined", () => {
    const h = buildServiceHeaders("sk-test", BASE_CTX);
    expect(h).not.toHaveProperty("x-feature-slug");
    expect(h).not.toHaveProperty("x-campaign-id");
    expect(h).not.toHaveProperty("x-brand-id");
    expect(h).not.toHaveProperty("x-workflow-name");
  });
});
