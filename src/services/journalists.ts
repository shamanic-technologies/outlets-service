import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

interface OutletBlockedResponse {
  blocked: boolean;
  reason?: string;
}

/**
 * Check if an outlet is blocked via journalists-service.
 * An outlet is blocked if at least one journalist was contacted
 * and the cooldown hasn't expired.
 */
export async function isOutletBlocked(
  outletId: string,
  ctx: OrgContext
): Promise<OutletBlockedResponse> {
  const params = new URLSearchParams({
    org_id: ctx.orgId,
    brand_ids: ctx.brandIds.join(","),
    outlet_id: outletId,
  });

  let res: Response;
  try {
    res = await fetch(
      `${config.journalistsServiceUrl}/internal/outlets/blocked?${params}`,
      {
        method: "GET",
        headers: buildServiceHeaders(config.journalistsServiceApiKey, ctx),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] journalists-service /internal/outlets/blocked timed out after 30s`);
    }
    throw new Error(`[outlets-service] journalists-service /internal/outlets/blocked fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[outlets-service] journalists-service /internal/outlets/blocked failed (${res.status}): ${body}`
    );
  }

  return (await res.json()) as OutletBlockedResponse;
}
