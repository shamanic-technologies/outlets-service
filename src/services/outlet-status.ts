import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export interface OutletEnrichedStatus {
  status: string;
  replyClassification: "positive" | "negative" | "neutral" | null;
}

/**
 * Fetch enriched outlet statuses from journalists-service.
 * Calls POST /orgs/outlets/status with a batch of outlet IDs.
 * Returns a map of outletId → enriched status.
 */
export async function fetchOutletStatuses(
  outletIds: string[],
  ctx: OrgContext
): Promise<Map<string, OutletEnrichedStatus>> {
  if (outletIds.length === 0) return new Map();

  const headers = buildServiceHeaders(config.journalistsServiceApiKey, ctx);
  console.log("[outlets-service] POST /orgs/outlets/status — forwarding headers:", JSON.stringify(headers));

  let res: Response;
  try {
    res = await fetch(
      `${config.journalistsServiceUrl}/orgs/outlets/status`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ outletIds }),
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
    results: Record<string, OutletEnrichedStatus>;
  };

  console.log("[outlets-service] POST /orgs/outlets/status — response:", JSON.stringify(data));

  return new Map(Object.entries(data.results));
}
