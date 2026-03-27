import { pool } from "./pool";

const migration = `
-- Enums
DO $$ BEGIN
  CREATE TYPE outlet_status_enum AS ENUM ('open', 'ended', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add new enum values (idempotent)
DO $$ BEGIN ALTER TYPE outlet_status_enum ADD VALUE IF NOT EXISTS 'served'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE outlet_status_enum ADD VALUE IF NOT EXISTS 'skipped'; EXCEPTION WHEN others THEN NULL; END $$;

-- outlets (deduplicated by URL)
CREATE TABLE IF NOT EXISTS outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_name TEXT NOT NULL,
  outlet_url TEXT NOT NULL UNIQUE,
  outlet_domain TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- campaign_outlets (scoped: org × brand × feature × campaign × workflow)
CREATE TABLE IF NOT EXISTS campaign_outlets (
  campaign_id UUID NOT NULL,
  outlet_id UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  brand_id UUID NOT NULL,
  feature_slug TEXT,
  workflow_name TEXT,
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
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_brand ON campaign_outlets(brand_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_workflow ON campaign_outlets(workflow_name);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_buffer ON campaign_outlets(campaign_id, status, relevance_score DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_dedup ON campaign_outlets(org_id, brand_id, outlet_id) WHERE status = 'served';
CREATE INDEX IF NOT EXISTS idx_idempotency_cache_created ON idempotency_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_outlets_url ON outlets(outlet_url);
CREATE INDEX IF NOT EXISTS idx_outlets_domain ON outlets(outlet_domain);
`;

export async function runMigration(): Promise<void> {
  console.log("Running migration...");
  await pool.query(migration);
  console.log("Migration complete.");
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
