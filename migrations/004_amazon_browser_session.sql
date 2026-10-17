CREATE TABLE amazon_browser_session (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  storage_encrypted TEXT,
  status TEXT NOT NULL CHECK (status IN ('connecting','ready','reconnect_required','error')),
  last_checked_at TIMESTAMPTZ,
  last_error TEXT
);
