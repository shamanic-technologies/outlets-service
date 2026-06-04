// Pure parsing + mapping helpers for the Tremplin Numérique broker catalog import.
//
// Kept under src/ (compiled + unit-tested) so the one-shot importer in
// scripts/import-tremplin-catalog.ts stays a thin DB-glue layer. No DB / IO here.
//
// Why deterministic (no LLM): the catalog is a clean structured CSV — every
// silver pricing field is either a parseable column (price → amount_cents) or a
// constant from the vendor's published terms (organic, 1 dofollow, permanent).
// Running the LLM silver extractor per row would cost ~6.2k calls and add
// hallucination risk to a price that is already exact.

// Marker stamped on every bronze note + silver row a given import run writes.
// Bump the month on the next monthly refresh so a re-import appends a fresh
// bronze snapshot (audit trail) while the previous one stays; silver upserts.
export const CAPTURED_BY = "tremplin-2026-06";

export const SOURCE_NAME = "Tremplin Numérique";

// Vendor terms, identical for every site (from the catalog cover email). Stored
// on the silver row's conditions_note. The sensitive-topic 2–3× surcharge is a
// sell-side, per-order rule and is deliberately NOT baked into amount_cents.
export const CONDITIONS_NOTE =
  "Tremplin Numérique broker catalog. Price covers link placement only " +
  "(article writing extra: €35/500w, €50/1000w, €70/1500w). Sensitive topics " +
  "(casino, poker, crypto, CBD, dating, trading, VPN, medications) priced 2× " +
  "(non-optimized anchor) to 3× (optimized anchor/title). One dofollow link, no " +
  "time limit; article not marked sponsored; stays online permanently; published " +
  "within 24h. Payment within one week of publication (transfer/PayPal/crypto).";

// Column indices in the catalog CSV. The header spans several quoted, multi-line
// cells but resolves to one record; data rows are single-line.
export const COL = { domain: 0, url: 1, price: 2 } as const;

export interface CsvRecord {
  fields: string[];
  raw: string;
}

/**
 * RFC-4180 CSV parser. Handles quoted fields containing commas, newlines, and
 * "" escapes — required here because the header's first cell and several column
 * labels span multiple lines. Blank records are dropped.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let recordStart = 0;
  let i = 0;

  const pushField = () => {
    fields.push(field);
    field = "";
  };
  const pushRecord = (end: number) => {
    pushField();
    const isBlank = fields.length === 1 && fields[0] === "";
    if (!isBlank) records.push({ fields, raw: text.slice(recordStart, end) });
    fields = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRecord(i);
      i++;
      recordStart = i;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || fields.length > 0) pushRecord(text.length);
  return records;
}

/** "2 000 €" → 200000 cents (EUR). Returns null when no positive integer is present. */
export function parsePriceToCents(raw: string): number | null {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  if (digits === "") return null;
  const euros = parseInt(digits, 10);
  if (!Number.isFinite(euros) || euros <= 0) return null;
  return euros * 100;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/i;

/** Hostname from a URL, lowercased, www-stripped — no exceptions (regex, not `new URL`). */
function hostnameFromUrl(url: string): string {
  const m = (url || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

/**
 * Canonical ASCII domain for a row. The catalog's column 0 is a display name that
 * can be unicode for IDN sites (e.g. "étudiant.es"); the canonical ASCII domain
 * lives in the URL as punycode ("xn--tudiant-9xa.es"). Prefer column 0 when it is
 * already a clean ASCII domain, else fall back to the URL's punycode hostname.
 */
function resolveDomain(field0: string, url: string): string | null {
  const d0 = (field0 || "").trim().toLowerCase();
  if (DOMAIN_RE.test(d0)) return d0;
  const host = hostnameFromUrl(url);
  if (DOMAIN_RE.test(host)) return host;
  return null;
}

export type ClassifiedRow =
  | { kind: "data"; domain: string; url: string; amountCents: number; raw: string }
  | { kind: "skip"; reason: string; raw: string };

/**
 * Decide whether a CSV record is an importable data row. The header, blank lines,
 * and any malformed record (no resolvable domain, or unparseable price) are
 * classified as skip with a reason — the caller reports them and fails loud if
 * too many data rows are missing.
 */
export function classifyRow(rec: CsvRecord): ClassifiedRow {
  const f = rec.fields;
  if (f.length < 6) return { kind: "skip", reason: `too few columns (${f.length})`, raw: rec.raw };

  const url = (f[COL.url] || "").trim();
  const domain = resolveDomain(f[COL.domain] || "", url);
  if (domain === null) {
    return { kind: "skip", reason: `no resolvable domain: ${JSON.stringify(f[COL.domain]?.slice(0, 40))}`, raw: rec.raw };
  }

  const amountCents = parsePriceToCents(f[COL.price] || "");
  if (amountCents === null) {
    return { kind: "skip", reason: `unparseable price: ${JSON.stringify(f[COL.price])}`, raw: rec.raw };
  }

  return { kind: "data", domain, url: url || `https://${domain}/`, amountCents, raw: rec.raw };
}
