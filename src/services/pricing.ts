import { z } from "zod";
import { pool } from "../db/pool";
import { platformComplete } from "./chat";
import type { CreatePriceSource } from "../schemas";

export const PRICING_PROMPT_VERSION = "v1";
const MAX_LLM_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 2000;

// --- DTOs ---

export interface OutletPricingInternal {
  outletId: string;
  amountCents: number | null;
  currency: string | null;
  salesMultiplier: number;
  sellPriceCents: number | null;
  articleType: "organic" | "sponsored" | null;
  allowsDofollowBacklink: boolean | null;
  onlineDurationMonths: number | null;
  isPermanent: boolean | null;
  conditionsNote: string | null;
  confidence: number | null;
  model: string | null;
  promptVersion: string | null;
  sourceBronzeIds: string[];
  extractionRationale: string | null;
  extractedAt: string | null;
  bronzeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OutletPricingPublic {
  outletId: string;
  sellPriceCents: number | null;
  currency: string | null;
  articleType: "organic" | "sponsored" | null;
  allowsDofollowBacklink: boolean | null;
  onlineDurationMonths: number | null;
  isPermanent: boolean | null;
  conditionsNote: string | null;
}

// --- LLM extraction contract ---

// System prompt for the silver extractor. The model reads ALL raw bronze notes
// for one outlet and emits the current resolved unit pricing. NEVER invent a
// value — omit any field that is not clearly stated so it lands as NULL.
const PRICING_EXTRACTION_SYSTEM_PROMPT = `You extract structured per-article pricing for a single media outlet from raw, messy notes (journalist email replies, Google Doc or spreadsheet pastes).

You are given every note we have for this outlet, oldest first. Later notes override earlier ones when they conflict (e.g. a renegotiated rate). Produce the CURRENT unit pricing for ONE sponsored/organic article.

Fields (ALL optional except rationale — OMIT any field you are not sure about; never guess):
- amountCents: the retail unit cost WE pay the outlet for one article, in minor units (cents) of the stated currency. e.g. "$500" -> 50000, "1.2k EUR" -> 120000. Integer.
- currency: ISO 4217 code if stated (USD, EUR, GBP...).
- articleType: "organic" or "sponsored" if stated.
- allowsDofollowBacklink: true if at least one dofollow backlink is available; false if only nofollow/sponsored links are offered. (nofollow and sponsored are equivalent for our purposes.)
- onlineDurationMonths: how many months the article stays online before removal. Integer, never below 1. Omit if the article is permanent or duration is unstated.
- isPermanent: true if the article stays online forever / is never taken down.
- conditionsNote: a short free-text note capturing any extra particular conditions too granular for the fields above (image allowance, number of links, placement, turnaround...).
- confidence: your confidence in amountCents, 0 to 1.
- rationale: one or two sentences on how you derived the values. ALWAYS provide this.

Ignore volume tiers, packages, bundles and subscriptions for now — extract only the single-article unit price. If multiple unit prices appear, use the most recent stated one.`;

// Gemini's responseSchema dialect is an OpenAPI 3.0 subset and rejects
// `additionalProperties` (HTTP 400) — do not add it. Only `rationale` is
// required; the model omits any field it cannot determine, which we map to NULL.
const pricingExtractionJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    amountCents: { type: "integer", minimum: 0 },
    currency: { type: "string" },
    articleType: { type: "string", enum: ["organic", "sponsored"] },
    allowsDofollowBacklink: { type: "boolean" },
    onlineDurationMonths: { type: "integer", minimum: 1 },
    isPermanent: { type: "boolean" },
    conditionsNote: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
  required: ["rationale"],
};

const pricingExtractionSchema = z.object({
  amountCents: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  articleType: z.enum(["organic", "sponsored"]).optional(),
  allowsDofollowBacklink: z.boolean().optional(),
  onlineDurationMonths: z.number().int().min(1).optional(),
  isPermanent: z.boolean().optional(),
  conditionsNote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string(),
});

