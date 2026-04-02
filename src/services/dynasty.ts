import { config } from "../config";

interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

/**
 * Resolve a workflow dynasty slug to its list of versioned slugs.
 * Returns empty array if the dynasty has no versions.
 */
export async function resolveWorkflowDynastySlugs(
  dynastySlug: string,
  apiKey: string
): Promise<string[]> {
  const url = `${config.workflowServiceUrl}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.error(`[outlets-service] workflow-service /workflows/dynasty/slugs timed out after 30s`);
    } else {
      console.error(`[outlets-service] workflow-service /workflows/dynasty/slugs fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
  if (!res.ok) {
    console.error(`[outlets-service] Failed to resolve workflow dynasty slug: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Resolve a feature dynasty slug to its list of versioned slugs.
 * Returns empty array if the dynasty has no versions.
 */
export async function resolveFeatureDynastySlugs(
  dynastySlug: string,
  apiKey: string
): Promise<string[]> {
  const url = `${config.featuresServiceUrl}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.error(`[outlets-service] features-service /features/dynasty/slugs timed out after 30s`);
    } else {
      console.error(`[outlets-service] features-service /features/dynasty/slugs fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
  if (!res.ok) {
    console.error(`[outlets-service] Failed to resolve feature dynasty slug: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Get all workflow dynasties and build a reverse map: slug → dynastySlug.
 */
export async function getWorkflowDynastyMap(
  apiKey: string
): Promise<Map<string, string>> {
  const url = `${config.workflowServiceUrl}/workflows/dynasties`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.error(`[outlets-service] workflow-service /workflows/dynasties timed out after 30s`);
    } else {
      console.error(`[outlets-service] workflow-service /workflows/dynasties fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new Map();
  }
  if (!res.ok) {
    console.error(`[outlets-service] Failed to fetch workflow dynasties: ${res.status}`);
    return new Map();
  }
  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(data.dynasties ?? []);
}

/**
 * Get all feature dynasties and build a reverse map: slug → dynastySlug.
 */
export async function getFeatureDynastyMap(
  apiKey: string
): Promise<Map<string, string>> {
  const url = `${config.featuresServiceUrl}/features/dynasties`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.error(`[outlets-service] features-service /features/dynasties timed out after 30s`);
    } else {
      console.error(`[outlets-service] features-service /features/dynasties fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new Map();
  }
  if (!res.ok) {
    console.error(`[outlets-service] Failed to fetch feature dynasties: ${res.status}`);
    return new Map();
  }
  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(data.dynasties ?? []);
}

function buildSlugToDynastyMap(
  dynasties: DynastyEntry[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
