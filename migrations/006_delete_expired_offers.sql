-- Removing an offer must also invalidate its completed import preview.
-- Keeping the preview with offer_id=NULL would allow confirming it again.
ALTER TABLE offer_import_previews
 DROP CONSTRAINT offer_import_previews_offer_id_fkey;
ALTER TABLE offer_import_previews
 ADD CONSTRAINT offer_import_previews_offer_id_fkey
 FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE;
