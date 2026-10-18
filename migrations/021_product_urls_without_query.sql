-- Only product destinations are normalized. Affiliate and image URLs remain intact.
CREATE FUNCTION clean_product_destination(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT regexp_replace(value, '[?#].*$', '') $$;

UPDATE offers SET product_url=clean_product_destination(product_url)
WHERE product_url ~ '[?#]';
UPDATE offer_import_previews SET source_url=clean_product_destination(source_url),
 result=CASE WHEN jsonb_typeof(result->'productUrl')='string'
 THEN jsonb_set(result,'{productUrl}',to_jsonb(clean_product_destination(result->>'productUrl')))
 ELSE result END
WHERE source_url ~ '[?#]' OR result->>'productUrl' ~ '[?#]';

-- Cover every import path, including direct manual/API inserts and future writers.
CREATE FUNCTION normalize_offer_product_destination() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN
 NEW.product_url=clean_product_destination(NEW.product_url);
 RETURN NEW;
END $$;
CREATE TRIGGER normalize_offer_product_destination
BEFORE INSERT OR UPDATE OF product_url ON offers
FOR EACH ROW EXECUTE FUNCTION normalize_offer_product_destination();

CREATE FUNCTION normalize_preview_product_destination() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN
 NEW.source_url=clean_product_destination(NEW.source_url);
 IF jsonb_typeof(NEW.result->'productUrl')='string' THEN
  NEW.result=jsonb_set(NEW.result,'{productUrl}',to_jsonb(clean_product_destination(NEW.result->>'productUrl')));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER normalize_preview_product_destination
BEFORE INSERT OR UPDATE OF source_url,result ON offer_import_previews
FOR EACH ROW EXECUTE FUNCTION normalize_preview_product_destination();
