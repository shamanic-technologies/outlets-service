import { pool } from "../db/pool";
import type { OrgContext } from "../middleware/org-context";
import { scrapeRawHtml, mapContactUrls } from "./scraping";
import { serperEditorialEmails } from "./google";
import {
  extractEmails,
  scoreEmail,
  roleOf,
  isLander,
  type EditorialStatus,
} from "../lib/email-extract";

// Editorial emails change rarely — cache per (org, domain) for 60 days.
const CACHE_TTL_DAYS = 60;

// Candidate paths probed in order; early-stop on the first contact/about page
// that yields an email.
const CANDIDATE_PATHS = [
  "", "/contact", "/contact-us", "/contact-us/", "/contact/",
  "/about", "/about-us", "/about/", "/team", "/write-for-us",
  "/contribute", "/impressum", "/contacto", "/kontakt",
];

export interface EditorialEmailInput {
  outletName: string;
  domain: string;
  url: string;
}

export interface EditorialEmail {
  email: string;
  score: number;
  source: string;
}

export interface EditorialResult {
  domain: string;
  status: EditorialStatus;
  emails: EditorialEmail[];
}

/** Resolve editorial emails for one domain — cache-first, then the fallback ladder. */
export async function discoverEditorialEmails(
  input: EditorialEmailInput,
  ctx: OrgContext
): Promise<EditorialResult> {
  const cached = await readCache(input.domain, ctx);
  if (cached) return cached;

  const result = await runLadder(input, ctx);
  await writeCache(result, ctx);
  return result;
}

async function runLadder(
  input: EditorialEmailInput,
  ctx: OrgContext
): Promise<EditorialResult> {
  const base = input.url.replace(/\/$/, "");
  const found = new Map<string, string>(); // email -> source page
  let parked = false;

  // Rung 1 — plain raw fetch of candidate paths, early-stop on contact/about hit.
  for (const p of CANDIDATE_PATHS) {
    const html = await scrapeRawHtml(base + p, ctx);
    if (!html) continue;
    if (isLander(html)) {
      parked = true;
      break;
    }
    const emails = extractEmails(html);
    for (const e of emails) if (!found.has(e)) found.set(e, (base + p) || base);
    if (p && emails.length > 0 && found.size >= 1 && /contact|about/.test(p)) break;
  }

  // Rung 2 — sitemap-guided contact discovery.
  if (found.size === 0 && !parked) {
    const urls = await mapContactUrls(base, ctx);
    for (const u of urls) {
      const html = await scrapeRawHtml(u, ctx);
      if (!html) continue;
      for (const e of extractEmails(html)) if (!found.has(e)) found.set(e, u);
    }
  }

  // Rung 3 — JS-render retry (scrape.do render=true&super=true) for client-rendered
  // contact pages whose emails aren't in the initial HTML.
  if (found.size === 0 && !parked) {
    for (const p of ["/contact", "/contact-us", ""]) {
      const html = await scrapeRawHtml(base + p, ctx, { skipCache: true, render: true });
      if (html) for (const e of extractEmails(html)) if (!found.has(e)) found.set(e, base + p);
      if (found.size > 0) break;
    }
  }

  // Rung 4 — serper Google fallback.
  let viaGoogle = false;
  if (found.size === 0 && !parked) {
    const g = await serperEditorialEmails(input.outletName, input.domain, ctx);
    for (const e of g) if (!found.has(e)) {
      found.set(e, "google");
      viaGoogle = true;
    }
  }

  const emails: EditorialEmail[] = [...found.entries()]
    .map(([email, source]) => ({ email, score: scoreEmail(email), source }))
    .sort((a, b) => a.score - b.score);

  const status: EditorialStatus = emails.length > 0
    ? (viaGoogle ? "found_google" : "found")
    : parked ? "parked_dead" : "no_email_found";

  return { domain: input.domain, status, emails };
}

/** Serve a still-fresh cached result (including terminal no_email_found / parked_dead). */
async function readCache(
  domain: string,
  ctx: OrgContext
): Promise<EditorialResult | null> {
  const lookup = await pool.query(
    `SELECT status
       FROM outlet_editorial_email_lookups
      WHERE org_id = $1
        AND domain = $2
        AND discovered_at > CURRENT_TIMESTAMP - ($3 || ' days')::interval`,
    [ctx.orgId, domain, CACHE_TTL_DAYS]
  );
  if (lookup.rows.length === 0) return null;

  const status = lookup.rows[0].status as EditorialStatus;
  const emailRows = await pool.query(
    `SELECT email, score, source
       FROM outlet_editorial_emails
      WHERE org_id = $1 AND domain = $2
      ORDER BY score ASC`,
    [ctx.orgId, domain]
  );

  return {
    domain,
    status,
    emails: emailRows.rows.map((r: { email: string; score: number; source: string }) => ({
      email: r.email,
      score: Number(r.score),
      source: r.source,
    })),
  };
}

/** Persist the silver rows + per-domain lookup status for the cache. */
async function writeCache(result: EditorialResult, ctx: OrgContext): Promise<void> {
  await pool.query(
    `INSERT INTO outlet_editorial_email_lookups (org_id, domain, status, discovered_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (org_id, domain)
     DO UPDATE SET status = EXCLUDED.status, discovered_at = CURRENT_TIMESTAMP`,
    [ctx.orgId, result.domain, result.status]
  );

  await pool.query(
    `DELETE FROM outlet_editorial_emails WHERE org_id = $1 AND domain = $2`,
    [ctx.orgId, result.domain]
  );

  for (const e of result.emails) {
    await pool.query(
      `INSERT INTO outlet_editorial_emails (org_id, domain, email, role, score, source, discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, domain, email)
       DO UPDATE SET role = EXCLUDED.role, score = EXCLUDED.score, source = EXCLUDED.source, discovered_at = CURRENT_TIMESTAMP`,
      [ctx.orgId, result.domain, e.email, roleOf(e.email), e.score, e.source]
    );
  }
}

/**
 * Run a batch through a concurrency pool. Domains run in parallel (bounded),
 * but each domain's ladder is internally sequential so its early-stop works.
 */
export async function discoverEditorialEmailsBatch(
  inputs: EditorialEmailInput[],
  ctx: OrgContext,
  concurrency = 8
): Promise<EditorialResult[]> {
  const results = new Array<EditorialResult>(inputs.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < inputs.length) {
      const idx = cursor++;
      results[idx] = await discoverEditorialEmails(inputs[idx], ctx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, worker)
  );
  return results;
}
