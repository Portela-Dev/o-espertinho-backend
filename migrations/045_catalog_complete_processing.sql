-- Preserve history and data; the retired mode no longer has an executable client.
UPDATE catalog_resolver_settings SET mode='shadow',version=version+1 WHERE mode='legacy';
-- Internal identity is not an editable commercial type and cannot be disabled through policy APIs.
INSERT INTO catalog_identity_policies(id,definition) VALUES('_title',
 '{"name":"Identidade por título","terms":["produto"],"attributes":[{"key":"title","label":"Título","required":true,"aliases":[],"unit":"text","values":{}}],"exclusive":false,"categoryId":null,"priority":0}');
CREATE FUNCTION catalog_category_key(parts text[]) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT string_agg(part_key,'>' ORDER BY ordinal) FROM (
  SELECT ordinal, (SELECT string_agg(CASE WHEN length(word)>4 THEN regexp_replace(word,'s$','') ELSE word END,' ' ORDER BY position)
   FROM regexp_split_to_table(btrim(regexp_replace(translate(lower(part),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),'[^a-z0-9]+',' ','g')),' +') WITH ORDINALITY AS words(word,position)) AS part_key
  FROM unnest(parts) WITH ORDINALITY AS parts(part,ordinal)
 ) AS normalized
$$;
CREATE INDEX catalog_category_equivalence ON category_nodes(catalog_category_key(path));
-- Failed AI analyses are work to complete, never terminal product decisions.
UPDATE catalog_resolver_items SET status='queued',retry_at=NULL,lease_id=NULL,lease_until=NULL
WHERE status IN ('failed','excluded') AND run_id IN (SELECT id FROM catalog_resolver_runs WHERE status IN ('running','paused'));
-- Retain the prior AI payload while releasing historical business vetoes for pending links.
UPDATE discovery_links SET
 ai_resolution=jsonb_build_object('previousDecision',ai_resolution),
 catalog_resolution=jsonb_build_object('previousDecision',catalog_resolution),
 enrichment_version=enrichment_version+1
WHERE status='pending' AND published_offer_id IS NULL AND
 (ai_resolution->'product'->>'action' IN ('invalid','needs_review') OR
  ai_resolution->'category'->>'action' IN ('invalid','needs_review') OR
  catalog_resolution->>'outcome' IN ('excluded','invalid','needs_review'));
