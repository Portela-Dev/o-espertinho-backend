CREATE TABLE affiliate_proof_recipes (
 marketplace_id TEXT PRIMARY KEY REFERENCES marketplaces(id) ON DELETE CASCADE,
 recipe JSONB NOT NULL CHECK(jsonb_typeof(recipe)='object'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE affiliate_proof_recipes IS 'Declarative non-production conversion recipes. Never store cookies, CSRF values or session tokens.';
