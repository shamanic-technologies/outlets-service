import { pool } from "./pool";

// Enum additions MUST run outside a transaction so new values are committed
// before any DDL that references them (e.g. partial indexes with WHERE status = 'served').
const enumSetup = `
DO $$ BEGIN
  CREATE TYPE outlet_status_enum AS ENUM ('open', 'ended', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

const enumAdditions = [
  `ALTER TYPE outlet_status_enum ADD VALUE IF NOT EXISTS 'served'`,
  `ALTER TYPE outlet_status_enum ADD VALUE IF NOT EXISTS 'skipped'`,
];

const migration = `
-- outlets (deduplicated by domain)
CREATE TABLE IF NOT EXISTS outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_name TEXT NOT NULL,
  outlet_url TEXT NOT NULL,
  outlet_domain TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- campaign_outlets (scoped: org × brand × feature × campaign × workflow)
CREATE TABLE IF NOT EXISTS campaign_outlets (
  campaign_id UUID NOT NULL,
  outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  brand_ids UUID[],
  feature_slug TEXT,
  workflow_slug TEXT,
  why_relevant TEXT NOT NULL,
  why_not_relevant TEXT NOT NULL,
  relevance_score NUMERIC(5,2) NOT NULL,
  overall_relevance TEXT,
  relevance_rationale TEXT,
  status outlet_status_enum NOT NULL DEFAULT 'open',
  search_queries_used INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, outlet_id)
);

