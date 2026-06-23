/**
 * One-shot reconciliation of junk `outlets.outlet_domain` values to NULL.
 *
 * outlets-service must never persist a non-domain value (the "-" placeholder for
 * "no domain", a path-bearing value like "a.com/section", whitespace, empty) as
 * an outlet's domain — it poisons downstream ahref enrichment batches. New writes
 * are normalized at the source (src/lib/domain.ts). This script cleans the rows
 * that predate that fix: any `outlet_domain` that is NOT a valid bare host is set
 * to NULL.
 *
 * Safe by construction:
 *   - DRY-RUN by default: prints the count + a sample of junk values, writes NOTHING.
 *   - --apply: writes a timestamped backup ({id, oldDomain}) FIRST, then NULLs the
 *     junk rows. Idempotent — a second --apply finds 0 rows.
 *   - --restore <backup.json>: writes the backed-up values back (per-row; logs any
 *     row that can no longer be restored, e.g. a unique-index collision).
 *
 * "Valid bare host" is the SAME definition used at every write site and by the
 * ahref read skip (normalizeOutletDomain), so this never nulls a real domain.
 *
 * Usage:
 *   tsx scripts/reconcile-outlet-domains.ts                 # dry-run preview
 *   tsx scripts/reconcile-outlet-domains.ts --apply         # null junk rows (+ backup)
 *   tsx scripts/reconcile-outlet-domains.ts --restore <backup.json>
 *
 * Targets whatever OUTLETS_SERVICE_DATABASE_URL / DATABASE_URL resolves to.
 */
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { pool } from "../src/db/pool";
import { normalizeOutletDomain } from "../src/lib/domain";

interface JunkRow {
  id: string;
  oldDomain: string;
}

const BACKUP_DIR = ".context";

function timestamp(): string {
  // Avoid Date in app code, but a one-shot script run by a human is fine.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** All rows whose stored outlet_domain is NOT a valid bare host (-> would become NULL). */
async function findJunkRows(): Promise<JunkRow[]> {
  const res = await pool.query<{ id: string; outlet_domain: string }>(
    `SELECT id, outlet_domain FROM outlets WHERE outlet_domain IS NOT NULL`
  );
  return res.rows
    .filter((r) => normalizeOutletDomain(r.outlet_domain) === null)
    .map((r) => ({ id: r.id, oldDomain: r.outlet_domain }));
}

async function dryRun(): Promise<void> {
  const junk = await findJunkRows();
  console.log(`[reconcile] DRY-RUN — ${junk.length} outlet row(s) have a junk outlet_domain (would become NULL).`);
  if (junk.length > 0) {
    const sample = junk.slice(0, 25).map((r) => `${r.id}: ${JSON.stringify(r.oldDomain)}`);
    console.log(`[reconcile] Sample (up to 25):\n  ${sample.join("\n  ")}`);
    console.log(`[reconcile] Re-run with --apply to NULL these rows (a backup is written first).`);
  } else {
    console.log(`[reconcile] Nothing to do — no junk domains stored.`);
  }
}

async function apply(): Promise<void> {
  const junk = await findJunkRows();
  if (junk.length === 0) {
    console.log(`[reconcile] APPLY — 0 junk rows; nothing to do (idempotent no-op).`);
    return;
  }

  const backupPath = `${BACKUP_DIR}/reconcile-outlet-domains-${timestamp()}.json`;
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(junk, null, 2));
  console.log(`[reconcile] APPLY — backed up ${junk.length} row(s) to ${backupPath}`);

  const ids = junk.map((r) => r.id);
  const res = await pool.query(
    `UPDATE outlets SET outlet_domain = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  console.log(`[reconcile] APPLY — set outlet_domain = NULL on ${res.rowCount} row(s). Reversible via --restore ${backupPath}`);
}

async function restore(backupPath: string): Promise<void> {
  const rows = JSON.parse(readFileSync(backupPath, "utf8")) as JunkRow[];
  console.log(`[reconcile] RESTORE — restoring ${rows.length} row(s) from ${backupPath}`);
  let restored = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const res = await pool.query(
        `UPDATE outlets SET outlet_domain = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [r.oldDomain, r.id]
      );
      restored += res.rowCount ?? 0;
    } catch (err) {
      failed++;
      console.warn(`[reconcile] RESTORE — could not restore ${r.id} -> ${JSON.stringify(r.oldDomain)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[reconcile] RESTORE — restored ${restored} row(s), ${failed} failed.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const restoreIdx = args.indexOf("--restore");

  if (restoreIdx !== -1) {
    const path = args[restoreIdx + 1];
    if (!path) throw new Error("--restore requires a backup file path");
    await restore(path);
  } else if (args.includes("--apply")) {
    await apply();
  } else {
    await dryRun();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[reconcile] FAILED:", err);
    process.exit(1);
  });
