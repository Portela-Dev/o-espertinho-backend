ALTER TABLE review_ai_settings ADD COLUMN category_version integer NOT NULL DEFAULT 1,
 ADD COLUMN product_version integer NOT NULL DEFAULT 1;
COMMENT ON COLUMN review_ai_settings.category_version IS 'Only category flag/prompt changes invalidate category proposals.';
COMMENT ON COLUMN review_ai_settings.product_version IS 'Only product flag/prompt changes invalidate product proposals.';
