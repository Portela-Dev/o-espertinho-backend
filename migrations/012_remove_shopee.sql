-- Remove only the retired marketplace and its dependent records.
-- Amazon/Mercado Livre credentials, OAuth and converter sessions are not changed.
SELECT pg_advisory_xact_lock(728149,1);
LOCK TABLE offer_refresh_settings IN EXCLUSIVE MODE;
CREATE TEMP TABLE retired_offer_ids ON COMMIT DROP AS SELECT id FROM offers WHERE marketplace_id='shopee';
CREATE TEMP TABLE affected_refresh_runs ON COMMIT DROP AS SELECT DISTINCT run_id FROM offer_refresh_items WHERE marketplace_id='shopee';
DELETE FROM audit_logs WHERE entity_id='shopee' OR entity_id IN (SELECT id::text FROM retired_offer_ids);
DELETE FROM saved_filters WHERE filters->>'marketplace'='shopee';
DELETE FROM offer_refresh_items WHERE marketplace_id='shopee';
DELETE FROM offers WHERE marketplace_id='shopee';
DELETE FROM click_events WHERE marketplace_id='shopee';
DELETE FROM sync_runs WHERE marketplace_id='shopee';
DELETE FROM search_rules WHERE marketplace_id='shopee';
DELETE FROM marketplaces WHERE id='shopee';
UPDATE offer_refresh_runs r SET
 total=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id),
 processed=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id AND status='done'),
 updated=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id AND outcome='updated'),
 unavailable=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id AND outcome='unavailable'),
 pending=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id AND outcome='pending'),
 skipped=(SELECT count(*) FROM offer_refresh_items WHERE run_id=r.id AND outcome='skipped')
 WHERE id IN (SELECT run_id FROM affected_refresh_runs);
DELETE FROM offer_refresh_runs WHERE id IN (SELECT run_id FROM affected_refresh_runs) AND total=0;
UPDATE offer_refresh_runs SET status='completed',finished_at=COALESCE(finished_at,clock_timestamp()) WHERE id IN (SELECT run_id FROM affected_refresh_runs) AND processed=total;
