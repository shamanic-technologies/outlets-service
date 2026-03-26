import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

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

// In-memory cache: featureInputs never change during a campaign
const featureInputsCache = new Map<string, Record<string, unknown> | null>();

export async function getFeatureInputs(
  campaignId: string,
  ctx: OrgContext
): Promise<Record<string, unknown> | null> {
  const cached = featureInputsCache.get(campaignId);
  if (cached !== undefined) return cached;

  const res = await fetch(`${config.campaignServiceUrl}/campaigns/${campaignId}`, {
    headers: buildServiceHeaders(config.campaignServiceApiKey, ctx),
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
