ALTER TABLE offers ADD COLUMN rating double precision CHECK (rating BETWEEN 0 AND 5);
ALTER TABLE offers ADD COLUMN review_count integer CHECK (review_count BETWEEN 0 AND 1000000000);

-- Initial configuration only: the runtime extracts exclusively from editable rules.
-- Preserve custom rules if administrators have already configured these fields.
WITH defaults(host, field, selectors, mode, attribute) AS (VALUES
 ('www.amazon.com.br','rating','["#acrPopover"]'::jsonb,'attribute','title'),
 ('www.amazon.com.br','reviewCount','["#acrCustomerReviewText"]'::jsonb,'text',''),
 ('www.mercadolivre.com.br','rating','[".ui-pdp-review__rating", ".ui-pdp-review__rating-average"]'::jsonb,'text',''),
 ('www.mercadolivre.com.br','reviewCount','[".ui-pdp-review__amount"]'::jsonb,'text','')
), additions AS (
 SELECT p.marketplace_id,jsonb_agg(jsonb_build_object('field',d.field,'selectors',d.selectors,'mode',d.mode,'attribute',d.attribute,'required',false) ORDER BY d.field) AS rules
 FROM scraping_profiles p JOIN marketplaces m ON m.id=p.marketplace_id
 JOIN defaults d ON d.host=ANY(m.allowed_hosts)
 WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.rules) r WHERE r->>'field'=d.field)
 GROUP BY p.marketplace_id
)
UPDATE scraping_profiles p SET rules=p.rules||a.rules,version=p.version+1,updated_at=clock_timestamp()
FROM additions a WHERE p.marketplace_id=a.marketplace_id;
