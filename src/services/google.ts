import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const GOOGLE_TIMEOUT_MS = 60_000; // 60 seconds

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  date?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  searchQuery: string;
  totalResults: number;
}

export interface BatchSearchRequest {
  queries: Array<{
    query: string;
    type: "web" | "news";
    num?: number;
    gl?: string;
    hl?: string;
  }>;
}

export interface BatchSearchResponse {
  results: Array<{
    query: string;
    type: "web" | "news";
    results: SearchResult[];
  }>;
}

async function searchSingle(
  query: string,
  type: "web" | "news",
  ctx: OrgContext,
  options?: { num?: number; gl?: string; hl?: string }
): Promise<SearchResponse> {
  const endpoint = type === "news" ? "/search/news" : "/search/web";
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.googleServiceUrl}${endpoint}`, {
      method: "POST",
      headers: buildServiceHeaders(config.googleServiceApiKey, ctx),
      body: JSON.stringify({
        query,
        type,
        num: options?.num ?? 20,
        gl: options?.gl,
        hl: options?.hl,
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] google-service ${endpoint} timed out after ${elapsed}ms (limit=${GOOGLE_TIMEOUT_MS}ms)`);
    }
    throw new Error(`[outlets-service] google-service ${endpoint} fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] google-service ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<SearchResponse>;
}

export async function searchBatch(
  req: BatchSearchRequest,
  ctx: OrgContext
): Promise<BatchSearchResponse> {
  const start = Date.now();
  console.log(`[outlets-service] searchBatch: calling google-service with ${req.queries.length} queries`);

  let res: Response;
  try {
    res = await fetch(`${config.googleServiceUrl}/search/batch`, {
      method: "POST",
      headers: buildServiceHeaders(config.googleServiceApiKey, ctx),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] google-service /search/batch timed out after ${elapsed}ms (limit=${GOOGLE_TIMEOUT_MS}ms)`);
    }
    throw new Error(`[outlets-service] google-service /search/batch fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  const elapsed = Date.now() - start;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] google-service /search/batch failed (${res.status}) after ${elapsed}ms: ${body}`);
  }

  console.log(`[outlets-service] searchBatch: completed in ${elapsed}ms`);
  return res.json() as Promise<BatchSearchResponse>;
}

export { searchSingle };
