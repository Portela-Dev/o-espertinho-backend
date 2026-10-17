ALTER TABLE offers ADD COLUMN subcategory TEXT NOT NULL DEFAULT ''
 CHECK (length(subcategory)<=80);

-- Remember classification options even after their last offer is edited/deleted.
CREATE TABLE offer_category_options (
 category TEXT NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 80),
 subcategory TEXT NOT NULL DEFAULT '' CHECK (length(subcategory)<=80),
 PRIMARY KEY (category,subcategory)
);
CREATE UNIQUE INDEX offer_category_options_normalized_idx
 ON offer_category_options(lower(category),lower(subcategory));
INSERT INTO offer_category_options(category)
 SELECT DISTINCT category FROM offers WHERE btrim(category)<>'' ON CONFLICT DO NOTHING;
INSERT INTO offer_category_options(category) VALUES('Outros') ON CONFLICT DO NOTHING;

CREATE FUNCTION remember_offer_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO offer_category_options(category) VALUES(NEW.category) ON CONFLICT DO NOTHING;
 IF NEW.subcategory<>'' THEN
  INSERT INTO offer_category_options(category,subcategory)
   VALUES(NEW.category,NEW.subcategory) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER offers_remember_category
 AFTER INSERT OR UPDATE OF category,subcategory ON offers
 FOR EACH ROW EXECUTE FUNCTION remember_offer_category();
