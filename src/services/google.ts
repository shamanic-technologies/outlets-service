import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";

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

function buildHeaders(ctx: OrgContext): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.googleServiceApiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.featureSlug) h["x-feature-slug"] = ctx.featureSlug;
  if (ctx.campaignId) h["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) h["x-brand-id"] = ctx.brandId;
  if (ctx.workflowName) h["x-workflow-name"] = ctx.workflowName;
  return h;
}

async function searchSingle(
  query: string,
  type: "web" | "news",
  ctx: OrgContext,
  options?: { num?: number; gl?: string; hl?: string }
): Promise<SearchResponse> {
  const endpoint = type === "news" ? "/search/news" : "/search/web";
  const res = await fetch(`${config.googleServiceUrl}${endpoint}`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify({
      query,
      type,
      num: options?.num ?? 20,
      gl: options?.gl,
      hl: options?.hl,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`google-service ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<SearchResponse>;
}

export async function searchBatch(
  req: BatchSearchRequest,
  ctx: OrgContext
): Promise<BatchSearchResponse> {
  const res = await fetch(`${config.googleServiceUrl}/search/batch`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`google-service /search/batch failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BatchSearchResponse>;
}

export { searchSingle };
