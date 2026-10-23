-- Configuration migration only. Existing executor selections and business data are preserved.
INSERT INTO extension_catalog_settings(marketplace_id,config)
 SELECT marketplace_id,jsonb_build_object('recipe',recipe) FROM affiliate_proof_recipes
 ON CONFLICT(marketplace_id) DO NOTHING;
COMMENT ON TABLE affiliate_proof_recipes IS 'Retired POC configuration, copied to extension_catalog_settings by migration 030. Retained temporarily for rollback; no active API consumer.';
