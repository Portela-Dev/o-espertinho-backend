-- New types are resolved on demand; inserting one must not requeue the entire catalog.
CREATE OR REPLACE FUNCTION enqueue_catalog_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  INSERT INTO catalog_identity_pending(product_id)
  SELECT product_id FROM catalog_product_identities WHERE policy_id=NEW.id
  ON CONFLICT(product_id) DO UPDATE SET version=catalog_identity_pending.version+1;
 END IF;
 RETURN NEW;
END $$;

-- "skipped" is only for obsolete work or items already handled by an admin.
ALTER TABLE catalog_resolver_items DROP CONSTRAINT catalog_resolver_items_status_check;
ALTER TABLE catalog_resolver_items ADD CONSTRAINT catalog_resolver_items_status_check
 CHECK(status IN ('queued','leased','accepted','excluded','failed','skipped'));
-- Release old business rejections without deleting processing history.
UPDATE discovery_links SET catalog_resolution='{}'::jsonb,enrichment_version=enrichment_version+1
 WHERE catalog_resolution->>'outcome'='excluded';
UPDATE catalog_resolver_receipts SET result=result||jsonb_build_object('releasedForReprocessing',true,'previousSourceHash',source_hash),source_hash='released:'||source_hash
 WHERE result->>'outcome'='excluded' AND NOT coalesce((result->>'releasedForReprocessing')::boolean,false);
