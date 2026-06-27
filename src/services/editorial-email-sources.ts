import { pool } from "../db/pool";
import { ensureOutlet } from "./pricing";
import { roleOf, scoreEmail } from "../lib/email-extract";
import type { EditorialResult } from "./editorial-emails";
import type { EditorialEmailSourceEntry } from "../schemas";

export interface SeedSummary {
  outlets: number;
  emailsUpserted: number;
  found: number;
  notFound: number;
}

/**
 * Seed the curated editorial-email BRONZE from a manually-verified list. For each
 * entry: upsert the outlet (by domain), record its global verdict
 * (found / not_found), and — for `found` — append/refresh its curated emails with
 * provenance. GLOBAL + org-agnostic: one seed serves every org, and takes
 * precedence over the scrape-derived silver cache on read (see readCuratedEditorial).
 */
export async function seedEditorialEmailSources(
  entries: EditorialEmailSourceEntry[]
): Promise<SeedSummary> {
  let emailsUpserted = 0;
  let found = 0;
  let notFound = 0;

  for (const entry of entries) {
    const { id: outletId } = await ensureOutlet(
      entry.outletName,
      entry.url ?? `https://${entry.domain}`,
      entry.domain
    );

    await pool.query(
      `INSERT INTO outlet_editorial_curation (outlet_id, status, note, captured_by, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (outlet_id) DO UPDATE SET
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         captured_by = EXCLUDED.captured_by,
         updated_at = CURRENT_TIMESTAMP`,
      [outletId, entry.status, entry.note ?? null, entry.capturedBy]
    );

    if (entry.status === "found") {
      found += 1;
      for (const e of entry.emails ?? []) {
        await pool.query(
          `INSERT INTO outlet_editorial_email_sources
             (outlet_id, email, role, source_url, capture_method, confidence, captured_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (outlet_id, email, captured_by) DO UPDATE SET
             role = EXCLUDED.role,
             source_url = EXCLUDED.source_url,
             capture_method = EXCLUDED.capture_method,
             confidence = EXCLUDED.confidence`,
          [
            outletId,
            e.email.toLowerCase(),
            e.role ?? roleOf(e.email),
            e.sourceUrl ?? null,
            e.captureMethod,
            e.confidence ?? null,
            entry.capturedBy,
          ]
        );
        emailsUpserted += 1;
      }
    } else {
      notFound += 1;
    }
  }

  return { outlets: entries.length, emailsUpserted, found, notFound };
}

/**
 * Resolve an outlet's CURATED editorial verdict by domain — the bronze-first rung
 * of discovery. Returns:
 *   * null — no curation row (fall through to the scrape ladder / org cache).
 *   * status 'found' + the curated emails (scored, editorial-first).
 *   * status 'no_email_found' + [] — a verified dead/unreachable outlet, so
 *     discover serves the terminal "no email" verdict WITHOUT scraping.
 * Curated data always wins over the scrape cache, for every org.
 */
export async function readCuratedEditorial(domain: string): Promise<EditorialResult | null> {
  const verdict = await pool.query(
    `SELECT c.status, c.outlet_id
       FROM outlet_editorial_curation c
       JOIN outlets o ON o.id = c.outlet_id
      WHERE o.outlet_domain = $1
      LIMIT 1`,
    [domain]
  );
  if (verdict.rows.length === 0) return null;

  if (verdict.rows[0].status === "not_found") {
    return { domain, status: "no_email_found", emails: [] };
  }

  const outletId = verdict.rows[0].outlet_id as string;
  const rows = await pool.query(
    `SELECT email, role, source_url
       FROM outlet_editorial_email_sources
      WHERE outlet_id = $1`,
    [outletId]
  );

  const emails = rows.rows
    .map((r: { email: string; role: string | null; source_url: string | null }) => ({
      email: r.email,
      score: scoreEmail(r.email),
      source: r.source_url ?? "curated",
      role: r.role ?? undefined,
    }))
    .sort((a, b) => a.score - b.score);

  return { domain, status: "found", emails };
}

export interface CuratedEmail {
  email: string;
  role?: string;
}

/**
 * Read an outlet's curated editorial emails by id, editorial-first (best first).
 * Pure bronze lookup — NO discovery/scrape/LLM. Empty when the outlet has no
 * curated emails (a `not_found` verdict or never curated). Used by the send-only
 * price-request path so the workflow can fire the sequence without re-researching.
 */
export async function getCuratedEmailsForOutlet(outletId: string): Promise<CuratedEmail[]> {
  const rows = await pool.query(
    `SELECT email, role
       FROM outlet_editorial_email_sources
      WHERE outlet_id = $1`,
    [outletId]
  );
  return rows.rows
    .map((r: { email: string; role: string | null }) => ({
      email: r.email,
      role: r.role ?? undefined,
      score: scoreEmail(r.email),
    }))
    .sort((a, b) => a.score - b.score)
    .map(({ email, role }) => ({ email, role }));
}
