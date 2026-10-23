CREATE TABLE enrichment_settings (
 marketplace_id TEXT PRIMARY KEY REFERENCES marketplaces(id),
 request_interval_ms INTEGER NOT NULL DEFAULT 2000 CHECK(request_interval_ms BETWEEN 100 AND 600000),
 category_separator TEXT NOT NULL DEFAULT '>' CHECK(length(category_separator)<=10)
);
CREATE TABLE category_mappings (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 source_path TEXT[] NOT NULL CHECK(cardinality(source_path) BETWEEN 1 AND 30),
 source_key TEXT NOT NULL,
 category_id UUID NOT NULL REFERENCES category_nodes(id) ON DELETE RESTRICT,
 updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(marketplace_id,source_key)
);
ALTER TABLE discovery_links
 ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK(extraction_status IN ('pending','completed','failed')),
 ADD COLUMN enrichment_data JSONB,
 ADD COLUMN source_category_path TEXT[] NOT NULL DEFAULT '{}',
 ADD COLUMN source_category_key TEXT NOT NULL DEFAULT '',
 ADD COLUMN extraction_error TEXT,
 ADD COLUMN extracted_at TIMESTAMPTZ,
 ADD COLUMN enrichment_version INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN confirmed_category_id UUID REFERENCES category_nodes(id) ON DELETE RESTRICT,
 ADD COLUMN category_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
 ADD COLUMN category_confirmed_at TIMESTAMPTZ;
CREATE TABLE enrichment_runs (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 snapshot JSONB NOT NULL,
 total INTEGER NOT NULL CHECK(total>0),
 error TEXT,
 current_link_id UUID REFERENCES discovery_links(id) ON DELETE SET NULL,
 worker_id UUID,
 lease_until TIMESTAMPTZ,
 heartbeat_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX enrichment_one_active_market ON enrichment_runs(marketplace_id) WHERE status IN ('queued','running') OR worker_id IS NOT NULL;
CREATE TABLE enrichment_items (
 run_id UUID NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
 link_id UUID NOT NULL REFERENCES discovery_links(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','skipped','cancelled')),
 error TEXT CHECK(length(error)<=1000),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ,
 PRIMARY KEY(run_id,link_id)
);
CREATE INDEX enrichment_queue ON enrichment_runs(status,created_at);
CREATE INDEX enrichment_review ON discovery_links(marketplace_id,extraction_status,last_seen_at);
COMMENT ON TABLE enrichment_runs IS 'Manual enrichment only. Category mappings are suggestions; only the review API confirms a category.';
