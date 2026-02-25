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

DO $$ BEGIN
  CREATE TYPE ahref_data_type_enum AS ENUM ('authority', 'traffic');
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

-- apify_ahref (raw ahref data)
CREATE TABLE IF NOT EXISTS apify_ahref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_input TEXT NOT NULL,
  domain TEXT NOT NULL,
  data_captured_at TIMESTAMPTZ NOT NULL,
  data_type ahref_data_type_enum NOT NULL,
  mode TEXT,
  raw_data JSONB NOT NULL,
  authority_domain_rating INTEGER,
  authority_url_rating INTEGER,
  authority_backlinks INTEGER,
  authority_refdomains INTEGER,
  authority_dofollow_backlinks INTEGER,
  authority_dofollow_refdomains INTEGER,
  traffic_monthly_avg INTEGER,
  cost_monthly_avg BIGINT,
  traffic_history JSONB,
  traffic_top_pages JSONB,
  traffic_top_countries JSONB,
  traffic_top_keywords JSONB,
  overall_search_traffic BIGINT,
  overall_search_traffic_history JSONB,
  overall_search_traffic_value BIGINT,
  overall_search_traffic_value_history JSONB,
  overall_search_traffic_by_country JSONB,
  traffic_by_country JSONB,
  overall_search_traffic_keywords JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ahref_outlets (join: outlet <-> apify_ahref)
CREATE TABLE IF NOT EXISTS ahref_outlets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id UUID NOT NULL REFERENCES press_outlets(id) ON DELETE CASCADE,
  apify_ahref_id UUID NOT NULL REFERENCES apify_ahref(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_campaign ON campaign_outlets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_outlets_outlet ON campaign_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_press_categories_campaign ON press_categories(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ahref_outlets_outlet ON ahref_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_ahref_outlets_apify ON ahref_outlets(apify_ahref_id);
CREATE INDEX IF NOT EXISTS idx_apify_ahref_data_type ON apify_ahref(data_type);
CREATE INDEX IF NOT EXISTS idx_press_outlets_url ON press_outlets(outlet_url);
CREATE INDEX IF NOT EXISTS idx_press_outlets_domain ON press_outlets(outlet_domain);
CREATE INDEX IF NOT EXISTS idx_campaigns_categories_outlets_outlet ON campaigns_categories_outlets(outlet_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_categories_outlets_category ON campaigns_categories_outlets(category_id);

-- Views

-- v_outlets_dr_status: outlets with domain rating info
CREATE OR REPLACE VIEW v_outlets_dr_status AS
WITH outlet_dr_searches AS (
  SELECT
    aho.outlet_id,
    aa.authority_domain_rating,
    aa.data_captured_at,
    ROW_NUMBER() OVER (PARTITION BY aho.outlet_id ORDER BY aa.data_captured_at DESC) AS search_rank
  FROM ahref_outlets aho
  JOIN apify_ahref aa ON aho.apify_ahref_id = aa.id
  WHERE aa.data_type = 'authority'
),
latest_dr AS (
  SELECT outlet_id, authority_domain_rating AS latest_dr, data_captured_at AS latest_search_date
  FROM outlet_dr_searches WHERE search_rank = 1
),
latest_valid_dr AS (
  SELECT outlet_id, authority_domain_rating AS latest_valid_dr, data_captured_at AS latest_valid_dr_date
  FROM outlet_dr_searches WHERE authority_domain_rating IS NOT NULL AND search_rank = 1
)
SELECT
  po.id AS outlet_id,
  po.outlet_name,
  po.outlet_url,
  po.outlet_domain,
  CASE
    WHEN ld.outlet_id IS NULL THEN TRUE
    WHEN lvd.outlet_id IS NULL AND ld.latest_search_date < (NOW() - INTERVAL '1 month') THEN TRUE
    WHEN lvd.latest_valid_dr_date < (NOW() - INTERVAL '1 year') THEN TRUE
    ELSE FALSE
  END AS dr_to_update,
  CASE
    WHEN ld.outlet_id IS NULL THEN 'No DR fetched yet'
    WHEN lvd.outlet_id IS NULL AND ld.latest_search_date < (NOW() - INTERVAL '1 month') THEN 'DR fetch to retry'
    WHEN lvd.latest_valid_dr_date < (NOW() - INTERVAL '1 year') THEN 'DR outdated'
    WHEN lvd.latest_valid_dr_date >= (NOW() - INTERVAL '1 year') THEN 'DR exists < 1 year'
    WHEN lvd.outlet_id IS NULL AND ld.latest_search_date >= (NOW() - INTERVAL '1 month') THEN 'DR attempt < 1 month'
    ELSE NULL
  END AS dr_update_reason,
  ld.latest_search_date AS dr_latest_search_date,
  lvd.latest_valid_dr,
  lvd.latest_valid_dr_date,
  CASE WHEN lvd.latest_valid_dr IS NOT NULL AND lvd.latest_valid_dr < 10 THEN TRUE ELSE FALSE END AS has_low_domain_rating
FROM press_outlets po
LEFT JOIN latest_dr ld ON po.id = ld.outlet_id
LEFT JOIN latest_valid_dr lvd ON po.id = lvd.outlet_id
WHERE po.status IS NULL OR po.status <> 'to_delete';
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
