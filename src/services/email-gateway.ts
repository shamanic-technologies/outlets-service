import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const EMAIL_GATEWAY_TIMEOUT_MS = 30_000;

/** One step of a broadcast (Instantly) sequence. */
export interface BroadcastSequenceStep {
  step: number;
  daysSinceLastStep: number;
  bodyHtml: string;
  bodyText?: string;
}

/**
 * Broadcast send request mirroring email-gateway `POST /orgs/send` (type:
 * "broadcast"). Cold editorial outreach goes through the broadcast channel so it
 * is routed via Instantly's warmed agency inboxes — never a brand/transactional
 * domain.
 */
export interface BroadcastSendRequest {
  to: string;
  /** Comma-separated BCC list — the email-gateway broadcast channel forwards it
   *  to instantly-service, which sets the Instantly campaign `bcc_list`. Used to
   *  copy an outlet's other editorial contacts on the same rate-card thread. */
  bcc?: string;
  recipientFirstName: string;
  recipientLastName: string;
  recipientCompany: string;
  subject: string;
  sequence: BroadcastSequenceStep[];
  leadId?: string;
  campaignId?: string;
  workflowSlug?: string;
  tag?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface SendResponse {
  success: boolean;
  messageId?: string;
  provider: string;
  campaignId?: string;
  error?: string;
  deduplicated?: boolean;
}

/**
 * Send a broadcast email via email-gateway. Fails loud (throws) on transport
 * error, non-2xx, or a `success:false` body — the caller decides whether to
 * surface that as a per-item error or abort.
 */
export async function sendBroadcastEmail(
  req: BroadcastSendRequest,
  ctx: OrgContext
): Promise<SendResponse> {
  const start = Date.now();
  console.log(`[outlets-service] sendBroadcastEmail: calling email-gateway /orgs/send to=${req.to}`);

  let res: Response;
  try {
    res = await fetch(`${config.emailGatewayServiceUrl}/orgs/send`, {
      method: "POST",
      headers: buildServiceHeaders(config.emailGatewayServiceApiKey, ctx),
      body: JSON.stringify({ type: "broadcast", ...req }),
      signal: AbortSignal.timeout(EMAIL_GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] email-gateway /orgs/send timed out after ${elapsed}ms (limit=${EMAIL_GATEWAY_TIMEOUT_MS}ms)`);
    }
    throw new Error(`[outlets-service] email-gateway /orgs/send fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  const elapsed = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] email-gateway /orgs/send failed (${res.status}) after ${elapsed}ms: ${body}`);
  }

  const data = (await res.json()) as SendResponse;
  if (!data.success) {
    throw new Error(`[outlets-service] email-gateway /orgs/send returned success=false: ${data.error ?? "unknown error"}`);
  }

  console.log(`[outlets-service] sendBroadcastEmail: sent in ${elapsed}ms messageId=${data.messageId ?? "?"} deduplicated=${data.deduplicated ?? false}`);
  return data;
}
