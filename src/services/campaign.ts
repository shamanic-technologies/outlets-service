import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";

export interface Campaign {
  id: string;
  orgId: string;
  name: string;
  workflowName: string;
  brandId: string | null;
  featureSlug: string | null;
  featureInputs: Record<string, unknown> | null;
  status: string;
}

function buildHeaders(ctx: OrgContext): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.campaignServiceApiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.featureSlug) h["x-feature-slug"] = ctx.featureSlug;
  if (ctx.campaignId) h["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) h["x-brand-id"] = ctx.brandId;
  if (ctx.workflowName) h["x-workflow-name"] = ctx.workflowName;
  return h;
}

// In-memory cache: featureInputs never change during a campaign
const featureInputsCache = new Map<string, Record<string, unknown> | null>();

export async function getFeatureInputs(
  campaignId: string,
  ctx: OrgContext
): Promise<Record<string, unknown> | null> {
  const cached = featureInputsCache.get(campaignId);
  if (cached !== undefined) return cached;

  const res = await fetch(`${config.campaignServiceUrl}/campaigns/${campaignId}`, {
    headers: buildHeaders(ctx),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`campaign-service /campaigns/${campaignId} failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { campaign: Campaign };
  const featureInputs = data.campaign.featureInputs ?? null;
  featureInputsCache.set(campaignId, featureInputs);
  return featureInputs;
}

/** Clear cache — useful for testing */
export function clearFeatureInputsCache(): void {
  featureInputsCache.clear();
}
