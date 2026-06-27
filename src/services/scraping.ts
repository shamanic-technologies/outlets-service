import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const SCRAPE_TIMEOUT_MS = 60_000;
const MAP_TIMEOUT_MS = 30_000;

/**
 * Fetch the raw HTML of a URL through scraping-service (scrape.do provider),
 * skipping LLM company-info enrichment (`enrich:false`).
 *
 * scraping-service owns the scrape.do key + cost declaration — the metered
 * spend is attributed to the forwarded x-run-id, so outlets-service stays a
 * zero-direct-spend orchestrator.
 *
 * Fail-loud: a non-2xx from scraping-service is a real upstream failure and
 * propagates (→ 502). A target page that 404s is expected to come back as a
 * 2xx with a body (scrape.do passes the fetched page through), NOT a service
 * error — so probing speculative paths does not throw.
 */
export async function scrapeRawHtml(
  url: string,
  ctx: OrgContext,
  opts?: { skipCache?: boolean; render?: boolean }
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${config.scrapingServiceUrl}/scrape`, {
      method: "POST",
      headers: buildServiceHeaders(config.scrapingServiceApiKey, ctx),
      body: JSON.stringify({
        url,
        provider: "scrape-do",
        enrich: false,
        render: opts?.render ?? false,
        skipCache: opts?.skipCache ?? false,
        options: { formats: ["rawHtml"] },
      }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] scraping-service POST /scrape timed out after ${SCRAPE_TIMEOUT_MS}ms (${url})`);
    }
    throw new Error(`[outlets-service] scraping-service POST /scrape fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] scraping-service POST /scrape failed (${res.status}) for ${url}: ${body}`);
  }

  const data = (await res.json()) as { result?: { rawHtml?: string | null } };
  return data.result?.rawHtml ?? null;
}

/**
 * Discover candidate URLs on a site via scraping-service /map (sitemap-guided).
 * Returns the raw URL list (capped) — the caller's LLM step picks the few most
 * likely editorial/contact pages to scrape, rather than a brittle keyword filter.
 */
export async function mapSitemapUrls(url: string, ctx: OrgContext, limit = 200): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${config.scrapingServiceUrl}/map`, {
      method: "POST",
      headers: buildServiceHeaders(config.scrapingServiceApiKey, ctx),
      body: JSON.stringify({ url, sitemapOnly: true, limit }),
      signal: AbortSignal.timeout(MAP_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] scraping-service POST /map timed out after ${MAP_TIMEOUT_MS}ms (${url})`);
    }
    throw new Error(`[outlets-service] scraping-service POST /map fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] scraping-service POST /map failed (${res.status}) for ${url}: ${body}`);
  }

  const data = (await res.json()) as { urls?: string[] };
  return data.urls ?? [];
}
