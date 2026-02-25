import { pool } from "./pool";

const migration = `
-- Enums
DO $$ BEGIN
  CREATE TYPE outlet_status_enum AS ENUM ('open', 'ended', 'denied');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE press_category_scope_enum AS ENUM (
    'city', 'state_or_province', 'country', 'multi-country_region', 'international'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- press_outlets (maps to aied_outlets in legacy DB)
CREATE TABLE IF NOT EXISTS press_outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_name TEXT NOT NULL,
  outlet_url TEXT NOT NULL UNIQUE,
  outlet_domain TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- campaign_outlets (join table: campaign <-> outlet with relevance)
CREATE TABLE IF NOT EXISTS campaign_outlets (
  campaign_id UUID NOT NULL,
  outlet_id UUID NOT NULL REFERENCES press_outlets(id) ON DELETE CASCADE,
  why_relevant TEXT NOT NULL,
  why_not_relevant TEXT NOT NULL,
  relevance_score NUMERIC(5,2) NOT NULL,
  status outlet_status_enum NOT NULL DEFAULT 'open',
  overal_relevance TEXT,
  relevance_rationale TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, outlet_id)
);

-- press_categories
CREATE TABLE IF NOT EXISTS press_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  category_name TEXT NOT NULL,
  scope press_category_scope_enum,
  region TEXT,
  example_outlets TEXT,
  why_relevant TEXT NOT NULL DEFAULT '',
  why_not_relevant TEXT NOT NULL DEFAULT '',
  relevance_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- campaigns_categories_outlets (join table: category <-> outlet)
CREATE TABLE IF NOT EXISTS campaigns_categories_outlets (
  campaign_id UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES press_categories(id) ON DELETE CASCADE,
  outlet_id UUID NOT NULL REFERENCES press_outlets(id) ON DELETE CASCADE,
  why_relevant TEXT NOT NULL,
  why_not_relevant TEXT NOT NULL,
  relevance_score NUMERIC(5,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, category_id, outlet_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_campaign ON campaign_outlets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_outlet ON campaign_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_press_categories_campaign ON press_categories(campaign_id);
CREATE INDEX IF NOT EXISTS idx_press_outlets_url ON press_outlets(outlet_url);
CREATE INDEX IF NOT EXISTS idx_press_outlets_domain ON press_outlets(outlet_domain);
CREATE INDEX IF NOT EXISTS idx_campaigns_categories_outlets_outlet ON campaigns_categories_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_categories_outlets_category ON campaigns_categories_outlets(category_id);
`;

async function migrate() {
  console.log("Running migration...");
  await pool.query(migration);
  console.log("Migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
