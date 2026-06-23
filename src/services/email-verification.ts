import { pool } from "../db/pool";
import type { OrgContext } from "../middleware/org-context";
import type { EditorialEmail } from "./editorial-emails";
import { verifyEmails, type VerificationStatus } from "./apify";

// Deliverability verdicts are cached on the silver email rows and reused within
// this window to avoid re-paying apify per re-request. Aligned with the 60-day
// editorial-email discovery cache.
const VERIFICATION_TTL_DAYS = 60;

// Strict policy: only an explicitly-valid address is safe to send to. catch_all
// / risky / invalid / unknown all skip — protects sender deliverability.
function isDeliverable(status: VerificationStatus | undefined): boolean {
  return status === "valid";
}

/** Read still-fresh cached verdicts for the given emails of one (org, domain). */
async function readCachedVerdicts(
  domain: string,
  emails: string[],
  ctx: OrgContext
): Promise<Map<string, VerificationStatus>> {
  const out = new Map<string, VerificationStatus>();
  if (emails.length === 0) return out;

  const r = await pool.query(
    `SELECT email, verification_status
       FROM outlet_editorial_emails
      WHERE org_id = $1
        AND domain = $2
        AND email = ANY($3)
        AND verification_status IS NOT NULL
        AND verified_at > CURRENT_TIMESTAMP - ($4 || ' days')::interval`,
    [ctx.orgId, domain, emails, VERIFICATION_TTL_DAYS]
  );
  for (const row of r.rows as { email: string; verification_status: VerificationStatus }[]) {
    out.set(row.email, row.verification_status);
  }
  return out;
}

/** Persist a fresh verdict onto the silver email row (no-op if the row is absent). */
async function persistVerdict(
  domain: string,
  email: string,
  status: VerificationStatus,
  ctx: OrgContext
): Promise<void> {
  await pool.query(
    `UPDATE outlet_editorial_emails
        SET verification_status = $4, verified_at = CURRENT_TIMESTAMP
      WHERE org_id = $1 AND domain = $2 AND email = $3`,
    [ctx.orgId, domain, email, status]
  );
}

/**
 * Pick the highest-ranked deliverable editorial email for an outlet, verifying
 * via apify-service (cache-first). `emails` must be pre-sorted best-first (the
 * discovery ladder sorts by score ASC). Returns the chosen email, or null when
 * none of the candidates verify as deliverable — in which case the caller must
 * NOT send (an unverified address would hurt deliverability).
 *
 * Fail-loud: a verification call that throws propagates (the price-request
 * wrapper turns it into a per-outlet error result, i.e. skip — never send).
 */
export async function pickDeliverableEmail(
  domain: string,
  emails: EditorialEmail[],
  ctx: OrgContext
): Promise<EditorialEmail | null> {
  if (emails.length === 0) return null;

  const addresses = emails.map((e) => e.email);
  const statusByEmail = await readCachedVerdicts(domain, addresses, ctx);

  const toVerify = addresses.filter((e) => !statusByEmail.has(e));
  if (toVerify.length > 0) {
    const fresh = await verifyEmails(toVerify, ctx);
    for (const [email, status] of fresh) {
      statusByEmail.set(email, status);
      await persistVerdict(domain, email, status, ctx);
    }
  }

  for (const candidate of emails) {
    if (isDeliverable(statusByEmail.get(candidate.email))) return candidate;
  }
  return null;
}
