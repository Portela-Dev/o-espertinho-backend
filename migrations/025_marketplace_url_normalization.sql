ALTER TABLE marketplaces ADD COLUMN url_normalization_rules JSONB NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(url_normalization_rules)='array' AND jsonb_array_length(url_normalization_rules)<=20);
COMMENT ON COLUMN marketplaces.url_normalization_rules IS 'Declarative product discovery normalization. Listing and affiliate URLs are never changed. Existing discovery data is not deleted by this migration.';
