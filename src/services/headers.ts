import type { OrgContext } from "../middleware/org-context";

/**
 * Build standard forwarding headers for downstream service calls.
 * Single source of truth — all service clients must use this.
 * Only includes workflow headers when present in the context.
 */
export function buildServiceHeaders(
  apiKey: string,
  ctx: OrgContext
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandIds.length > 0) headers["x-brand-id"] = ctx.brandIds.join(",");
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  return headers;
}
