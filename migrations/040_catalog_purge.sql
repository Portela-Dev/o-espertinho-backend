ALTER TABLE offers ADD COLUMN unavailable_since timestamptz;
ALTER TABLE offers ADD COLUMN failure_since timestamptz;
ALTER TABLE discovery_links ADD COLUMN unavailable_since timestamptz;
ALTER TABLE discovery_links ADD COLUMN failure_since timestamptz;
ALTER TABLE products ADD COLUMN no_offers_since timestamptz DEFAULT clock_timestamp();

-- Last observations are conservative lower bounds, not invented first failures.
UPDATE offers SET unavailable_since=LEAST(data_updated_at,clock_timestamp()) WHERE availability_status='unavailable';
UPDATE offers SET failure_since=LEAST(COALESCE(last_refresh_attempt_at,clock_timestamp()),clock_timestamp())
 WHERE refresh_status='pending' AND NULLIF(last_refresh_error,'') IS NOT NULL;
UPDATE discovery_links SET unavailable_since=LEAST(COALESCE(extracted_at,clock_timestamp()),clock_timestamp())
 WHERE enrichment_data->>'availability'='unavailable';
UPDATE discovery_links l SET failure_since=COALESCE((SELECT LEAST(max(i.updated_at),clock_timestamp()) FROM extension_catalog_items i WHERE i.target_id=l.id AND i.status='failed'),clock_timestamp()) WHERE extraction_status='failed';
-- A former offer could have been deleted. Start tracking existing empty products now.
UPDATE products p SET no_offers_since=CASE WHEN EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id) THEN NULL ELSE clock_timestamp() END;

CREATE FUNCTION catalog_track_offer_health() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.availability_status='unavailable' THEN
  IF TG_OP='UPDATE' THEN NEW.unavailable_since:=COALESCE(OLD.unavailable_since,clock_timestamp());
  ELSE NEW.unavailable_since:=clock_timestamp(); END IF;
 ELSE NEW.unavailable_since:=NULL; END IF;
 IF NEW.refresh_status='pending' AND NULLIF(NEW.last_refresh_error,'') IS NOT NULL THEN
  IF TG_OP='UPDATE' THEN NEW.failure_since:=COALESCE(OLD.failure_since,clock_timestamp());
  ELSE NEW.failure_since:=clock_timestamp(); END IF;
 ELSE NEW.failure_since:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_offer_health BEFORE INSERT OR UPDATE OF availability_status,refresh_status,last_refresh_error ON offers FOR EACH ROW EXECUTE FUNCTION catalog_track_offer_health();

CREATE FUNCTION catalog_track_discovery_health() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.enrichment_data->>'availability'='unavailable' THEN
  IF TG_OP='UPDATE' THEN NEW.unavailable_since:=COALESCE(OLD.unavailable_since,clock_timestamp());
  ELSE NEW.unavailable_since:=clock_timestamp(); END IF;
 ELSE NEW.unavailable_since:=NULL; END IF;
 IF NEW.extraction_status='failed' THEN
  IF TG_OP='UPDATE' THEN NEW.failure_since:=COALESCE(OLD.failure_since,clock_timestamp());
  ELSE NEW.failure_since:=clock_timestamp(); END IF;
 ELSIF NEW.extraction_status='completed' OR TG_OP='INSERT' THEN NEW.failure_since:=NULL;
 ELSE NEW.failure_since:=OLD.failure_since; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_discovery_health BEFORE INSERT OR UPDATE OF enrichment_data,extraction_status ON discovery_links FOR EACH ROW EXECUTE FUNCTION catalog_track_discovery_health();

