/**
 * One-shot importer for the Tremplin Numérique broker catalog (~6.2k sites).
 *
 * Writes, per site, deterministically (NO LLM):
 *   - bronze: one verbatim per-outlet note in `outlet_price_sources`
 *             (source_type='broker-catalog', captured_by=CAPTURED_BY)
 *   - silver: a hand-mapped `outlet_pricing` row (model='deterministic-import')
 *
 * The LLM silver extractor (extractAndUpsertPricing) is intentionally bypassed:
 * the catalog is clean structured data, so a per-row LLM call would only burn
 * tokens and risk hallucinating an already-exact price. The LLM path stays for
 * messy journalist notes; if an imported outlet later gets a journalist note,
 * that path re-derives silver from all of its bronze.
 *
 * Idempotent + re-runnable: outlets upsert on domain, the bronze note is skipped
 * when one with the same captured_by marker already exists, silver upserts on
 * outlet_id. A crashed run can simply be re-run.
 *
 * Usage:
 *   tsx scripts/import-tremplin-catalog.ts --file <path-to-csv> [--dry-run]
 *
 * Targets whatever OUTLETS_SERVICE_DATABASE_URL / DATABASE_URL resolves to.
 */
import { readFileSync } from "fs";
import { pool } from "../src/db/pool";
import { ensureOutlet } from "../src/services/pricing";
import {
  CAPTURED_BY,
  CONDITIONS_NOTE,
  SOURCE_NAME,
  classifyRow,
  parseCsvRecords,
  type ClassifiedRow,
} from "../src/lib/tremplin-catalog";

type DataRow = Extract<ClassifiedRow, { kind: "data" }>;

const MIN_EXPECTED_DATA_ROWS = 6000;

