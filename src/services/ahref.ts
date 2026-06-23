import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

/** A domain-keyed cache row from ahref-service (DR or traffic). */
interface DomainCacheRow {
  domain: string;
  latestValidDr?: number | null;
  trafficMonthlyAvg?: number | null;
}

const MAX_DOMAINS_URL_LENGTH = 6_000;
/** Bound concurrent cache-read chunks so a wide request never floods ahref's tiny compute. */
const ENRICH_CHUNK_CONCURRENCY = 6;
/** Connect-phase retry for a chunk fetch: initial attempt + this many retries. */
const CHUNK_FETCH_RETRIES = 3;
const CHUNK_RETRY_BACKOFF_MS = [250, 500, 1000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for a TRANSIENT TRANSPORT failure that thrown a chunk GET — ahref-service
 * cold-start / pool-saturation surfaces as a rejected fetch (TypeError: fetch
 * failed) whose cause walks down to ECONNRESET / ETIMEDOUT / ECONNREFUSED, or as
 * an AbortSignal TimeoutError. These reads are idempotent GETs, so a bounded
 * retry is write-safe. An HTTP 5xx is a real answer (the request reached ahref)
 * — NOT retried here (kept fail-loud per chunk).
 */
function isTransientTransportError(err: unknown): boolean {
  const codes = new Set([
    "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  ]);
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { name?: string; code?: string; message?: string; cause?: unknown; errors?: unknown[] };
    if (e.name === "TimeoutError") return true;
    if (typeof e.code === "string" && codes.has(e.code)) return true;
    if (typeof e.message === "string" && /fetch failed|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(e.message)) return true;
    if (Array.isArray(e.errors) && e.errors.some((sub) => isTransientTransportError(sub))) return true;
    cur = e.cause;
  }
  return false;
}

function buildDomainsUrl(path: string, domains: string[]): string {
  const params = new URLSearchParams({ domains: domains.join(",") });
  return `${config.ahrefServiceUrl}${path}?${params}`;
}

/** Split domains into chunks each producing a URL within the length bound. */
function chunkDomains(path: string, domains: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const domain of domains) {
    const next = [...current, domain];
    if (current.length > 0 && buildDomainsUrl(path, next).length > MAX_DOMAINS_URL_LENGTH) {
      chunks.push(current);
      current = [domain];
    } else {
      current = next;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Fetch one chunk from a domain-keyed cache-read endpoint, with a bounded
 * connect-phase retry on transient transport errors (cold-start / pool
 * saturation against ahref's tiny compute). Fail-loud after retries exhaust:
 * a timeout / transport error / non-2xx throws so the caller decides (the
 * resilient reader catches per-chunk and degrades only that chunk to null).
 */
async function fetchDomainCacheChunk(
  path: string,
  domains: string[],
  ctx: OrgContext
): Promise<DomainCacheRow[]> {
  const url = buildDomainsUrl(path, domains);

  for (let attempt = 0; ; attempt++) {
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
      if (isTransientTransportError(err) && attempt < CHUNK_FETCH_RETRIES) {
        await sleep(CHUNK_RETRY_BACKOFF_MS[Math.min(attempt, CHUNK_RETRY_BACKOFF_MS.length - 1)]);
        continue;
      }
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error(`[outlets-service] ahref-service ${path} timed out after 30s`);
      }
      throw new Error(`[outlets-service] ahref-service ${path} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[outlets-service] ahref-service ${path} failed (${res.status}): ${body}`
      );
    }

    return (await res.json()) as DomainCacheRow[];
  }
}

/**
 * Read a domain-keyed cache endpoint, sequentially over URL-bounded chunks.
 * Fail-loud (any chunk throws). Returns a map of normalized domain -> picked value.
 */
async function readDomainCache(
  path: string,
  domains: string[],
  ctx: OrgContext,
  pick: (row: DomainCacheRow) => number | null
): Promise<Map<string, number | null>> {
  if (domains.length === 0) return new Map();

  const out = new Map<string, number | null>();
  for (const chunk of chunkDomains(path, domains)) {
    const rows = await fetchDomainCacheChunk(path, chunk, ctx);
    for (const row of rows) out.set(row.domain, pick(row));
  }
  return out;
}

/** Run `fn` over items with bounded concurrency, collecting settled results. */
async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>
): Promise<PromiseSettledResult<O>[]> {
  const results: PromiseSettledResult<O>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

/**
 * Best-effort, per-chunk-tolerant read of a domain-keyed cache endpoint for the
 * enrich path. Runs URL-bounded chunks in parallel (concurrency-capped); a
 * failed/timed-out chunk leaves its domains ABSENT (→ null) rather than failing
 * the whole list. Never throws — a fully-unreachable ahref yields an empty map.
 */
async function readDomainCacheResilient(
  path: string,
  domains: string[],
  ctx: OrgContext,
  pick: (row: DomainCacheRow) => number | null
): Promise<Map<string, number | null>> {
  if (domains.length === 0) return new Map();

  const out = new Map<string, number | null>();
  const settled = await mapWithConcurrency(
    chunkDomains(path, domains),
    ENRICH_CHUNK_CONCURRENCY,
    (chunk) => fetchDomainCacheChunk(path, chunk, ctx)
  );

  for (const result of settled) {
    if (result.status === "fulfilled") {
      for (const row of result.value) out.set(row.domain, pick(row));
    } else {
      console.warn(
        `[outlets-service] ahref ${path} chunk failed; leaving those domains null:`,
        result.reason
      );
    }
  }
  return out;
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
  return readDomainCache("/orgs/domains/dr-status", domains, ctx, (r) => r.latestValidDr ?? null);
}

/**
 * Resilient enrich-path read of cached Domain Ratings. Per-chunk tolerant, never
 * throws (failed chunks → those domains null). Used by GET /orgs/outlets?enrich=ahref.
 */
export async function getDrStatusForEnrich(
  domains: string[],
  ctx: OrgContext
): Promise<Map<string, number | null>> {
  return readDomainCacheResilient("/orgs/domains/dr-status", domains, ctx, (r) => r.latestValidDr ?? null);
}

/**
 * Resilient enrich-path read of cached monthly organic traffic averages from
 * ahref-service `/orgs/domains/traffic-history`. Pure cache read — no scrape, no
 * spend. `trafficMonthlyAvg` is already nulled by ahref when there is no data or
 * the latest scrape was rejected as implausible. Per-chunk tolerant, never throws.
 */
export async function getTrafficForEnrich(
  domains: string[],
  ctx: OrgContext
): Promise<Map<string, number | null>> {
  return readDomainCacheResilient("/orgs/domains/traffic-history", domains, ctx, (r) => r.trafficMonthlyAvg ?? null);
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
