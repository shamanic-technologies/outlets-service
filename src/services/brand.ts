import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";

export interface Brand {
  id: string;
  name: string | null;
  domain: string | null;
  brandUrl: string | null;
  elevatorPitch: string | null;
  bio: string | null;
  mission: string | null;
  location: string | null;
  categories: string | null;
}

export interface ExtractedField {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  sourceUrls: string[] | null;
  extractedAt: string;
  expiresAt: string | null;
}

function buildHeaders(ctx: OrgContext): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.brandServiceApiKey,
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

export async function getBrand(brandId: string, ctx: OrgContext): Promise<Brand> {
  const res = await fetch(`${config.brandServiceUrl}/brands/${brandId}`, {
    headers: buildHeaders(ctx),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brand-service /brands/${brandId} failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { brand: Brand };
  return data.brand;
}

export async function getExtractedFields(brandId: string, ctx: OrgContext): Promise<ExtractedField[]> {
  const res = await fetch(`${config.brandServiceUrl}/brands/${brandId}/extracted-fields`, {
    headers: buildHeaders(ctx),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`brand-service /brands/${brandId}/extracted-fields failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { brandId: string; fields: ExtractedField[] };
  return data.fields;
}

/** Helper: find an extracted field by key, returning its value as string or null */
export function findField(fields: ExtractedField[], key: string): string | null {
  const field = fields.find((f) => f.key === key);
  if (!field || field.value === null) return null;
  if (typeof field.value === "string") return field.value;
  if (Array.isArray(field.value)) return field.value.join(", ");
  return JSON.stringify(field.value);
}
