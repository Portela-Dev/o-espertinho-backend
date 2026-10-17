-- Preserve existing products, links and remembered classifications.
CREATE TABLE category_nodes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 path TEXT[] NOT NULL,
 normalized_path TEXT[] NOT NULL UNIQUE,
 CHECK (array_ndims(path)=1 AND cardinality(path) BETWEEN 1 AND 10),
 CHECK (cardinality(path)=cardinality(normalized_path))
);
CREATE FUNCTION register_category_path(input_path TEXT[]) RETURNS TABLE(names TEXT[],ids UUID[]) LANGUAGE plpgsql AS $$
DECLARE part TEXT; canonical TEXT[] := '{}'; keys TEXT[] := '{}'; node category_nodes%ROWTYPE; node_ids UUID[] := '{}';
BEGIN
 IF input_path IS NULL OR array_ndims(input_path) IS DISTINCT FROM 1 OR cardinality(input_path) NOT BETWEEN 1 AND 10 THEN
  RAISE EXCEPTION 'Informe uma categoria e no máximo 10 níveis.' USING ERRCODE='23514';
 END IF;
 FOREACH part IN ARRAY input_path LOOP
  part := btrim(regexp_replace(part, '\s+', ' ', 'g'));
  IF part IS NULL OR length(part) NOT BETWEEN 1 AND 80 THEN
   RAISE EXCEPTION 'Cada nível deve conter de 1 a 80 caracteres.' USING ERRCODE='23514';
  END IF;
  canonical := array_append(canonical,part); keys := array_append(keys,lower(part));
  INSERT INTO category_nodes(path,normalized_path) VALUES(canonical,keys)
   ON CONFLICT(normalized_path) DO UPDATE SET path=category_nodes.path RETURNING * INTO node;
  canonical := node.path; node_ids := array_append(node_ids,node.id);
 END LOOP;
 RETURN QUERY SELECT canonical,node_ids;
END $$;
-- Remember unused options as well, with the original spelling.
DO $$ DECLARE option RECORD; BEGIN
 FOR option IN SELECT category,subcategory FROM offer_category_options ORDER BY category,subcategory LOOP
  PERFORM * FROM register_category_path(CASE WHEN option.subcategory='' THEN ARRAY[option.category] ELSE ARRAY[option.category,option.subcategory] END);
 END LOOP;
END $$;
ALTER TABLE products ADD COLUMN category_path TEXT[], ADD COLUMN category_ids UUID[];
ALTER TABLE offers ADD COLUMN category_path TEXT[], ADD COLUMN category_ids UUID[];
CREATE FUNCTION classify_product_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.category_path IS NOT DISTINCT FROM OLD.category_path AND (NEW.category IS DISTINCT FROM OLD.category OR NEW.subcategory IS DISTINCT FROM OLD.subcategory) THEN NEW.category_path:=NULL; END IF;
 END IF;
 IF NEW.category_path IS NULL THEN NEW.category_path:=CASE WHEN NEW.subcategory='' THEN ARRAY[NEW.category] ELSE ARRAY[NEW.category,NEW.subcategory] END; END IF;
 SELECT names,ids INTO NEW.category_path,NEW.category_ids FROM register_category_path(NEW.category_path);
 NEW.category:=NEW.category_path[1]; NEW.subcategory:=COALESCE(NEW.category_path[2],'');
 RETURN NEW;
END $$;
CREATE TRIGGER products_classify_path BEFORE INSERT OR UPDATE OF category,subcategory,category_path,category_ids ON products FOR EACH ROW EXECUTE FUNCTION classify_product_path();
CREATE OR REPLACE FUNCTION classify_product_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT category,subcategory,category_path,category_ids INTO NEW.category,NEW.subcategory,NEW.category_path,NEW.category_ids FROM products WHERE id=NEW.product_id FOR SHARE;
 RETURN NEW;
END $$;
DROP TRIGGER offers_product_classification ON offers;
CREATE TRIGGER offers_product_classification BEFORE INSERT OR UPDATE OF product_id,category,subcategory,category_path,category_ids ON offers FOR EACH ROW EXECUTE FUNCTION classify_product_offer();
CREATE OR REPLACE FUNCTION propagate_product_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE offers SET category=NEW.category,subcategory=NEW.subcategory,category_path=NEW.category_path,category_ids=NEW.category_ids,updated_at=clock_timestamp() WHERE product_id=NEW.id;
 RETURN NEW;
END $$;
DROP TRIGGER products_propagate_category ON products;
CREATE TRIGGER products_propagate_category AFTER UPDATE OF category,subcategory,category_path ON products FOR EACH ROW EXECUTE FUNCTION propagate_product_category();
UPDATE products SET category_path=CASE WHEN subcategory='' THEN ARRAY[category] ELSE ARRAY[category,subcategory] END;
ALTER TABLE products ALTER COLUMN category_path SET NOT NULL, ALTER COLUMN category_ids SET NOT NULL;
ALTER TABLE offers ALTER COLUMN category_path SET NOT NULL, ALTER COLUMN category_ids SET NOT NULL;
CREATE INDEX products_category_ids_idx ON products USING gin(category_ids);
CREATE INDEX offers_category_ids_idx ON offers USING gin(category_ids);