interface BronzeRow {
  id: string;
  raw_text: string;
  source_type: string | null;
  created_at: string;
}

function buildExtractionMessage(bronzes: BronzeRow[]): string {
  const blocks = bronzes.map((b, i) => {
    const src = b.source_type ? ` (${b.source_type})` : "";
    return `--- Note ${i + 1}${src}, captured ${b.created_at} ---\n${b.raw_text}`;
  });
  return `Pricing notes for this outlet (oldest first):\n\n${blocks.join("\n\n")}`;
}

// --- Row mappers ---

function toInternalDTO(row: Record<string, any>): OutletPricingInternal {
  const bronzeIds: string[] = row.source_bronze_ids ?? [];
  return {
    outletId: row.outlet_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    salesMultiplier: Number(row.sales_multiplier),
    sellPriceCents: row.sell_price_cents,
    articleType: row.article_type,
    allowsDofollowBacklink: row.allows_dofollow_backlink,
    onlineDurationMonths: row.online_duration_months,
    isPermanent: row.is_permanent,
    conditionsNote: row.conditions_note,
    confidence: row.confidence == null ? null : Number(row.confidence),
    model: row.model,
    promptVersion: row.prompt_version,
    sourceBronzeIds: bronzeIds,
    extractionRationale: row.extraction_rationale,
    extractedAt: row.extracted_at,
    bronzeCount: bronzeIds.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicDTO(row: Record<string, any>): OutletPricingPublic {
  return {
    outletId: row.outlet_id,
    sellPriceCents: row.sell_price_cents,
    currency: row.currency,
    articleType: row.article_type,
    allowsDofollowBacklink: row.allows_dofollow_backlink,
    onlineDurationMonths: row.online_duration_months,
    isPermanent: row.is_permanent,
    conditionsNote: row.conditions_note,
  };
}

// --- Operations ---

export async function outletExists(outletId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM outlets WHERE id = $1`, [outletId]);
  return r.rows.length > 0;
}

export async function hasPriceSources(outletId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM outlet_price_sources WHERE outlet_id = $1 LIMIT 1`,
    [outletId]
  );
  return r.rows.length > 0;
}

export async function insertPriceSource(
  outletId: string,
  input: CreatePriceSource
): Promise<string> {
  const r = await pool.query(
    `INSERT INTO outlet_price_sources (outlet_id, raw_text, source_type, captured_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [outletId, input.rawText, input.sourceType ?? null, input.capturedBy ?? null]
  );
  return r.rows[0].id;
}

/**
 * Re-derive the silver pricing row for an outlet from ALL of its bronze notes.
 * Calls the platform LLM (Gemini Pro) with retry on malformed JSON. Fails loud
 * (throws) if there are no bronzes or extraction never yields valid JSON — the
 * caller maps that to a 502/404. `sales_multiplier` is intentionally left out of
 * the UPDATE so any manual per-outlet override survives re-extraction.
 */
export async function extractAndUpsertPricing(
  outletId: string
): Promise<OutletPricingInternal> {
  const bronzes = await pool.query(
    `SELECT id, raw_text, source_type, created_at
     FROM outlet_price_sources
     WHERE outlet_id = $1
     ORDER BY created_at ASC`,
    [outletId]
  );

  if (bronzes.rows.length === 0) {
    throw new Error(`[outlets-service] No price sources to extract for outlet ${outletId}`);
  }

  const bronzeIds: string[] = bronzes.rows.map((r: BronzeRow) => r.id);
  const message = buildExtractionMessage(bronzes.rows as BronzeRow[]);

  let parsed: { data: z.infer<typeof pricingExtractionSchema>; model: string } | null = null;

  for (let retry = 0; retry <= MAX_LLM_RETRIES; retry++) {
    const response = await platformComplete({
      provider: "google",
      model: "pro",
      message,
      systemPrompt: PRICING_EXTRACTION_SYSTEM_PROMPT,
      responseFormat: "json",
      responseSchema: pricingExtractionJsonSchema,
      temperature: 0.2,
    });

    const result = pricingExtractionSchema.safeParse(response.json);
    if (result.success) {
      parsed = { data: result.data, model: response.model };
      break;
    }

    if (retry < MAX_LLM_RETRIES) {
      console.warn(`[outlets-service] Pricing extraction: LLM returned invalid format (attempt ${retry + 1}/${MAX_LLM_RETRIES + 1}) for outlet ${outletId}, retrying in ${LLM_RETRY_DELAY_MS}ms:`, response.content);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    } else {
      console.error(`[outlets-service] Pricing extraction: LLM failed after ${MAX_LLM_RETRIES + 1} attempts for outlet ${outletId}:`, response.content);
    }
  }

  if (!parsed) {
    throw new Error(`[outlets-service] Pricing extraction failed for outlet ${outletId} after ${MAX_LLM_RETRIES + 1} attempts`);
  }

  const d = parsed.data;
  const upsert = await pool.query(
    `INSERT INTO outlet_pricing (
       outlet_id, amount_cents, currency, article_type, allows_dofollow_backlink,
       online_duration_months, is_permanent, conditions_note, source_bronze_ids,
       extraction_rationale, confidence, model, prompt_version, extracted_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (outlet_id) DO UPDATE SET
       amount_cents = EXCLUDED.amount_cents,
       currency = EXCLUDED.currency,
       article_type = EXCLUDED.article_type,
       allows_dofollow_backlink = EXCLUDED.allows_dofollow_backlink,
       online_duration_months = EXCLUDED.online_duration_months,
       is_permanent = EXCLUDED.is_permanent,
       conditions_note = EXCLUDED.conditions_note,
       source_bronze_ids = EXCLUDED.source_bronze_ids,
       extraction_rationale = EXCLUDED.extraction_rationale,
       confidence = EXCLUDED.confidence,
       model = EXCLUDED.model,
       prompt_version = EXCLUDED.prompt_version,
       extracted_at = EXCLUDED.extracted_at,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      outletId,
      d.amountCents ?? null,
      d.currency ?? null,
      d.articleType ?? null,
      d.allowsDofollowBacklink ?? null,
      d.onlineDurationMonths ?? null,
      d.isPermanent ?? null,
      d.conditionsNote ?? null,
      bronzeIds,
      d.rationale,
      d.confidence ?? null,
      parsed.model,
      PRICING_PROMPT_VERSION,
    ]
  );

  console.log(`[outlets-service] Pricing extracted for outlet ${outletId} from ${bronzeIds.length} bronze note(s) (model=${parsed.model})`);
  return toInternalDTO(upsert.rows[0]);
}

export async function getInternalPricing(
  outletId: string
): Promise<OutletPricingInternal | null> {
  const r = await pool.query(`SELECT * FROM outlet_pricing WHERE outlet_id = $1`, [outletId]);
  return r.rows.length > 0 ? toInternalDTO(r.rows[0]) : null;
}

/**
 * Org-facing pricing read. Returns SELL price only (no retail, no multiplier) and
 * is gated on the org actually having the outlet in one of its campaigns — both
 * the tenant-isolation guard and the retail-omission keep internal cost private.
 */
export async function getPublicPricingForOrg(
  outletId: string,
  orgId: string
): Promise<OutletPricingPublic | null> {
  const r = await pool.query(
    `SELECT p.outlet_id, p.sell_price_cents, p.currency, p.article_type,
            p.allows_dofollow_backlink, p.online_duration_months, p.is_permanent, p.conditions_note
     FROM outlet_pricing p
     WHERE p.outlet_id = $1
       AND EXISTS (
         SELECT 1 FROM campaign_outlets co
         WHERE co.outlet_id = p.outlet_id AND co.org_id = $2
       )`,
    [outletId, orgId]
  );
  return r.rows.length > 0 ? toPublicDTO(r.rows[0]) : null;
}
