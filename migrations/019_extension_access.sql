ALTER TABLE access_profiles DROP CONSTRAINT access_profiles_permissions_check;
ALTER TABLE access_profiles ADD CONSTRAINT access_profiles_permissions_check
 CHECK (permissions <@ ARRAY['overview','catalog','marketplaces','selectors','updates','activity','users','affiliate_links']::text[]);
UPDATE access_profiles SET permissions=array_append(permissions,'affiliate_links'),updated_at=clock_timestamp()
 WHERE id='admin' AND NOT ('affiliate_links'=ANY(permissions));

CREATE TABLE extension_sessions (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 browser_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 extension_id TEXT NOT NULL CHECK (extension_id ~ '^[a-p]{32}$'),
 token_hash TEXT NOT NULL UNIQUE,
 refresh_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 refresh_expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX extension_sessions_expiry_idx ON extension_sessions(refresh_expires_at);