-- idempotency_cache for buffer/next
CREATE TABLE IF NOT EXISTS idempotency_cache (
  idempotency_key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_campaign ON campaign_outlets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_outlet ON campaign_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_org ON campaign_outlets(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_brand_ids ON campaign_outlets USING GIN (brand_ids);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_workflow ON campaign_outlets(workflow_slug);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_buffer ON campaign_outlets(campaign_id, status, relevance_score DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_dedup ON campaign_outlets(org_id, outlet_id) WHERE status = 'served';
CREATE INDEX IF NOT EXISTS idx_idempotency_cache_created ON idempotency_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_outlets_url ON outlets(outlet_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outlets_domain ON outlets(outlet_domain);
`;

// Rename workflow_name → workflow_slug (idempotent: skips if column already renamed)
const columnRename = `
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'campaign_outlets' AND column_name = 'workflow_name'
  ) THEN
    ALTER TABLE campaign_outlets RENAME COLUMN workflow_name TO workflow_slug;
  END IF;
END $$;
`;

// Recreate index on renamed column (old index auto-follows the rename,
// but the name still says "workflow" which is fine — no action needed)

// Dedup existing outlets by domain — merges duplicates before switching the unique constraint.
// Idempotent: no-op if no duplicates exist.
const dedupByDomain = `
DO $$
DECLARE
  _domain TEXT;
  _keep_id UUID;
BEGIN
  FOR _domain, _keep_id IN
    SELECT outlet_domain, (MIN(id::text))::uuid FROM outlets GROUP BY outlet_domain HAVING COUNT(*) > 1
  LOOP
    -- For campaigns that have both canonical and duplicate outlets,
    -- keep the canonical row but upgrade its score if the duplicate scored higher
    UPDATE campaign_outlets co_keep
    SET
      relevance_score = GREATEST(co_keep.relevance_score, co_dup.relevance_score),
      why_relevant = CASE WHEN co_dup.relevance_score > co_keep.relevance_score THEN co_dup.why_relevant ELSE co_keep.why_relevant END,
      why_not_relevant = CASE WHEN co_dup.relevance_score > co_keep.relevance_score THEN co_dup.why_not_relevant ELSE co_keep.why_not_relevant END,
      overall_relevance = CASE WHEN co_dup.relevance_score > co_keep.relevance_score THEN co_dup.overall_relevance ELSE co_keep.overall_relevance END,
      relevance_rationale = CASE WHEN co_dup.relevance_score > co_keep.relevance_score THEN co_dup.relevance_rationale ELSE co_keep.relevance_rationale END,
      updated_at = CURRENT_TIMESTAMP
    FROM campaign_outlets co_dup
    WHERE co_keep.outlet_id = _keep_id
      AND co_dup.campaign_id = co_keep.campaign_id
      AND co_dup.outlet_id IN (SELECT id FROM outlets WHERE outlet_domain = _domain AND id != _keep_id);

    -- Remove duplicate campaign_outlets where canonical already exists in same campaign
    DELETE FROM campaign_outlets
    WHERE outlet_id IN (SELECT id FROM outlets WHERE outlet_domain = _domain AND id != _keep_id)
      AND campaign_id IN (SELECT campaign_id FROM campaign_outlets WHERE outlet_id = _keep_id);

    -- Repoint remaining campaign_outlets (no conflict) to canonical outlet
    UPDATE campaign_outlets
    SET outlet_id = _keep_id, updated_at = CURRENT_TIMESTAMP
    WHERE outlet_id IN (SELECT id FROM outlets WHERE outlet_domain = _domain AND id != _keep_id);

    -- Delete duplicate outlet rows
    DELETE FROM outlets WHERE outlet_domain = _domain AND id != _keep_id;
  END LOOP;
END $$;
`;

// Switch unique constraint from outlet_url to outlet_domain
const switchUniqueConstraint = `
ALTER TABLE outlets DROP CONSTRAINT IF EXISTS outlets_outlet_url_key;
DROP INDEX IF EXISTS idx_outlets_domain;
`;

export async function runMigration(): Promise<void> {
  console.log("[outlets-service] Running migration...");

  // Step 1: Create enum type (idempotent)
  await pool.query(enumSetup);

  // Step 2: Add new enum values — each runs as its own implicit transaction
  // so the values are committed before any DDL references them.
  for (const stmt of enumAdditions) {
    try {
      await pool.query(stmt);
    } catch (err: any) {
      // 42710 = duplicate_object — value already exists, safe to ignore
      if (err.code !== "42710") throw err;
    }
  }

  // Step 3: Rename workflow_name → workflow_slug (idempotent)
  // Must run BEFORE index creation, since the index references workflow_slug
  await pool.query(columnRename);

  // Step 4: Tables, indexes (can now reference 'served'/'skipped' and workflow_slug)
  await pool.query(migration);

  // Step 5: Dedup existing outlets by domain (must run AFTER tables exist,
  // BEFORE unique index on outlet_domain is enforced)
  await pool.query(dedupByDomain);

  // Step 6: Switch unique constraint from outlet_url to outlet_domain
  await pool.query(switchUniqueConstraint);

  // Step 7: Re-run DDL to create the unique index on outlet_domain
  // (the main migration DDL now has CREATE UNIQUE INDEX IF NOT EXISTS)
  await pool.query(migration);

  // Step 8: Add run_id column to campaign_outlets for run tracking
  await pool.query(`
    ALTER TABLE campaign_outlets ADD COLUMN IF NOT EXISTS run_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_campaign_outlets_run_id ON campaign_outlets(run_id);
  `);

  // Step 9: Migrate brand_id → brand_ids UUID[] (for databases predating the schema change)
  // Backfill from existing brand_id (no-op if column already dropped)
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'campaign_outlets' AND column_name = 'brand_id'
      ) THEN
        UPDATE campaign_outlets SET brand_ids = ARRAY[brand_id]
        WHERE brand_ids IS NULL AND brand_id IS NOT NULL;
      END IF;
    END $$;
  `);
  // Drop old brand_id column and its index (idempotent)
  await pool.query(`
    DROP INDEX IF EXISTS idx_campaign_outlets_brand;
    ALTER TABLE campaign_outlets DROP COLUMN IF EXISTS brand_id;
  `);

  console.log("[outlets-service] Migration complete.");
}

// Allow running as standalone script
if (require.main === module || process.argv[1]?.endsWith("migrate")) {
  runMigration()
    .then(() => pool.end())
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