/** Upsert one site: global outlet → verbatim bronze note → deterministic silver. */
async function importOutlet(row: DataRow): Promise<"created" | "updated"> {
  const outlet = await ensureOutlet(row.domain, row.url, row.domain);

  const bronzeText =
    `Source: ${SOURCE_NAME} broker catalog (contact@tremplin-numerique.org), ` +
    `captured ${CAPTURED_BY}, price valid until month-end.\n` +
    `CSV row: ${row.raw.trim()}`;

  const existing = await pool.query(
    `SELECT id FROM outlet_price_sources WHERE outlet_id = $1 AND captured_by = $2 LIMIT 1`,
    [outlet.id, CAPTURED_BY]
  );
  let bronzeId: string;
  if (existing.rows.length > 0) {
    bronzeId = existing.rows[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO outlet_price_sources (outlet_id, raw_text, source_type, captured_by)
       VALUES ($1, $2, 'broker-catalog', $3)
       RETURNING id`,
      [outlet.id, bronzeText, CAPTURED_BY]
    );
    bronzeId = ins.rows[0].id;
  }

  // Deterministic silver. sales_multiplier is intentionally omitted from the
  // UPDATE so any manual per-outlet margin override survives a re-import.
  await pool.query(
    `INSERT INTO outlet_pricing (
       outlet_id, amount_cents, currency, article_type, allows_dofollow_backlink,
       online_duration_months, is_permanent, conditions_note, source_bronze_ids,
       extraction_rationale, confidence, model, prompt_version, extracted_at, updated_at
     )
     VALUES ($1, $2, 'EUR', 'organic', true, NULL, true, $3, $4, $5, 1.0,
             'deterministic-import', 'tremplin-v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
       updated_at = CURRENT_TIMESTAMP`,
    [
      outlet.id,
      row.amountCents,
      CONDITIONS_NOTE,
      [bronzeId],
      `Imported from ${SOURCE_NAME} catalog (${CAPTURED_BY}); deterministic column parse — price column read verbatim, terms applied uniformly.`,
    ]
  );

  return outlet.created ? "created" : "updated";
}

function dedupeByDomain(rows: DataRow[]): { deduped: DataRow[]; collisions: number } {
  const byDomain = new Map<string, DataRow>();
  let collisions = 0;
  for (const r of rows) {
    if (byDomain.has(r.domain)) collisions++;
    byDomain.set(r.domain, r); // last price wins
  }
  return { deduped: [...byDomain.values()], collisions };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fileIdx = args.indexOf("--file");
  const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  if (!file) {
    throw new Error("Usage: tsx scripts/import-tremplin-catalog.ts --file <csv> [--dry-run]");
  }

  const text = readFileSync(file, "utf8");
  const records = parseCsvRecords(text);
  const classified = records.map(classifyRow);
  const data = classified.filter((r): r is DataRow => r.kind === "data");
  const skipped = classified.filter(
    (r): r is Extract<ClassifiedRow, { kind: "skip" }> => r.kind === "skip"
  );
  const { deduped, collisions } = dedupeByDomain(data);

  const cents = deduped.map((r) => r.amountCents).sort((a, b) => a - b);
  const min = cents[0] ?? 0;
  const max = cents[cents.length - 1] ?? 0;
  const median = cents[Math.floor(cents.length / 2)] ?? 0;

  console.log(`[tremplin-import] file=${file}`);
  console.log(
    `[tremplin-import] records=${records.length} dataRows=${data.length} ` +
      `skipped=${skipped.length} uniqueDomains=${deduped.length} domainCollisions=${collisions}`
  );
  console.log(
    `[tremplin-import] price(EUR) min=${(min / 100).toFixed(0)} ` +
      `median=${(median / 100).toFixed(0)} max=${(max / 100).toFixed(0)}`
  );
  console.log(`[tremplin-import] first skipped (≤15):`);
  for (const s of skipped.slice(0, 15)) console.log(`  - ${s.reason}`);
  console.log(`[tremplin-import] sample data (≤3):`);
  for (const d of deduped.slice(0, 3)) {
    console.log(`  - ${d.domain} | ${d.url} | ${(d.amountCents / 100).toFixed(0)} EUR`);
  }

  if (data.length < MIN_EXPECTED_DATA_ROWS) {
    throw new Error(
      `[tremplin-import] only ${data.length} data rows parsed (< ${MIN_EXPECTED_DATA_ROWS}) — ` +
        `aborting: the CSV parse likely broke. No writes performed.`
    );
  }

  if (dryRun) {
    console.log("[tremplin-import] DRY RUN — no DB writes performed.");
    await pool.end();
    return;
  }

  // Bounded concurrency — the bottleneck is per-query round-trip latency to the
  // remote DB, so a handful of parallel workers cuts wall-clock from ~1h to a few
  // minutes. Capped at the pg pool's default max (10) to avoid client starvation.
  const CONCURRENCY = 10;
  let created = 0;
  let updated = 0;
  let done = 0;
  let failed = 0;
  const errors: { domain: string; error: string }[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < deduped.length) {
      const row = deduped[cursor++];
      try {
        const result = await importOutlet(row);
        if (result === "created") created++;
        else updated++;
      } catch (err) {
        failed++;
        errors.push({ domain: row.domain, error: String(err) });
      }
      done++;
      if (done % 500 === 0) {
        console.log(
          `[tremplin-import] ${done}/${deduped.length} (created=${created} updated=${updated} failed=${failed})`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await pool.end();

  if (failed > 0) {
    console.error(`[tremplin-import] ${failed} rows FAILED (first 10):`);
    for (const e of errors.slice(0, 10)) console.error(`  ${e.domain}: ${e.error}`);
  }
  console.log(
    `[tremplin-import] DONE — outlets created=${created} updated=${updated} failed=${failed} total=${done}`
  );

  // Fail loud: a partial import must surface a non-zero exit so the operator
  // re-runs (the import is idempotent, so a re-run only retries the failures).
  if (failed > 0) process.exit(1);
}

if (require.main === module || process.argv[1]?.includes("import-tremplin-catalog")) {
  main().catch((err) => {
    console.error("[tremplin-import] FAILED:", err);
    process.exit(1);
  });
}
