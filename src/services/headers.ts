import type { OrgContext } from "../middleware/org-context";

/**
 * Build standard forwarding headers for downstream service calls.
 * Single source of truth — all service clients must use this.
 */
export function buildServiceHeaders(
  apiKey: string,
  ctx: OrgContext
): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.featureSlug) h["x-feature-slug"] = ctx.featureSlug;
  if (ctx.campaignId) h["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) h["x-brand-id"] = ctx.brandId;
  if (ctx.workflowSlug) h["x-workflow-slug"] = ctx.workflowSlug;
  return h;
}
