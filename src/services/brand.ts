import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export interface ExtractFieldResult {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

export interface FieldRequest {
  key: string;
  description: string;
}

export async function extractFields(
  fields: FieldRequest[],
  ctx: OrgContext
): Promise<ExtractFieldResult[]> {
  const res = await fetch(`${config.brandServiceUrl}/brands/extract-fields`, {
    method: "POST",
    headers: buildServiceHeaders(config.brandServiceApiKey, ctx),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brand-service /brands/extract-fields failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { results: ExtractFieldResult[] };
  return data.results;
}

/** Helper: find a field result by key, returning its value as string or null */
export function findField(fields: ExtractFieldResult[], key: string): string | null {
  const field = fields.find((f) => f.key === key);
  if (!field || field.value === null) return null;
  if (typeof field.value === "string") return field.value;
  if (Array.isArray(field.value)) return field.value.join(", ");
  return JSON.stringify(field.value);
}
