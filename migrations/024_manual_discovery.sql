ALTER TABLE discovery_sources ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE discovery_sources ADD COLUMN pause_reason TEXT;
CREATE TABLE discovery_runs (
 id UUID PRIMARY KEY,
 source_id UUID NOT NULL REFERENCES discovery_sources(id) ON DELETE RESTRICT,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 snapshot JSONB NOT NULL,
 pages INTEGER NOT NULL DEFAULT 0 CHECK(pages>=0),
 found INTEGER NOT NULL DEFAULT 0 CHECK(found>=0),
 added INTEGER NOT NULL DEFAULT 0 CHECK(added>=0),
 duplicates INTEGER NOT NULL DEFAULT 0 CHECK(duplicates>=0),
 invalid INTEGER NOT NULL DEFAULT 0 CHECK(invalid>=0),
 current_url TEXT,
 stop_reason TEXT,
 error TEXT,
 worker_id UUID,
 lease_until TIMESTAMPTZ,
 heartbeat_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ,
 cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX discovery_one_active_source ON discovery_runs(source_id) WHERE status IN ('queued','running');
CREATE INDEX discovery_queue ON discovery_runs(status,created_at);
CREATE TABLE discovery_links (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 url TEXT NOT NULL CHECK(length(url)<=4000 AND url LIKE 'https://%' AND position('?' in url)=0 AND position('#' in url)=0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','archived')),
 first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(marketplace_id,url)
);
CREATE TABLE discovery_link_sources (
 link_id UUID NOT NULL REFERENCES discovery_links(id) ON DELETE CASCADE,
 source_id UUID NOT NULL REFERENCES discovery_sources(id) ON DELETE RESTRICT,
 first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(link_id,source_id)
);
CREATE TABLE discovery_run_links (
 run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
 link_id UUID NOT NULL REFERENCES discovery_links(id) ON DELETE RESTRICT,
 is_new BOOLEAN NOT NULL,
 PRIMARY KEY(run_id,link_id)
);
CREATE TABLE discovery_run_events (
 id UUID PRIMARY KEY,
 run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 message TEXT NOT NULL CHECK(length(message)<=1000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX discovery_events_run ON discovery_run_events(run_id,created_at);
CREATE INDEX discovery_links_status ON discovery_links(marketplace_id,status,last_seen_at DESC);
COMMENT ON TABLE discovery_runs IS 'Manual requests only; consumed by the independent discovery worker. No schedule.';
