ALTER TABLE offer_refresh_settings DROP CONSTRAINT offer_refresh_settings_request_interval_seconds_check;
ALTER TABLE offer_refresh_settings RENAME COLUMN request_interval_seconds TO request_interval_ms;
UPDATE offer_refresh_settings SET request_interval_ms=request_interval_ms*1000;
ALTER TABLE offer_refresh_settings ALTER COLUMN request_interval_ms SET DEFAULT 60000;
ALTER TABLE offer_refresh_settings ADD CONSTRAINT offer_refresh_settings_request_interval_ms_check CHECK(request_interval_ms BETWEEN 100 AND 3600000);
-- Previous versions cleared the schedule during a run; restore a future anchor once.
UPDATE offer_refresh_settings SET next_run_at=now()+interval_hours*interval '1 hour' WHERE enabled AND next_run_at IS NULL;
UPDATE offer_refresh_settings SET updated_at=clock_timestamp();
