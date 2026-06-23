import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

/**
 * Normalized deliverability verdict for an email address, as returned by
 * apify-service `POST /verify`. `valid` is the only status safe to send to.
 */
export type VerificationStatus = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

const VERIFY_STATUSES: ReadonlySet<string> = new Set<VerificationStatus>([
  "valid",
  "invalid",
  "risky",
  "catch_all",
  "unknown",
]);

interface VerifyResultRow {
  email: string;
  status: VerificationStatus;
}

interface VerifyResponse {
  results: VerifyResultRow[];
}

// apify-service caps a batch at 100 addresses.
const MAX_VERIFY_BATCH = 100;

/**
 * Verify deliverability of a batch of email addresses via apify-service.
 * apify-service owns the Apify SMTP-verification spend (declares run + cost).
 * outlets-service stays cost-free.
 *
 * Fail-loud: any timeout / non-2xx / malformed body throws. The price-request
 * caller converts a throw into a per-outlet error result (skip send) — an
 * unverifiable address must never be emailed (deliverability protection).
 *
 * Returns a map of email -> status. Emails the response omits are absent from
 * the map (caller treats absent as not-deliverable).
 */
export async function verifyEmails(
  emails: string[],
  ctx: OrgContext
): Promise<Map<string, VerificationStatus>> {
  const out = new Map<string, VerificationStatus>();
  if (emails.length === 0) return out;

  for (let i = 0; i < emails.length; i += MAX_VERIFY_BATCH) {
    const batch = emails.slice(i, i + MAX_VERIFY_BATCH);
    for (const [email, status] of await verifyBatch(batch, ctx)) {
      out.set(email, status);
    }
  }
  return out;
}

async function verifyBatch(
  emails: string[],
  ctx: OrgContext
): Promise<Map<string, VerificationStatus>> {
  let res: Response;
  try {
    res = await fetch(`${config.apifyServiceUrl}/verify`, {
      method: "POST",
      headers: buildServiceHeaders(config.apifyServiceApiKey, ctx),
      body: JSON.stringify({ emails }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] apify-service /verify timed out after 60s`);
    }
    throw new Error(
      `[outlets-service] apify-service /verify fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] apify-service /verify failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as VerifyResponse;
  if (!json || !Array.isArray(json.results)) {
    throw new Error(`[outlets-service] apify-service /verify returned a malformed body`);
  }

  const map = new Map<string, VerificationStatus>();
  for (const row of json.results) {
    if (!row || typeof row.email !== "string" || !VERIFY_STATUSES.has(row.status)) {
      throw new Error(
        `[outlets-service] apify-service /verify returned an unrecognized result row: ${JSON.stringify(row)}`
      );
    }
    map.set(row.email, row.status);
  }
  return map;
}
