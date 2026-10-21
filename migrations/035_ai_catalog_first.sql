CREATE TABLE review_ai_product_drafts (
 id uuid PRIMARY KEY, identity_key text NOT NULL UNIQUE, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 300),
 description text NOT NULL DEFAULT '',brand text NOT NULL DEFAULT '',image_url text,
 product_id uuid REFERENCES products(id) ON DELETE SET NULL,version integer NOT NULL DEFAULT 1,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE discovery_links ADD COLUMN product_draft_id uuid REFERENCES review_ai_product_drafts(id) ON DELETE SET NULL;
CREATE INDEX discovery_link_draft_idx ON discovery_links(product_draft_id) WHERE product_draft_id IS NOT NULL;
CREATE TABLE review_ai_inventory_state(id boolean PRIMARY KEY DEFAULT true CHECK(id),revision bigint NOT NULL DEFAULT 1);
INSERT INTO review_ai_inventory_state(id) VALUES(true);
CREATE FUNCTION review_ai_inventory_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 UPDATE review_ai_inventory_state SET revision=revision+1 WHERE id=true;RETURN NULL;
END $$;
CREATE TRIGGER review_ai_products_revision AFTER INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION review_ai_inventory_changed();
CREATE TRIGGER review_ai_categories_revision AFTER INSERT OR UPDATE OR DELETE ON category_nodes FOR EACH ROW EXECUTE FUNCTION review_ai_inventory_changed();
CREATE TRIGGER review_ai_drafts_revision AFTER INSERT OR UPDATE OR DELETE ON review_ai_product_drafts FOR EACH ROW EXECUTE FUNCTION review_ai_inventory_changed();
COMMENT ON TABLE review_ai_product_drafts IS 'Provisional product identities, never public products. Category application atomically creates product and assigns its links.';
ALTER TABLE discovery_links ADD COLUMN ai_resolution jsonb NOT NULL DEFAULT '{}'::jsonb;
