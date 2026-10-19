-- Product details and breadcrumbs belong to the individual product extraction profile.
-- Preserve discovery selectors, pagination, source bindings and all catalog data.
UPDATE discovery_profiles
SET config = jsonb_set(config, '{extraction}',
    (config->'extraction') - ARRAY['titleSelector','priceSelector','imageSelector','imageAttribute','brandSelector','descriptionSelector','categorySelector','categoryScope','categorySeparator']),
    version = version + 1,
    updated_at = clock_timestamp()
WHERE (config->'extraction') ?| ARRAY['titleSelector','priceSelector','imageSelector','imageAttribute','brandSelector','descriptionSelector','categorySelector','categoryScope','categorySeparator'];
