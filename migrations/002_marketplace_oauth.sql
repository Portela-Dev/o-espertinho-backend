CREATE TABLE marketplace_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credentials_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  verifier_encrypted TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX marketplace_oauth_states_expiry_idx ON marketplace_oauth_states(expires_at);
