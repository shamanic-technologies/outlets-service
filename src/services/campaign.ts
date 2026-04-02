import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export interface Campaign {
  id: string;
  orgId: string;
  name: string;
  workflowSlug: string;
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

  let res: Response;
  try {
    res = await fetch(`${config.campaignServiceUrl}/campaigns/${campaignId}`, {
      headers: buildServiceHeaders(config.campaignServiceApiKey, ctx),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] campaign-service /campaigns/${campaignId} timed out after 30s`);
    }
    throw new Error(`[outlets-service] campaign-service /campaigns/${campaignId} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] campaign-service /campaigns/${campaignId} failed (${res.status}): ${body}`);
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
