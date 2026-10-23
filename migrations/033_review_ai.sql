CREATE TABLE review_ai_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), version integer NOT NULL DEFAULT 1,
 category_enabled boolean NOT NULL DEFAULT false, product_enabled boolean NOT NULL DEFAULT false,
 category_prompt text NOT NULL DEFAULT 'Sugira a árvore mais adequada ao produto. Prefira categorias existentes e explique ambiguidades.',
 product_prompt text NOT NULL DEFAULT 'Compare marca, modelo, geração e quantidade com os candidatos. Cor, tamanho e tensão isoladamente não distinguem produtos. Sugira criação apenas quando os dados forem suficientes.',
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO review_ai_settings(id) VALUES(true);
CREATE TABLE review_ai_suggestions (
 link_id uuid NOT NULL REFERENCES discovery_links(id) ON DELETE CASCADE,
 task text NOT NULL CHECK(task IN ('category','product')), request_id uuid UNIQUE NOT NULL,
 link_version integer NOT NULL, settings_version integer NOT NULL,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 request_context jsonb NOT NULL, suggestion jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(link_id,task)
);
CREATE INDEX review_ai_pending_idx ON review_ai_suggestions(link_id,link_version) WHERE suggestion IS NOT NULL;
COMMENT ON TABLE review_ai_suggestions IS 'Untrusted AI proposals only; explicit existing admin confirmation routes apply category/product changes. No OAuth credentials.';
