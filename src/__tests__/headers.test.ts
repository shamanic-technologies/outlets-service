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
};

describe("buildServiceHeaders", () => {
  it("always includes all 7 identity headers", () => {
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
    });
  });

  it("forwards multiple brand IDs as CSV", () => {
    const ctx: OrgContext = {
      ...FULL_CTX,
      brandIds: ["brand-1", "brand-2", "brand-3"],
    };
    const h = buildServiceHeaders("sk-test", ctx);
    expect(h["x-brand-id"]).toBe("brand-1,brand-2,brand-3");
  });
});
