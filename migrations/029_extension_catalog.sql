ALTER TABLE marketplaces ADD COLUMN catalog_executor TEXT NOT NULL DEFAULT 'legacy' CHECK(catalog_executor IN ('legacy','extension'));
CREATE TABLE extension_catalog_settings (
 marketplace_id TEXT PRIMARY KEY REFERENCES marketplaces(id),
 version INTEGER NOT NULL DEFAULT 1,
 config JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE extension_catalog_runs (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 created_by UUID NOT NULL REFERENCES users(id),
 extension_id TEXT,
 step TEXT NOT NULL CHECK(step IN ('discover','convert','enrich','prices','preview','selector_test')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused_by_user','waiting_for_human','paused_technical','completed','failed','cancelled')),
 snapshot JSONB NOT NULL,
 request_key UUID NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 UNIQUE(created_by,request_key)
);
CREATE UNIQUE INDEX extension_catalog_active_market ON extension_catalog_runs(marketplace_id) WHERE status NOT IN ('completed','failed','cancelled');
CREATE TABLE extension_catalog_items (
 id UUID PRIMARY KEY,
 run_id UUID NOT NULL REFERENCES extension_catalog_runs(id) ON DELETE CASCADE,
 target_id UUID,
 payload JSONB NOT NULL,
 expected_version TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','completed','failed','skipped')),
 lease_token UUID,
 lease_until TIMESTAMPTZ,
 observed_at TIMESTAMPTZ,
 result JSONB,
 result_hash TEXT,
 error TEXT NOT NULL DEFAULT '',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX extension_catalog_items_queue ON extension_catalog_items(run_id,status);
ALTER TABLE discovery_links ADD COLUMN affiliate_url TEXT;
ALTER TABLE discovery_links ADD COLUMN converted_at TIMESTAMPTZ;
ALTER TABLE discovery_links ADD COLUMN published_offer_id UUID REFERENCES offers(id) ON DELETE SET NULL;
ALTER TABLE discovery_links ADD CONSTRAINT discovery_affiliate_url_https CHECK(affiliate_url IS NULL OR (affiliate_url LIKE 'https://%' AND length(affiliate_url)<=10000));
COMMENT ON TABLE extension_catalog_runs IS 'Browser operations performed by an authenticated Chrome extension. No marketplace sessions or credentials are accepted.';
