ALTER TABLE sessions ADD COLUMN admin_verified_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN reauth_nonce_hash TEXT;
ALTER TABLE sessions ADD COLUMN reauth_nonce_expires_at TIMESTAMPTZ;
