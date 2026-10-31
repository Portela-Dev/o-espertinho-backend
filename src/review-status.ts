// One operational status per review; extraction completion is not publication.
export const reviewStates = ['pending','running','failed','invalid','needs_review','excluded','unavailable','incomplete','awaiting_affiliate','awaiting_product','awaiting_category','marketplace_disabled','ready','published','offer_pending','expired','rejected','archived'] as const;

// Aliases belong to the review query. Filtering and display share this expression.
export const reviewStatusSql = `CASE
 WHEN l.status='archived' THEN 'archived'
 WHEN publication.id IS NOT NULL THEN CASE publication.status
   WHEN 'published' THEN 'published' WHEN 'expired' THEN 'expired'
   WHEN 'rejected' THEN 'rejected' ELSE 'offer_pending' END
 WHEN l.extraction_status='running' THEN 'running'
 WHEN l.extraction_status NOT IN ('completed','failed') THEN 'pending'
 WHEN l.ai_resolution->'product'->>'action'='invalid' OR l.ai_resolution->'category'->>'action'='invalid' THEN 'invalid'
 WHEN l.extraction_status='failed' THEN 'failed'
 WHEN l.enrichment_data->>'availability'='unavailable' THEN 'unavailable'
 WHEN NOT m.scraping_enabled THEN 'marketplace_disabled'
 WHEN profile.marketplace_id IS NULL
   OR COALESCE(btrim(l.enrichment_data->>'title'),'')=''
   OR COALESCE(l.enrichment_data->>'priceCents','') !~ '^[1-9][0-9]*$'
   OR COALESCE(l.enrichment_data->'missing','[]'::jsonb)<>'[]'::jsonb THEN 'incomplete'
 WHEN COALESCE(l.affiliate_url,'')='' THEN 'awaiting_affiliate'
 WHEN (l.ai_resolution->'product'->>'action'='needs_review' AND l.product_id IS NULL AND l.product_draft_id IS NULL)
   OR (l.ai_resolution->'category'->>'action'='needs_review' AND l.confirmed_category_id IS NULL) THEN 'needs_review'
 WHEN p.id IS NULL AND l.product_draft_id IS NOT NULL THEN 'awaiting_category'
 WHEN p.id IS NULL THEN 'awaiting_product'
 WHEN l.confirmed_category_id IS NULL OR NOT (l.confirmed_category_id=ANY(p.category_ids)) THEN 'awaiting_category'
 ELSE 'ready' END`;
