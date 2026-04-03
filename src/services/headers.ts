import type { OrgContext } from "../middleware/org-context";

/**
 * Build standard forwarding headers for downstream service calls.
 * Single source of truth — all service clients must use this.
 */
export function buildServiceHeaders(
  apiKey: string,
  ctx: OrgContext
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
    "x-campaign-id": ctx.campaignId,
    "x-brand-id": ctx.brandIds.join(","),
    "x-feature-slug": ctx.featureSlug,
    "x-workflow-slug": ctx.workflowSlug,
  };
}
