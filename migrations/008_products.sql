-- Existing offers must be explicitly cleared by the operator before this migration.
-- No data is silently removed when migrations run on another environment.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM offers) OR EXISTS(SELECT 1 FROM offer_import_previews) THEN
  RAISE EXCEPTION 'Esvazie links e previas antes da migration 008 de produtos.';
 END IF;
END $$;
CREATE SEQUENCE product_sku_sequence;
CREATE TABLE products (
 id UUID PRIMARY KEY,
 sku TEXT NOT NULL UNIQUE DEFAULT ('ESP-' || lpad(nextval('product_sku_sequence')::text,8,'0')),
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
 description TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '', image_url TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_idx ON products(lower(name));
ALTER TABLE offers ADD COLUMN product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT;
CREATE INDEX offers_product_idx ON offers(product_id,status,expires_at);
ALTER TABLE offers ADD COLUMN seller_name TEXT NOT NULL DEFAULT '';
ALTER TABLE offers DROP CONSTRAINT offers_marketplace_id_external_id_key;
CREATE INDEX offers_external_idx ON offers(marketplace_id,external_id);
CREATE UNIQUE INDEX offers_marketplace_affiliate_idx ON offers(marketplace_id,affiliate_url);
ALTER TABLE offer_import_previews ADD COLUMN product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT;
ALTER TABLE offer_import_previews ADD COLUMN product_updated_at TIMESTAMPTZ NOT NULL;
-- Classification belongs to the product. Keep legacy offer fields synchronized for existing clients.
DROP TRIGGER offers_remember_category ON offers;
CREATE TRIGGER products_remember_category AFTER INSERT OR UPDATE OF category,subcategory ON products
 FOR EACH ROW EXECUTE FUNCTION remember_offer_category();
CREATE FUNCTION classify_product_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT category,subcategory INTO NEW.category,NEW.subcategory FROM products WHERE id=NEW.product_id FOR SHARE;
 RETURN NEW;
END $$;
CREATE TRIGGER offers_product_classification BEFORE INSERT OR UPDATE OF product_id,category,subcategory ON offers
 FOR EACH ROW EXECUTE FUNCTION classify_product_offer();
CREATE FUNCTION propagate_product_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE offers SET category=NEW.category,subcategory=NEW.subcategory,updated_at=clock_timestamp() WHERE product_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER products_propagate_category AFTER UPDATE OF category,subcategory ON products
 FOR EACH ROW EXECUTE FUNCTION propagate_product_category();
-- Search results cannot choose the product on behalf of an administrator.
UPDATE search_rules SET enabled=false;
