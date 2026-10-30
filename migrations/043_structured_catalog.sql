-- Additive resolver: legacy data and identifiers remain unchanged.
CREATE TABLE catalog_resolver_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), version integer NOT NULL DEFAULT 1,
 mode text NOT NULL DEFAULT 'shadow' CHECK(mode IN ('legacy','shadow','active')),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
 concurrency integer NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 2),
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO catalog_resolver_settings(id) VALUES(true);
CREATE TABLE catalog_identity_policies (
 id text PRIMARY KEY, version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true,
 definition jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE catalog_product_identities (
 product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 policy_id text NOT NULL REFERENCES catalog_identity_policies(id), policy_version integer NOT NULL,
 fingerprint text, identity jsonb NOT NULL, source_hash text NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX catalog_identity_lookup ON catalog_product_identities(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX catalog_product_search ON products USING gin(to_tsvector('simple',coalesce(name,'')||' '||coalesce(brand,'')||' '||coalesce(model,'')));
CREATE INDEX catalog_category_search ON category_nodes USING gin(to_tsvector('simple',coalesce(path[array_length(path,1)],'')));

CREATE TABLE catalog_resolver_runs (
 id uuid PRIMARY KEY, request_key uuid NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 extension_session_id uuid NOT NULL, marketplace_id text NOT NULL REFERENCES marketplaces(id),
 task text NOT NULL CHECK(task IN ('product','category')), mode text NOT NULL CHECK(mode IN ('shadow','active')),
 settings_version integer NOT NULL, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','cancelled','completed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(created_by,request_key)
);
CREATE TABLE catalog_resolver_items (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES catalog_resolver_runs(id) ON DELETE CASCADE,
 link_id uuid REFERENCES discovery_links(id) ON DELETE CASCADE,
 product_id uuid REFERENCES products(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','accepted','excluded','failed')),
 attempts integer NOT NULL DEFAULT 0, lease_id uuid, lease_until timestamptz, retry_at timestamptz,
 source_hash text, context jsonb, decision jsonb, result_hash text,
 calls integer NOT NULL DEFAULT 0, tokens integer NOT NULL DEFAULT 0, elapsed_ms integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(run_id,link_id)
);
CREATE INDEX catalog_resolver_queue ON catalog_resolver_items(run_id,status,retry_at);
CREATE INDEX catalog_resolver_link_lease ON catalog_resolver_items(link_id,lease_until) WHERE status='leased';
CREATE TABLE catalog_resolver_drafts (
 draft_id uuid PRIMARY KEY REFERENCES review_ai_product_drafts(id) ON DELETE CASCADE,
 fingerprint text NOT NULL UNIQUE, identity jsonb NOT NULL, policy_id text NOT NULL REFERENCES catalog_identity_policies(id),
 policy_version integer NOT NULL
);
CREATE TABLE catalog_resolver_receipts (
 link_id uuid NOT NULL REFERENCES discovery_links(id) ON DELETE CASCADE,
 task text NOT NULL, source_hash text NOT NULL, policy_version integer NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(link_id,task)
);
ALTER TABLE discovery_links ADD COLUMN catalog_resolution jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE FUNCTION clear_catalog_exclusion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.enrichment_data - 'priceCents' - 'originalPriceCents') IS DISTINCT FROM (NEW.enrichment_data - 'priceCents' - 'originalPriceCents') THEN NEW.catalog_resolution='{}'::jsonb; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER discovery_clear_catalog_exclusion BEFORE UPDATE OF enrichment_data ON discovery_links FOR EACH ROW EXECUTE FUNCTION clear_catalog_exclusion();

INSERT INTO catalog_identity_policies(id,definition) VALUES('smartphone','{"id":"smartphone","version":1,"name":"Smartphones","terms":["smartphone","celular","iphone"],"attributes":[{"key":"brand","label":"Marca","required":true,"aliases":["fabricante"],"unit":"text","values":{}},{"key":"model","label":"Modelo","required":true,"aliases":["modelo do produto"],"unit":"text","values":{}},{"key":"storage","label":"Armazenamento","required":true,"aliases":["capacidade de armazenamento","memória interna"],"unit":"gb","values":{}},{"key":"ram","label":"RAM física","required":true,"aliases":["memória ram","ram"],"unit":"gb","values":{}}],"categoryId":null,"exclusive":false,"priority":0}');

INSERT INTO catalog_identity_policies(id,definition) VALUES('kit','{"id":"kit","version":1,"name":"Kits personalizados","terms":["kit","combo"],"attributes":[{"key":"composition","label":"Composição e quantidade selecionada","required":true,"aliases":["conteúdo da embalagem"],"unit":"text","values":{}}],"categoryId":null,"exclusive":true,"priority":100}');

INSERT INTO catalog_identity_policies(id,definition) VALUES('accessory','{"id":"accessory","version":1,"name":"Acessórios e peças","terms":["capa","película","tampa traseira"],"attributes":[{"key":"brand","label":"Marca","required":true,"aliases":["fabricante"],"unit":"text","values":{}},{"key":"model","label":"Modelo da peça","required":true,"aliases":["modelo"],"unit":"text","values":{}},{"key":"compatibility","label":"Compatibilidade","required":true,"aliases":["modelo compatível"],"unit":"text","values":{}}],"categoryId":null,"exclusive":false,"priority":20}');

CREATE UNIQUE INDEX catalog_one_link_lease ON catalog_resolver_items(link_id) WHERE status='leased' AND link_id IS NOT NULL;
CREATE UNIQUE INDEX catalog_one_product_lease ON catalog_resolver_items(product_id) WHERE status='leased' AND product_id IS NOT NULL;

ALTER TABLE catalog_resolver_items ADD COLUMN evaluation text CHECK(evaluation IN ('correct','false_merge','duplicate','wrong_category','excluded_valid'));
