import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

/** Cumulative status counts — same shape as journalists-service StatusCounts. */
export interface StatusCounts {
  buffered: number;
  claimed: number;
  served: number;
  skipped: number;
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  bounced: number;
  unsubscribed: number;
}

/** Global email signals per outlet. */
export interface GlobalStatus {
  bounced: number;
  unsubscribed: number;
}

/** Per-outlet status from journalists-service (structured counts). */
export interface OutletStatus {
  totalJournalists: number;
  brand: StatusCounts | null;
  byCampaign: Record<string, StatusCounts> | null;
  campaign: StatusCounts | null;
  global: GlobalStatus;
}

/** Full response from fetchOutletStatuses. */
export interface OutletStatusesResult {
  results: Map<string, OutletStatus>;
  total: number;
  byOutreachStatus: StatusCounts;
}

export interface ScopeFilters {
  campaignId?: string;
  brandId?: string;
}

const ZERO_STATUS_COUNTS: StatusCounts = {
  buffered: 0, claimed: 0, served: 0, skipped: 0,
  contacted: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
  replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0,
  bounced: 0, unsubscribed: 0,
};

/**
 * Fetch outreach statuses from journalists-service.
 * Calls POST /orgs/outlets/status with a batch of outlet IDs and scope filters.
 * Returns per-outlet structured status + aggregate byOutreachStatus.
 */
export async function fetchOutletStatuses(
  outletIds: string[],
  ctx: Pick<OrgContext, "orgId" | "brandIds">,
  scopeFilters: ScopeFilters
): Promise<OutletStatusesResult> {
  const empty: OutletStatusesResult = {
    results: new Map(),
    total: 0,
    byOutreachStatus: { ...ZERO_STATUS_COUNTS },
  };
  if (outletIds.length === 0) return empty;

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
    results: Record<string, OutletStatus>;
    total: number;
    byOutreachStatus: StatusCounts;
  };

  return {
    results: new Map(Object.entries(data.results)),
    total: data.total,
    byOutreachStatus: data.byOutreachStatus,
  };
}
