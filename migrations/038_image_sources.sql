-- Editable profile data; no marketplace-specific extraction logic.
WITH gallery AS (
 SELECT p.marketplace_id,COALESCE(jsonb_agg(r ORDER BY n) FILTER (WHERE r->>'field'<>'images'),'[]'::jsonb) AS other_rules
 FROM scraping_profiles p JOIN marketplaces m ON m.id=p.marketplace_id
 CROSS JOIN LATERAL jsonb_array_elements(p.rules) WITH ORDINALITY AS rules(r,n)
 WHERE 'www.amazon.com.br'=ANY(m.allowed_hosts)
 GROUP BY p.marketplace_id
)
UPDATE scraping_profiles p SET rules=g.other_rules||jsonb_build_array(
 jsonb_build_object('field','images','mode','json','selectors',jsonb_build_array('#imageBlock_feature_div script, #mediaBlock_feature_div script','script:not([src])'),'jsonMarker', $marker$'initial':$marker$,'jsonPath','','imageProperties',jsonb_build_array('hiRes','large'),'imageSource','append','required',false),
 jsonb_build_object('field','images','mode','json','selectors',jsonb_build_array('#imageBlock_feature_div script, #mediaBlock_feature_div script','script:not([src])'),'jsonMarker','"initial":','jsonPath','','imageProperties',jsonb_build_array('hiRes','large'),'imageSource','fallback','required',false),
 jsonb_build_object('field','images','mode','attribute','attribute','src','attributes',jsonb_build_array('data-src'),'selectors',jsonb_build_array('#altImages .imageThumbnail img'),'imageSource','fallback','required',false),
 jsonb_build_object('field','images','mode','attribute','attribute','data-old-hires','attributes',jsonb_build_array('src'),'selectors',jsonb_build_array('#landingImage','#imgBlkFront'),'imageSource','fallback','required',false)
),version=p.version+1,updated_at=clock_timestamp()
FROM gallery g WHERE p.marketplace_id=g.marketplace_id;

-- Prefer zoom, falling back per element; use metadata only when no gallery exists.
UPDATE scraping_profiles p SET rules=(SELECT jsonb_agg(
 CASE WHEN r->>'field'<>'images' THEN r
 WHEN r->>'attribute'='data-zoom' THEN r||'{"attributes":["src"],"imageSource":"append"}'::jsonb
 ELSE r||'{"imageSource":"fallback"}'::jsonb END ORDER BY n)
 FROM jsonb_array_elements(p.rules) WITH ORDINALITY AS rules(r,n)
),version=p.version+1,updated_at=clock_timestamp()
FROM marketplaces m WHERE p.marketplace_id=m.id AND 'www.mercadolivre.com.br'=ANY(m.allowed_hosts);
