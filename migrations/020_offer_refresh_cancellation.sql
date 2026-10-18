ALTER TABLE offer_refresh_runs DROP CONSTRAINT offer_refresh_runs_status_check;
ALTER TABLE offer_refresh_runs ADD CONSTRAINT offer_refresh_runs_status_check
 CHECK(status IN ('queued','running','completed','cancelled'));
ALTER TABLE offer_refresh_runs ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE offer_refresh_runs ADD COLUMN cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE offer_refresh_runs ADD CONSTRAINT offer_refresh_runs_cancelled_check
 CHECK((status='cancelled')=(cancelled_at IS NOT NULL));
-- The existing unique index still permits only one queued/running execution.
-- Cancellation invalidates attempts; the worker's advisory lock still protects in-flight queries.
