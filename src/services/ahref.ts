import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

/**
 * One row from ahref-service DR endpoints. Domain-keyed; `latestValidDr` is the
 * cached Ahrefs Domain Rating (null when ahref has not scraped that domain yet).
 */
interface DrStatusRow {
  domain: string;
  latestValidDr: number | null;
}

const MAX_DR_STATUS_URL_LENGTH = 6_000;

function buildDrStatusUrl(domains: string[]): string {
  const params = new URLSearchParams({ domains: domains.join(",") });
  return `${config.ahrefServiceUrl}/orgs/domains/dr-status?${params}`;
}

function chunkDomainsForDrStatus(domains: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const domain of domains) {
    const next = [...current, domain];
    if (current.length > 0 && buildDrStatusUrl(next).length > MAX_DR_STATUS_URL_LENGTH) {
      chunks.push(current);
      current = [domain];
    } else {
      current = next;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function fetchDrStatusChunk(
  domains: string[],
  ctx: OrgContext
): Promise<DrStatusRow[]> {
  const url = buildDrStatusUrl(domains);

  let res: Response;
  try {
    res = await fetch(
      url,
      {
        method: "GET",
        headers: buildServiceHeaders(config.ahrefServiceApiKey, ctx),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] ahref-service /orgs/domains/dr-status timed out after 30s`);
    }
    throw new Error(`[outlets-service] ahref-service /orgs/domains/dr-status fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[outlets-service] ahref-service /orgs/domains/dr-status failed (${res.status}): ${body}`
    );
  }

  return (await res.json()) as DrStatusRow[];
}

/**
 * Read cached Domain Ratings for a list of domains from ahref-service.
 * Pure read — no spend. Returns a map of normalized domain -> latestValidDr
 * (null when the domain has not been scraped yet).
 *
 * Domains are normalized server-side (www stripped, case-folded); the response
 * `domain` is the normalized form, so we key the map on it.
 *
 * Fail-loud: any timeout / non-2xx throws (mirrors fetchOutletStatuses).
 */
export async function getDrStatus(
  domains: string[],
  ctx: OrgContext
): Promise<Map<string, number | null>> {
  if (domains.length === 0) return new Map();

  const drMap = new Map<string, number | null>();
  for (const chunk of chunkDomainsForDrStatus(domains)) {
    const rows = await fetchDrStatusChunk(chunk, ctx);
    for (const row of rows) {
      drMap.set(row.domain, row.latestValidDr);
    }
  }

  return drMap;
}

/**
 * Trigger an on-demand Ahrefs DR scrape for the given domains. ahref-service
 * owns the spend (declares run + cost, authorizes, scrapes via Apify).
 *
 * Intended to be fired non-blocking from the discover path — the caller decides
 * whether to await. Fail-loud: any timeout / non-2xx throws so the caller's
 * `.catch` can log it.
 */
export async function triggerDrCompute(
  domains: string[],
  ctx: OrgContext
): Promise<void> {
  if (domains.length === 0) return;

  let res: Response;
  try {
    res = await fetch(
      `${config.ahrefServiceUrl}/orgs/domains/dr-compute`,
      {
        method: "POST",
        headers: buildServiceHeaders(config.ahrefServiceApiKey, ctx),
        body: JSON.stringify({ domains }),
        signal: AbortSignal.timeout(60_000),
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] ahref-service /orgs/domains/dr-compute timed out after 60s`);
    }
    throw new Error(`[outlets-service] ahref-service /orgs/domains/dr-compute fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[outlets-service] ahref-service /orgs/domains/dr-compute failed (${res.status}): ${body}`
    );
  }
}

/**
 * Trigger DR compute from an internal/platform caller with service auth only.
 * ahref-service owns cache checks, spend declaration, platform run tracking, and
 * scrape idempotency on this path.
 */
export async function triggerInternalDrCompute(domains: string[]): Promise<void> {
  if (domains.length === 0) return;

  let res: Response;
  try {
    res = await fetch(
      `${config.ahrefServiceUrl}/internal/domains/dr-compute`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.ahrefServiceApiKey,
        },
        body: JSON.stringify({ domains }),
        signal: AbortSignal.timeout(60_000),
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] ahref-service /internal/domains/dr-compute timed out after 60s`);
    }
    throw new Error(`[outlets-service] ahref-service /internal/domains/dr-compute fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[outlets-service] ahref-service /internal/domains/dr-compute failed (${res.status}): ${body}`
    );
  }
}
