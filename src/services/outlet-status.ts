import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export interface OutletOutreachStatus {
  outreachStatus: string;
  replyClassification: "positive" | "negative" | "neutral" | null;
}

export interface OutletOutreachStatusWithBreakdown extends OutletOutreachStatus {
  byCampaign?: Record<string, OutletOutreachStatus>;
}

export interface ScopeFilters {
  campaignId?: string;
  brandId?: string;
}

/**
 * Fetch outreach statuses from journalists-service.
 * Calls POST /orgs/outlets/status with a batch of outlet IDs and scope filters.
 * Headers are always forwarded for tracing; scoping is done via scopeFilters in the body.
 * Returns a map of outletId → outreach status (with optional byCampaign breakdown).
 */
export async function fetchOutletStatuses(
  outletIds: string[],
  ctx: OrgContext,
  scopeFilters: ScopeFilters
): Promise<Map<string, OutletOutreachStatusWithBreakdown>> {
  if (outletIds.length === 0) return new Map();

  const headers = buildServiceHeaders(config.journalistsServiceApiKey, ctx);

  let res: Response;
  try {
    res = await fetch(
      `${config.journalistsServiceUrl}/orgs/outlets/status`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ outletIds, scopeFilters }),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `[outlets-service] journalists-service /orgs/outlets/status timed out after 30s`
      );
    }
    throw new Error(
      `[outlets-service] journalists-service /orgs/outlets/status fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[outlets-service] journalists-service /orgs/outlets/status failed (${res.status}): ${body}`
    );
  }

  const data = (await res.json()) as {
    results: Record<string, OutletOutreachStatusWithBreakdown>;
  };

  return new Map(Object.entries(data.results));
}
