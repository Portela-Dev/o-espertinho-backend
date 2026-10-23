-- Retire browser workers without deleting historical or encrypted persistent data.
UPDATE discovery_runs SET status='cancelled',stop_reason='executor_retired',finished_at=clock_timestamp(),worker_id=NULL,lease_until=NULL WHERE status IN ('queued','running');
UPDATE enrichment_items SET status='cancelled',finished_at=clock_timestamp() WHERE status IN ('queued','running');
UPDATE enrichment_runs SET status='cancelled',error='executor_retired',finished_at=clock_timestamp(),worker_id=NULL,lease_until=NULL WHERE status IN ('queued','running') OR worker_id IS NOT NULL;
UPDATE offer_refresh_items SET status='done',outcome='skipped',error='executor_retired',finished_at=clock_timestamp(),attempt_id=NULL,lease_until=NULL WHERE status<>'done';
UPDATE offer_refresh_runs SET status='cancelled',cancelled_at=clock_timestamp(),finished_at=clock_timestamp() WHERE status IN ('queued','running');
UPDATE offer_refresh_settings SET enabled=false;
UPDATE search_rules SET enabled=false;
UPDATE sync_runs SET status='failed',error='executor_retired',finished_at=clock_timestamp() WHERE status='running';
INSERT INTO extension_catalog_settings(marketplace_id,config)
 SELECT marketplace_id,jsonb_build_object('intervalMs',request_interval_ms,'categorySeparator',category_separator) FROM enrichment_settings
 ON CONFLICT(marketplace_id) DO NOTHING;
UPDATE marketplaces SET catalog_executor='extension';
ALTER TABLE marketplaces ALTER COLUMN catalog_executor SET DEFAULT 'extension';
ALTER TABLE marketplaces ADD CONSTRAINT marketplaces_extension_only CHECK(catalog_executor='extension');
COMMENT ON TABLE discovery_runs IS 'Retired browser worker history. No active producer/consumer; preserved for audit.';
COMMENT ON TABLE enrichment_runs IS 'Retired browser worker history; current review uses discovery_links/category_mappings.';
COMMENT ON TABLE offer_refresh_runs IS 'Retired browser worker history; current prices use extension_catalog_runs/offer_price_history.';
COMMENT ON TABLE search_rules IS 'Retired automated-search configuration, disabled and without runtime consumer.';
COMMENT ON TABLE affiliate_proof_recipes IS 'Retired POC recipe archive. Copied by migration 030; no runtime consumer.';
COMMENT ON TABLE amazon_sitestripe_session IS 'Retired encrypted session archive. No runtime consumer or runtime grant.';
COMMENT ON TABLE amazon_browser_session IS 'Retired encrypted session archive. No runtime consumer or runtime grant.';
COMMENT ON TABLE marketplace_oauth_states IS 'Retired OAuth state archive. No runtime consumer or runtime grant.';
