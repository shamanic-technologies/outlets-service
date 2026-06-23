import { pool } from "../db/pool";
import type { OrgContext } from "../middleware/org-context";
import { discoverEditorialEmails } from "./editorial-emails";
import { pickDeliverableEmail } from "./email-verification";
import { sendBroadcastEmail } from "./email-gateway";

export const PRICE_REQUEST_SUBJECT = "Branded content placement — rate card request";
const PRICE_REQUEST_TAG = "outlet-price-request";

export interface PriceRequestResult {
  outletId: string;
  status: "ongoing" | "error";
  editorialEmail?: string;
  messageId?: string;
  error?: string;
}

interface OutletRow {
  id: string;
  outlet_name: string;
  outlet_url: string;
  outlet_domain: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Pay-per-publish rate-card outreach email, outlet name interpolated. Returned as
 * both HTML and plaintext. Same body for every outlet — only the publication name
 * changes. Cold editorial outreach, signed by the PR agency (matches the Instantly
 * warmed-inbox identity).
 */
export function buildPriceRequestEmail(outletName: string): { bodyHtml: string; bodyText: string } {
  const name = escapeHtml(outletName);
  const bodyHtml = [
    `<p>Hi,</p>`,
    `<p>I'm an independent PR agency interested in branded content placement on ${name}.</p>`,
    `<p><strong>Format</strong>: written article, like interview, Q&amp;A or op-ed/byline.</p>`,
    `<p>Can you send your rate card — per-article and package/bundle pricing?</p>`,
    `<p><strong>Volume</strong>: one client to start, potentially 2 for testing, scaling to ~10 articles/month if the SEO outcome is positive — and more clients each month as results hold.</p>`,
    `<p><strong><em>A few specifics:</em></strong></p>`,
    `<ul>`,
    `<li><strong>Sponsored or organic?</strong> Is the article labelled "sponsored"/"partner", or does it run as organic editorial?</li>`,
    `<li><strong>Links</strong>: do-follow allowed?</li>`,
    `<li><strong>Duration</strong>: how long does the article stay online with the do-follow + organic/sponsored setup?</li>`,
    `</ul>`,
    `<p>Let me know if any other conditions to know.</p>`,
    `<p>Thanks,<br/>Kevin</p>`,
  ].join("\n");

  const bodyText = [
    `Hi,`,
    ``,
    `I'm an independent PR agency interested in branded content placement on ${outletName}.`,
    ``,
    `Format: written article, like interview, Q&A or op-ed/byline.`,
    ``,
    `Can you send your rate card — per-article and package/bundle pricing?`,
    ``,
    `Volume: one client to start, potentially 2 for testing, scaling to ~10 articles/month if the SEO outcome is positive — and more clients each month as results hold.`,
    ``,
    `A few specifics:`,
    `- Sponsored or organic? Is the article labelled "sponsored"/"partner", or does it run as organic editorial?`,
    `- Links: do-follow allowed?`,
    `- Duration: how long does the article stay online with the do-follow + organic/sponsored setup?`,
    ``,
    `Let me know if any other conditions to know.`,
    ``,
    `Thanks,`,
    `Kevin`,
  ].join("\n");

  return { bodyHtml, bodyText };
}

/** Load the outlets this org owns (present in one of its campaigns), keyed by id. */
async function loadOwnedOutlets(outletIds: string[], orgId: string): Promise<Map<string, OutletRow>> {
  const r = await pool.query(
    `SELECT DISTINCT o.id, o.outlet_name, o.outlet_url, o.outlet_domain
     FROM outlets o
     JOIN campaign_outlets co ON co.outlet_id = o.id
     WHERE o.id = ANY($1) AND co.org_id = $2`,
    [outletIds, orgId]
  );
  const map = new Map<string, OutletRow>();
  for (const row of r.rows as OutletRow[]) map.set(row.id, row);
  return map;
}

/** Persist (upsert) the price-request record after a successful send. */
async function recordPriceRequest(
  outletId: string,
  orgId: string,
  editorialEmail: string,
  messageId: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO outlet_price_requests (outlet_id, org_id, editorial_email, message_id, requested_at, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (outlet_id) DO UPDATE SET
       org_id = EXCLUDED.org_id,
       editorial_email = EXCLUDED.editorial_email,
       message_id = EXCLUDED.message_id,
       requested_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [outletId, orgId, editorialEmail, messageId]
  );
}

/**
 * Run one outlet through the pay-per-publish flow: resolve its editorial email,
 * email the rate-card request via email-gateway (broadcast/Instantly), and record
 * the request as awaiting a reply. Per-outlet failures are returned as `error`
 * results (surfaced, not swallowed) so a batch never aborts on one bad outlet.
 */
async function requestPriceForOutlet(outlet: OutletRow, ctx: OrgContext): Promise<PriceRequestResult> {
  try {
    const discovery = await discoverEditorialEmails(
      { outletName: outlet.outlet_name, domain: outlet.outlet_domain, url: outlet.outlet_url },
      ctx
    );
    if (discovery.emails.length === 0) {
      return { outletId: outlet.id, status: "error", error: `No editorial email found (${discovery.status})` };
    }

    // Verify deliverability before sending — never email an unverified address
    // (bounces hurt sender reputation). Picks the highest-ranked `valid` candidate.
    const best = await pickDeliverableEmail(discovery.domain, discovery.emails, ctx);
    if (!best) {
      return {
        outletId: outlet.id,
        status: "error",
        error: `No deliverable editorial email (none of ${discovery.emails.length} candidate(s) verified valid)`,
      };
    }

    const { bodyHtml, bodyText } = buildPriceRequestEmail(outlet.outlet_name);
    const send = await sendBroadcastEmail(
      {
        to: best.email,
        recipientFirstName: "Editorial",
        recipientLastName: "Team",
        recipientCompany: outlet.outlet_name,
        subject: PRICE_REQUEST_SUBJECT,
        sequence: [{ step: 1, daysSinceLastStep: 0, bodyHtml, bodyText }],
        leadId: outlet.id,
        campaignId: ctx.campaignId,
        workflowSlug: ctx.workflowSlug,
        tag: PRICE_REQUEST_TAG,
        metadata: { outletId: outlet.id, outletDomain: outlet.outlet_domain },
        idempotencyKey: `price-request:${outlet.id}`,
      },
      ctx
    );

    await recordPriceRequest(outlet.id, ctx.orgId, best.email, send.messageId ?? null);
    return { outletId: outlet.id, status: "ongoing", editorialEmail: best.email, messageId: send.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[outlets-service] Price request failed for outlet ${outlet.id}:`, message);
    return { outletId: outlet.id, status: "error", error: message };
  }
}

/**
 * Request pay-per-publish pricing for one or many outlets. Only outlets the org
 * owns are processed; unknown/unowned ids return an `error` result. Owned outlets
 * run through a bounded concurrency pool. Results preserve the input order.
 */
export async function requestPricesForOutlets(
  outletIds: string[],
  ctx: OrgContext,
  concurrency = 8
): Promise<PriceRequestResult[]> {
  const owned = await loadOwnedOutlets(outletIds, ctx.orgId);
  const results = new Array<PriceRequestResult>(outletIds.length);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < outletIds.length) {
      const idx = cursor++;
      const outletId = outletIds[idx];
      const outlet = owned.get(outletId);
      if (!outlet) {
        results[idx] = { outletId, status: "error", error: "Outlet not found or not owned by org" };
        continue;
      }
      results[idx] = await requestPriceForOutlet(outlet, ctx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, outletIds.length) }, worker));
  return results;
}

/**
 * Derive the dashboard-facing price-request status for one outlet. The lifecycle
 * is not stored: a request that predates the latest silver pricing write is
 * "received" (the reply landed), otherwise "ongoing". No request row → null.
 */
export function derivePriceRequestStatus(
  requestedAt: string | Date | null | undefined,
  pricingUpdatedAt: string | Date | null | undefined
): "ongoing" | "received" | null {
  if (!requestedAt) return null;
  if (pricingUpdatedAt && new Date(pricingUpdatedAt).getTime() >= new Date(requestedAt).getTime()) {
    return "received";
  }
  return "ongoing";
}
