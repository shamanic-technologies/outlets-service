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

  const res = await fetch(
    `${config.journalistsServiceUrl}/internal/outlets/blocked?${params}`,
    {
      method: "GET",
      headers: buildServiceHeaders(config.journalistsServiceApiKey, ctx),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `journalists-service /internal/outlets/blocked failed (${res.status}): ${body}`
    );
  }

  return (await res.json()) as OutletBlockedResponse;
}
