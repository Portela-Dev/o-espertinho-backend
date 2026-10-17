CREATE TABLE amazon_sitestripe_session (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  cookie_encrypted TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  last_error TEXT
);
