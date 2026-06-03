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
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_block_cache ON campaign_outlets(org_id, outlet_id, updated_at) WHERE status = 'skipped';
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

  // Step 9: Drop old dedup index based on 'served' status (dedup now uses journalists-service)
  await pool.query(`DROP INDEX IF EXISTS idx_campaign_outlets_dedup`);

  // Step 10: Migrate brand_id → brand_ids UUID[] (for databases predating the schema change)
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

  // Step 11: Create campaign_categories table. We create the table with
  // legacy column name `relevance_rank` for backward compat with any DB still
  // on the pre-rename schema; Step 16 renames it to `relevance_score` (and
  // Step 18 re-adds `relevance_rank` as a synced mirror).
  //
  // The index on `relevance_rank` / `relevance_score` is intentionally NOT
  // created here: on a post-rename DB the column `relevance_rank` no longer
  // exists, and Postgres validates column references inside
  // `CREATE INDEX IF NOT EXISTS` *before* the name-exists short-circuit
  // fires, producing `column "relevance_rank" does not exist` and aborting
  // the migration. Step 16 creates the correct index on `relevance_score`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL,
      category_name TEXT NOT NULL,
      category_geo TEXT NOT NULL,
      relevance_rank INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'capped')),
      outlets_found INT NOT NULL DEFAULT 0,
      batch_number INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (campaign_id, category_name, category_geo)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_categories_campaign ON campaign_categories(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_categories_batch ON campaign_categories(campaign_id, batch_number);
  `);

  // Step 12: Add category_id FK to campaign_outlets (nullable for backward compat)
  await pool.query(`
    ALTER TABLE campaign_outlets ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES campaign_categories(id);
    CREATE INDEX IF NOT EXISTS idx_campaign_outlets_category ON campaign_outlets(category_id);
  `);

  // Step 13: Create campaign_category_outlets table for per-category outlet tracking
  // This table tracks which outlets each category discovered, independently of campaign_outlets.
  // PK is (campaign_id, category_id, outlet_id) — same outlet can appear in multiple categories.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_category_outlets (
      campaign_id UUID NOT NULL,
      category_id UUID NOT NULL REFERENCES campaign_categories(id) ON DELETE CASCADE,
      outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (campaign_id, category_id, outlet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cco_category ON campaign_category_outlets(category_id);
    CREATE INDEX IF NOT EXISTS idx_cco_campaign ON campaign_category_outlets(campaign_id);
  `);

  // Step 14: Backfill campaign_category_outlets from existing campaign_outlets
  await pool.query(`
    INSERT INTO campaign_category_outlets (campaign_id, category_id, outlet_id)
    SELECT campaign_id, category_id, outlet_id
    FROM campaign_outlets
    WHERE category_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  `);

  // Step 15: Add status_reason and status_detail columns to campaign_outlets
  await pool.query(`
    ALTER TABLE campaign_outlets ADD COLUMN IF NOT EXISTS status_reason TEXT;
    ALTER TABLE campaign_outlets ADD COLUMN IF NOT EXISTS status_detail TEXT;
  `);

  // Step 16: Rename campaign_categories.relevance_rank → relevance_score.
  // Idempotent: skip if already renamed. Data is preserved by RENAME COLUMN.
  // Existing campaigns mid-flight keep their ordering value; new campaigns
  // populated by generateAllCategories will write the LLM-emitted 0-100 score.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'campaign_categories' AND column_name = 'relevance_rank'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'campaign_categories' AND column_name = 'relevance_score'
      ) THEN
        ALTER TABLE campaign_categories RENAME COLUMN relevance_rank TO relevance_score;
      END IF;
    END $$;
  `);

  // The pre-rename index name still references "relevance_rank"; recreate
  // matching the new column name. Postgres auto-rewires indexes on renamed
  // columns transparently, so this is purely cosmetic — the index is functional
  // either way. The CREATE IF NOT EXISTS keeps old deployments happy.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_campaign_categories_active_score
      ON campaign_categories(campaign_id, relevance_score DESC NULLS LAST)
      WHERE status = 'active';
  `);

  // Step 17: Track Google-rejected domains per (campaign, category) so the
  // next LLM call sees them as "known" and stops re-proposing them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_category_rejected_domains (
      campaign_id UUID NOT NULL,
      category_id UUID NOT NULL REFERENCES campaign_categories(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (campaign_id, category_id, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_ccrd_category ON campaign_category_rejected_domains(category_id);
    CREATE INDEX IF NOT EXISTS idx_ccrd_campaign ON campaign_category_rejected_domains(campaign_id);
  `);

  // Step 18: Re-add `relevance_rank` as a synced mirror of `relevance_score`
  // to make column renames safe under Railway rolling deploys.
  //
  // Rolling deploy hazard: when v0.25.0 boots, the new container runs the
  // RENAME migration (Step 16) BEFORE the old v0.24.0 container is killed,
  // and the old container keeps serving traffic with `SELECT relevance_rank`
  // queries that now 500 with `column "relevance_rank" does not exist`.
  //
  // Mitigation = additive migration: bring the old column back, keep both
  // in sync via trigger. Old code reading `relevance_rank` still works
  // during the rollover window; new code reading `relevance_score` also
  // works. Once all replicas are on v0.25.0+, dropping `relevance_rank`
  // is safe — but defer that to a future migration with its own
  // rolling-deploy plan.
  await pool.query(`
    ALTER TABLE campaign_categories ADD COLUMN IF NOT EXISTS relevance_rank INT;
    UPDATE campaign_categories SET relevance_rank = relevance_score WHERE relevance_rank IS NULL;
  `);

  // Trigger to keep relevance_rank ↔ relevance_score in sync on every write.
  // Replaceable so re-runs are idempotent.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_campaign_categories_relevance_cols()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.relevance_score IS DISTINCT FROM OLD.relevance_score THEN
        NEW.relevance_rank := NEW.relevance_score;
      ELSIF NEW.relevance_rank IS DISTINCT FROM OLD.relevance_rank THEN
        NEW.relevance_score := NEW.relevance_rank;
      ELSIF TG_OP = 'INSERT' THEN
        IF NEW.relevance_score IS NULL AND NEW.relevance_rank IS NOT NULL THEN
          NEW.relevance_score := NEW.relevance_rank;
        ELSIF NEW.relevance_rank IS NULL AND NEW.relevance_score IS NOT NULL THEN
          NEW.relevance_rank := NEW.relevance_score;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_sync_campaign_categories_relevance ON campaign_categories;
    CREATE TRIGGER trg_sync_campaign_categories_relevance
      BEFORE INSERT OR UPDATE ON campaign_categories
      FOR EACH ROW EXECUTE FUNCTION sync_campaign_categories_relevance_cols();
  `);

  // Step 19: Bronze — raw per-outlet pricing notes (verbatim journalist emails,
  // Google Doc / spreadsheet pastes). Append-only source of truth; never edited.
  // Cascade-deletes with the outlet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlet_price_sources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
      raw_text TEXT NOT NULL,
      source_type TEXT,
      captured_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_outlet_price_sources_outlet ON outlet_price_sources(outlet_id);
  `);

  // Step 20: Silver — LLM-extracted structured pricing, re-derived from ALL
  // bronzes for the outlet on every ingest. One row per outlet (derived cache,
  // recomputable from bronze). `amount_cents` is the RETAIL cost (what we pay
  // the outlet) and is INTERNAL-ONLY — it must never cross the /orgs boundary.
  // `sell_price_cents` is generated = round(retail * sales_multiplier); it is the
  // only price exposed externally. `sales_multiplier` defaults to 2.0 and is left
  // untouched by re-extraction so a per-outlet override survives.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlet_pricing (
      outlet_id UUID PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
      amount_cents INTEGER,
      currency TEXT,
      sales_multiplier NUMERIC(4,2) NOT NULL DEFAULT 2.0,
      sell_price_cents INTEGER GENERATED ALWAYS AS ((round(amount_cents * sales_multiplier))::integer) STORED,
      article_type TEXT CHECK (article_type IN ('organic', 'sponsored')),
      allows_dofollow_backlink BOOLEAN,
      online_duration_months INTEGER,
      is_permanent BOOLEAN,
      conditions_note TEXT,
      source_bronze_ids UUID[] NOT NULL DEFAULT '{}',
      extraction_rationale TEXT,
      confidence NUMERIC(4,3),
      model TEXT,
      prompt_version TEXT,
      extracted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Step 21: Editorial-email discovery — silver rows + per-domain lookup cache.
  // `outlet_editorial_email_lookups` holds the terminal status per (org, domain)
  // and doubles as the cache key (TTL filtered on discovered_at). It records
  // no_email_found / parked_dead too, so dead/form-only domains are not re-scraped.
  // `outlet_editorial_emails` holds the normalized silver rows. Both are org-scoped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlet_editorial_email_lookups (
      org_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      status TEXT NOT NULL,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_oeel_lookup
      ON outlet_editorial_email_lookups(org_id, domain, discovered_at);

    CREATE TABLE IF NOT EXISTS outlet_editorial_emails (
      org_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT,
      score INT NOT NULL,
      source TEXT NOT NULL,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id, domain, email)
    );
    CREATE INDEX IF NOT EXISTS idx_oee_org_domain
      ON outlet_editorial_emails(org_id, domain);
  `);

  // Step 22: Pricing sources — a "seller" you buy placement through. A broker
  // (e.g. MatrixGlobalBrands) resells placement across MANY outlets, so its
  // single quote prices N publications at once. Direct sellers (the outlet's
  // own editorial team) need no row here — "direct" is implicit = the outlet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_sources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      domain TEXT,
      kind TEXT NOT NULL DEFAULT 'broker' CHECK (kind IN ('broker')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_sources_domain
      ON pricing_sources(domain) WHERE domain IS NOT NULL;
  `);

  // Step 23: source_outlets — which outlets a broker covers (its inventory).
  // A broker's pricing note fans out to every outlet in this membership.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_outlets (
      source_id UUID NOT NULL REFERENCES pricing_sources(id) ON DELETE CASCADE,
      outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (source_id, outlet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_outlets_outlet ON source_outlets(outlet_id);
  `);

  // Step 24: A bronze note now belongs to EITHER one outlet (direct quote) OR
  // one source (broker quote covering many outlets). Make outlet_id nullable,
  // add source_id, enforce exactly-one. Existing rows have outlet_id set +
  // source_id null → satisfy the CHECK, so this is additive-safe.
  await pool.query(`
    ALTER TABLE outlet_price_sources ALTER COLUMN outlet_id DROP NOT NULL;
    ALTER TABLE outlet_price_sources ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES pricing_sources(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_outlet_price_sources_source ON outlet_price_sources(source_id);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_price_source_target') THEN
        ALTER TABLE outlet_price_sources ADD CONSTRAINT chk_price_source_target
          CHECK ((outlet_id IS NOT NULL) <> (source_id IS NOT NULL));
      END IF;
    END $$;
  `);

  // Step 25: Make pricing_sources.domain unique index NON-partial. The Step 22
  // partial index (WHERE domain IS NOT NULL) cannot be inferred by
  // `INSERT ... ON CONFLICT (domain)` (Postgres 42P10), which broke ensureSource.
  // A plain unique index still allows multiple NULL domains (NULLs are distinct)
  // and IS inferable by ON CONFLICT (domain). Drop + recreate; idempotent.
  await pool.query(`
    DROP INDEX IF EXISTS idx_pricing_sources_domain;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_sources_domain ON pricing_sources(domain);
  `);

  // Step 26: Pay-per-publish price requests — tracks that we emailed an outlet's
  // editorial team asking for its rate card and are awaiting the reply. Keyed on
  // outlet_id (GLOBAL — one outreach per outlet; the resulting price is global,
  // shared across every org). `org_id` records the org that triggered the
  // request, for audit only — it does NOT scope the key. The lifecycle status
  // ("ongoing" vs "received") is NOT stored: it is derived at read time by
  // comparing outlet_pricing.updated_at against requested_at, so it stays
  // correct whether the reply is ingested via the bronze endpoint or pasted
  // straight into the DB.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outlet_price_requests (
      outlet_id UUID PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      editorial_email TEXT NOT NULL,
      message_id TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_outlet_price_requests_org ON outlet_price_requests(org_id);
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
