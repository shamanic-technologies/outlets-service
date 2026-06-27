/**
 * Seed the curated editorial-email bronze from the verified research list.
 *
 *   tsx scripts/seed-editorial-emails.ts [--dry-run]
 *
 * Reads scripts/editorial-emails-seed.json and POSTs it to
 *   POST {OUTLETS_SERVICE_URL}/internal/editorial-emails/sources
 * with header x-api-key: {OUTLETS_SERVICE_API_KEY}.
 *
 * Not part of the deployed service — operational glue, run once after deploy.
 * Idempotent: the endpoint upserts on (outlet domain) + (outlet, email,
 * capturedBy), so re-running the same file is safe.
 */
import fs from "fs";
import path from "path";

interface Summary {
  outlets: number;
  emailsUpserted: number;
  found: number;
  notFound: number;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const baseUrl = process.env.OUTLETS_SERVICE_URL;
  const apiKey = process.env.OUTLETS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("OUTLETS_SERVICE_URL and OUTLETS_SERVICE_API_KEY must be set");
  }

  const file = path.join(__dirname, "editorial-emails-seed.json");
  const entries = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  console.log(`[seed] ${entries.length} entries loaded from ${file}`);

  if (dryRun) {
    const found = entries.filter((e) => (e as { status: string }).status === "found").length;
    console.log(`[seed] DRY RUN — would seed ${found} found + ${entries.length - found} not_found`);
    return;
  }

  const res = await fetch(`${baseUrl}/internal/editorial-emails/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    throw new Error(`seed failed (${res.status}): ${await res.text()}`);
  }
  const summary = (await res.json()) as Summary;
  console.log(`[seed] done:`, summary);
}

main().catch((err) => {
  console.error("[seed] error:", err);
  process.exit(1);
});
