import { pool } from "../db/pool";
import type { OrgContext } from "../middleware/org-context";
import { scrapeRawHtml, mapSitemapUrls } from "./scraping";
import { serperTopResultUrls } from "./google";
import { categorizeEditorialEmails, pickContactUrls } from "./editorial-categorize";
import { extractEmails, isLander, type EditorialStatus } from "../lib/email-extract";
import { readCuratedEditorial } from "./editorial-email-sources";

// Editorial emails change rarely — cache per (org, domain) for 60 days.
const CACHE_TTL_DAYS = 60;

export interface EditorialEmailInput {
  outletName: string;
  domain: string;
  url: string;
}

export interface EditorialEmail {
  email: string;
  score: number;
  source: string;
  // Role bucket: LLM category for discovered emails, or explicit role from the curated bronze.
  role?: string;
}

export interface EditorialResult {
  domain: string;
  status: EditorialStatus;
  emails: EditorialEmail[];
}

interface RawScrape {
  /** Deduped scraped candidate addresses, in discovery order. */
  emails: string[];
  /** email -> the page URL it was scraped from. */
  sourceByEmail: Map<string, string>;
  /** at least one scraped page was a parked/lander page. */
  parked: boolean;
}

/** Resolve editorial emails for one domain — cache-first, then the discovery paths. */
export async function discoverEditorialEmails(
  input: EditorialEmailInput,
  ctx: OrgContext
): Promise<EditorialResult> {
  // Rung 0 — curated bronze wins over the scrape cache, for every org. A 'found'
  // verdict serves the curated emails; a 'not_found' verdict serves the terminal
  // "no email" status WITHOUT scraping a known-dead domain. Either way we refresh
  // the org silver cache so the dashboard read stays consistent.
  const curated = await readCuratedEditorial(input.domain);
  if (curated) {
    await writeCache(curated, ctx);
    return curated;
  }

  const cached = await readCache(input.domain, ctx);
  if (cached) return cached;

  const result = await runLadder(input, ctx);
  await writeCache(result, ctx);
  return result;
}

/**
 * Two-path discovery:
 *  - Path A (Google): search "<outlet> press/editorial contact email", scrape the
 *    top 1-2 result pages, regex every address, then an LLM categorizes + ranks
 *    them — keeping only real editorial/press contacts and dropping junk (app
 *    identifiers, fake domains, unrelated orgs). If ≥1 survives → done.
 *  - Path B (sitemap, only if A yields nothing): map the site's sitemap, an LLM
 *    picks the up-to-3 most likely contact pages, scrape + regex + the same
 *    categorize/rank step.
 * If neither path produces a vetted address → honest no_email_found (or
 * parked_dead when the only pages seen were parked landers).
 *
 * The LLM categorize step is the junk filter AND the deliverability judgment:
 * an address that survives came from a real page and was judged a genuine,
 * sendable editorial contact — so the price-request flow may send to it directly
 * (no separate verification gate).
 */
async function runLadder(input: EditorialEmailInput, ctx: OrgContext): Promise<EditorialResult> {
  const base = input.url.replace(/\/$/, "");

  // Path A — Google top results.
  const aRaw = await collectFromGoogle(input, ctx);
  const aVetted = await categorizeEditorialEmails(input.outletName, input.domain, aRaw.emails, ctx);
  if (aVetted.length > 0) {
    return buildResult(input.domain, "found_google", aVetted, aRaw.sourceByEmail, "google");
  }

  // Path B — sitemap-guided contact pages.
  const bRaw = await collectFromSitemap(input, base, ctx);
  const bVetted = await categorizeEditorialEmails(input.outletName, input.domain, bRaw.emails, ctx);
  if (bVetted.length > 0) {
    return buildResult(input.domain, "found", bVetted, bRaw.sourceByEmail, "sitemap");
  }

  const parked = aRaw.parked || bRaw.parked;
  return {
    domain: input.domain,
    status: parked ? "parked_dead" : "no_email_found",
    emails: [],
  };
}

/** Path A — scrape the top Google result pages for this outlet. */
async function collectFromGoogle(input: EditorialEmailInput, ctx: OrgContext): Promise<RawScrape> {
  const urls = await serperTopResultUrls(input.outletName, input.domain, ctx, 2);
  return scrapeAndExtract(urls, ctx);
}

/** Path B — sitemap → LLM picks the likely contact pages → scrape those. */
async function collectFromSitemap(
  input: EditorialEmailInput,
  base: string,
  ctx: OrgContext
): Promise<RawScrape> {
  const sitemap = await mapSitemapUrls(base, ctx);
  const picked = await pickContactUrls(input.outletName, input.domain, sitemap, ctx, 3);
  return scrapeAndExtract(picked, ctx);
}

/** Scrape a set of URLs, regex + junk-filter the addresses, track their source page. */
async function scrapeAndExtract(urls: string[], ctx: OrgContext): Promise<RawScrape> {
  const sourceByEmail = new Map<string, string>();
  let parked = false;
  for (const u of urls) {
    const html = await scrapeRawHtml(u, ctx);
    if (!html) continue;
    if (isLander(html)) {
      parked = true;
      continue;
    }
    for (const e of extractEmails(html)) {
      if (!sourceByEmail.has(e)) sourceByEmail.set(e, u);
    }
  }
  return { emails: [...sourceByEmail.keys()], sourceByEmail, parked };
}

/** Map the LLM-ranked vetted addresses to silver rows (score = rank, role = category). */
function buildResult(
  domain: string,
  status: EditorialStatus,
  vetted: Array<{ email: string; category: string }>,
  sourceByEmail: Map<string, string>,
  sourceFallback: string
): EditorialResult {
  const emails: EditorialEmail[] = vetted.map((c, i) => ({
    email: c.email,
    score: i, // LLM rank, best-first (lower = better)
    source: sourceByEmail.get(c.email) ?? sourceFallback,
    role: c.category,
  }));
  return { domain, status, emails };
}

/** Serve a still-fresh cached result (including terminal no_email_found / parked_dead). */
async function readCache(domain: string, ctx: OrgContext): Promise<EditorialResult | null> {
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
      [ctx.orgId, result.domain, e.email, e.role ?? "editorial", e.score, e.source]
    );
  }
}

/**
 * Run a batch through a concurrency pool. Domains run in parallel (bounded),
 * but each domain's two-path discovery is internally sequential.
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
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return results;
}