CREATE FUNCTION catalog_track_product_presence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refs uuid[]; ref uuid;
BEGIN
 IF TG_OP='INSERT' THEN refs:=ARRAY[NEW.product_id];
 ELSIF TG_OP='DELETE' THEN refs:=ARRAY[OLD.product_id];
 ELSE IF OLD.product_id=NEW.product_id THEN RETURN NULL; END IF; refs:=ARRAY[OLD.product_id,NEW.product_id]; END IF;
 FOR ref IN SELECT DISTINCT x FROM unnest(refs) x ORDER BY x LOOP
  UPDATE products p SET no_offers_since=CASE WHEN EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id) THEN NULL ELSE COALESCE(p.no_offers_since,clock_timestamp()) END
   WHERE p.id=ref AND ((p.no_offers_since IS NULL AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id)) OR (p.no_offers_since IS NOT NULL AND EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id)));
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER catalog_product_presence AFTER INSERT OR DELETE OR UPDATE OF product_id ON offers FOR EACH ROW EXECUTE FUNCTION catalog_track_product_presence();
CREATE INDEX catalog_products_empty_since ON products(no_offers_since) WHERE no_offers_since IS NOT NULL;
CREATE INDEX catalog_offers_unavailable_since ON offers(unavailable_since) WHERE unavailable_since IS NOT NULL;
CREATE INDEX catalog_offers_failure_since ON offers(failure_since) WHERE failure_since IS NOT NULL;
CREATE INDEX catalog_links_failure_since ON discovery_links(failure_since) WHERE failure_since IS NOT NULL;
CREATE INDEX catalog_links_unavailable_since ON discovery_links(unavailable_since) WHERE unavailable_since IS NOT NULL;

-- Runtime remains unable to read archived worker tables. These fixed trigger operations
-- only remove dependencies of the row being physically deleted.
CREATE FUNCTION catalog_delete_archived_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE related_runs uuid[];
BEGIN
 IF TG_TABLE_NAME='offers' THEN
  SELECT array_agg(DISTINCT run_id) INTO related_runs FROM public.offer_refresh_items WHERE offer_id=OLD.id;
  DELETE FROM public.audit_logs WHERE entity_id IN (SELECT id::text FROM public.offer_refresh_items WHERE offer_id=OLD.id);
  DELETE FROM public.offer_refresh_items WHERE offer_id=OLD.id;
  DELETE FROM public.audit_logs WHERE entity_id IN (SELECT id::text FROM public.offer_refresh_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.offer_refresh_items i WHERE i.run_id=r.id));
  DELETE FROM public.offer_refresh_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.offer_refresh_items i WHERE i.run_id=r.id);
 ELSIF TG_TABLE_NAME='discovery_links' THEN
  SELECT array_agg(DISTINCT run_id) INTO related_runs FROM public.discovery_run_links WHERE link_id=OLD.id;
  DELETE FROM public.discovery_run_links WHERE link_id=OLD.id;
  DELETE FROM public.audit_logs WHERE entity_id IN (SELECT id::text FROM public.discovery_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.discovery_run_links i WHERE i.run_id=r.id));
  DELETE FROM public.discovery_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.discovery_run_links i WHERE i.run_id=r.id);
  SELECT array_agg(DISTINCT run_id) INTO related_runs FROM public.enrichment_items WHERE link_id=OLD.id;
  DELETE FROM public.enrichment_items WHERE link_id=OLD.id;
  DELETE FROM public.audit_logs WHERE entity_id IN (SELECT id::text FROM public.enrichment_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.enrichment_items i WHERE i.run_id=r.id));
  DELETE FROM public.enrichment_runs r WHERE id=ANY(related_runs) AND NOT EXISTS(SELECT 1 FROM public.enrichment_items i WHERE i.run_id=r.id);
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION catalog_delete_archived_dependencies() FROM PUBLIC;
CREATE TRIGGER catalog_delete_offer_archive BEFORE DELETE ON offers FOR EACH ROW EXECUTE FUNCTION catalog_delete_archived_dependencies();
CREATE TRIGGER catalog_delete_link_archive BEFORE DELETE ON discovery_links FOR EACH ROW EXECUTE FUNCTION catalog_delete_archived_dependencies();

ALTER TABLE access_profiles DROP CONSTRAINT access_profiles_permissions_check;
ALTER TABLE access_profiles ADD CONSTRAINT access_profiles_permissions_check CHECK(permissions <@ ARRAY['overview','catalog','marketplaces','selectors','updates','activity','users','affiliate_links','discovery','purge']::text[]);
UPDATE access_profiles SET permissions=array_append(permissions,'purge') WHERE id='admin' AND NOT permissions @> ARRAY['purge'];
