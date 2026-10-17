ALTER TABLE offers ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'available'
 CHECK(availability_status IN ('available','unavailable'));
ALTER TABLE offers ADD COLUMN refresh_status TEXT NOT NULL DEFAULT 'updated'
 CHECK(refresh_status IN ('updated','pending'));
ALTER TABLE offers ADD COLUMN data_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE offers ADD COLUMN last_refresh_attempt_at TIMESTAMPTZ;
ALTER TABLE offers ADD COLUMN last_refresh_error TEXT;
UPDATE offers SET data_updated_at=verified_at;

CREATE TABLE offer_refresh_settings (
 id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
 enabled BOOLEAN NOT NULL DEFAULT true,
 interval_hours INTEGER NOT NULL DEFAULT 8 CHECK(interval_hours BETWEEN 1 AND 168),
 request_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK(request_interval_seconds BETWEEN 30 AND 3600),
 next_run_at TIMESTAMPTZ DEFAULT (now()+interval '8 hours'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO offer_refresh_settings(id) VALUES(true);
CREATE TABLE offer_refresh_runs (
 id UUID PRIMARY KEY, trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
 created_by UUID REFERENCES users(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
 total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
 updated INTEGER NOT NULL DEFAULT 0, unavailable INTEGER NOT NULL DEFAULT 0,
 pending INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,
 next_item_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offer_refresh_one_active ON offer_refresh_runs((true)) WHERE status IN ('queued','running');
CREATE TABLE offer_refresh_items (
 id UUID PRIMARY KEY,run_id UUID NOT NULL REFERENCES offer_refresh_runs(id) ON DELETE CASCADE,
 offer_id UUID REFERENCES offers(id) ON DELETE SET NULL,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 expected_updated_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done')),
 outcome TEXT CHECK(outcome IN ('updated','unavailable','pending','skipped')),
 attempt_id UUID,lease_until TIMESTAMPTZ,error TEXT,finished_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX offer_refresh_queue_idx ON offer_refresh_items(run_id,status,created_at,id);
