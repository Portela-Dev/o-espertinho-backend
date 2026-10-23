ALTER TABLE discovery_links
 ADD COLUMN product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
 ADD COLUMN product_assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
 ADD COLUMN product_assigned_at TIMESTAMPTZ,
 ADD CONSTRAINT discovery_product_requires_category CHECK (product_id IS NULL OR confirmed_category_id IS NOT NULL);
CREATE INDEX discovery_links_product ON discovery_links(product_id) WHERE product_id IS NOT NULL;

-- Also covers category invalidation performed by the enrichment worker.
CREATE FUNCTION invalidate_discovery_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.confirmed_category_id IS DISTINCT FROM OLD.confirmed_category_id THEN
  NEW.product_id := NULL;
  NEW.product_assigned_by := NULL;
  NEW.product_assigned_at := NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER discovery_category_product BEFORE UPDATE OF confirmed_category_id ON discovery_links
 FOR EACH ROW EXECUTE FUNCTION invalidate_discovery_product();

-- Moving a catalog product out of the confirmed branch requires review again.
CREATE FUNCTION invalidate_discovery_product_category() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE discovery_links SET product_id=NULL,product_assigned_by=NULL,product_assigned_at=NULL,
  enrichment_version=enrichment_version+1
 WHERE product_id=NEW.id AND NOT (confirmed_category_id=ANY(NEW.category_ids));
 RETURN NEW;
END;
$$;
CREATE TRIGGER product_discovery_category AFTER UPDATE ON products
 FOR EACH ROW WHEN (OLD.category_ids IS DISTINCT FROM NEW.category_ids)
 EXECUTE FUNCTION invalidate_discovery_product_category();
