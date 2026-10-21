CREATE FUNCTION review_ai_invalidate_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.product_id IS NULL AND OLD.product_draft_id IS NOT NULL AND
 (OLD.enrichment_data->>'title',OLD.enrichment_data->>'brand',OLD.enrichment_data->>'description') IS DISTINCT FROM
 (NEW.enrichment_data->>'title',NEW.enrichment_data->>'brand',NEW.enrichment_data->>'description') THEN
  NEW.product_draft_id:=NULL;NEW.ai_resolution:=NEW.ai_resolution-'product'-'category';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER discovery_draft_metadata BEFORE UPDATE OF enrichment_data ON discovery_links FOR EACH ROW EXECUTE FUNCTION review_ai_invalidate_draft();
