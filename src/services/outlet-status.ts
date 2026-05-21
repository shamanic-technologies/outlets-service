import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

/** Hybrid status counts — open/served/skipped from outlets-service, email fields from journalists-service. */
export interface StatusCounts {
  open: number;
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

export const ZERO_STATUS_COUNTS: StatusCounts = {
  open: 0, served: 0, skipped: 0,
  contacted: 0, sent: 0, delivered: 0, opened: 0, clicked: 0,
  replied: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0,
  bounced: 0, unsubscribed: 0,
};

/** Count outlet statuses from campaign_outlets matching the given conditions. */
export async function countOutletStatuses(
  queryFn: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>,
  conditions: string[],
  params: unknown[]
): Promise<{ open: number; served: number; skipped: number }> {
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await queryFn(
    `SELECT
      COUNT(*) FILTER (WHERE co.status = 'open')::int AS open_count,
      COUNT(*) FILTER (WHERE co.status = 'served')::int AS served_count,
      COUNT(*) FILTER (WHERE co.status = 'skipped')::int AS skipped_count
     FROM campaign_outlets co
     ${where}`,
    params
  );
  const row = result.rows[0];
  return {
    open: row?.open_count ?? 0,
    served: row?.served_count ?? 0,
    skipped: row?.skipped_count ?? 0,
  };
}

/** Merge outlet-service counts (open/served/skipped) with journalist-service email counts. */
export function mergeStatusCounts(
  outletCounts: { open: number; served: number; skipped: number },
  journalistCounts: Pick<StatusCounts, "contacted" | "sent" | "delivered" | "opened" | "clicked" | "replied" | "repliesPositive" | "repliesNegative" | "repliesNeutral" | "bounced" | "unsubscribed">
): StatusCounts {
  return {
    open: outletCounts.open,
    served: outletCounts.served,
    skipped: outletCounts.skipped,
    contacted: journalistCounts.contacted,
    sent: journalistCounts.sent,
    delivered: journalistCounts.delivered,
    opened: journalistCounts.opened,
    clicked: journalistCounts.clicked,
    replied: journalistCounts.replied,
    repliesPositive: journalistCounts.repliesPositive,
    repliesNegative: journalistCounts.repliesNegative,
    repliesNeutral: journalistCounts.repliesNeutral,
    bounced: journalistCounts.bounced,
    unsubscribed: journalistCounts.unsubscribed,
  };
}

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
