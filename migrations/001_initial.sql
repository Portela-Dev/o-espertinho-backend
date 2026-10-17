CREATE TABLE users (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, google_sub TEXT UNIQUE,
  name TEXT NOT NULL, avatar TEXT, role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO users (id,email,name,role) VALUES ('8b149af0-1050-4d83-8c88-bf4a64a54fbf','arnaldorolimportela@gmail.com','Administrador','admin');
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE marketplaces (
  id TEXT PRIMARY KEY CHECK (id IN ('amazon','mercadolivre','shopee')),
  name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false,
  credentials_encrypted TEXT, configuration JSONB NOT NULL DEFAULT '{}',
  connection_status TEXT NOT NULL DEFAULT 'not_configured', last_checked_at TIMESTAMPTZ,
  last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketplaces(id,name) VALUES ('amazon','Amazon'),('mercadolivre','Mercado Livre'),('shopee','Shopee');
CREATE TABLE offers (
  id UUID PRIMARY KEY, marketplace_id TEXT NOT NULL REFERENCES marketplaces(id), external_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Outros',
  image_url TEXT, product_url TEXT NOT NULL, affiliate_url TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), original_price_cents INTEGER CHECK (original_price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','expired')),
  source TEXT NOT NULL CHECK (source IN ('api','manual')),
  conditions TEXT NOT NULL DEFAULT '', featured BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL, reviewed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(marketplace_id,external_id)
);
CREATE INDEX offers_public_idx ON offers(status,expires_at,published_at DESC);
CREATE INDEX offers_marketplace_idx ON offers(marketplace_id);
CREATE TABLE favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id,offer_id)
);
CREATE TABLE saved_filters (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, filters JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE collections (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE collection_items (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE, offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(collection_id,offer_id)
);
-- No user/session identifiers: never correlate Amazon clicks and commissions to individuals.
CREATE TABLE click_events (
  id UUID PRIMARY KEY, offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  marketplace_id TEXT NOT NULL REFERENCES marketplaces(id), placement TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clicks_time_idx ON click_events(created_at);
CREATE TABLE search_rules (
  id UUID PRIMARY KEY, marketplace_id TEXT NOT NULL REFERENCES marketplaces(id), name TEXT NOT NULL,
  keywords TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Outros', max_price_cents INTEGER,
  min_discount INTEGER NOT NULL DEFAULT 0 CHECK (min_discount BETWEEN 0 AND 99),
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 60), enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sync_runs (
  id UUID PRIMARY KEY, marketplace_id TEXT NOT NULL REFERENCES marketplaces(id), rule_id UUID REFERENCES search_rules(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running', imported INTEGER NOT NULL DEFAULT 0,
  error TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
  entity_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
