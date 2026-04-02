import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const BRAND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — brand extraction involves scraping + LLM for multiple brands

export interface BrandFieldValue {
  value: string | string[] | Record<string, unknown> | null;
  byBrand: Record<
    string,
    {
      value: string | string[] | Record<string, unknown> | null;
      cached: boolean;
      extractedAt: string;
      expiresAt: string | null;
      sourceUrls: string[] | null;
    }
  >;
}

/** Response shape: fields keyed by field key */
export type ExtractFieldsResult = Record<string, BrandFieldValue>;

export interface FieldRequest {
  key: string;
  description: string;
}

export async function extractFields(
  fields: FieldRequest[],
  ctx: OrgContext
): Promise<ExtractFieldsResult> {
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.brandServiceUrl}/brands/extract-fields`, {
      method: "POST",
      headers: buildServiceHeaders(config.brandServiceApiKey, ctx),
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(BRAND_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] brand-service /brands/extract-fields timed out after ${elapsed}ms (limit=${BRAND_TIMEOUT_MS}ms)`);
    }
    throw new Error(`[outlets-service] brand-service /brands/extract-fields fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] brand-service /brands/extract-fields failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { brands: unknown[]; fields: ExtractFieldsResult };
  return data.fields;
}

/** Helper: find a field result by key, returning its value as string or null */
export function findField(fields: ExtractFieldsResult, key: string): string | null {
  const field = fields[key];
  if (!field || field.value === null) return null;
  if (typeof field.value === "string") return field.value;
  if (Array.isArray(field.value)) return field.value.join(", ");
  return JSON.stringify(field.value);
}
