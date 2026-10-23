ALTER TABLE access_profiles DROP CONSTRAINT access_profiles_permissions_check;
ALTER TABLE access_profiles ADD CONSTRAINT access_profiles_permissions_check
 CHECK (permissions <@ ARRAY['overview','catalog','marketplaces','selectors','updates','activity','users','affiliate_links','discovery']::text[]);
UPDATE access_profiles SET permissions=array_append(permissions,'discovery'),updated_at=clock_timestamp()
 WHERE id='admin' AND NOT ('discovery'=ANY(permissions));

CREATE TABLE discovery_profiles (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
 config JSONB NOT NULL CHECK (jsonb_typeof(config)='object'),
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,marketplace_id)
);
CREATE UNIQUE INDEX discovery_profile_name_idx ON discovery_profiles(marketplace_id,lower(name));
CREATE TABLE discovery_sources (
 id UUID PRIMARY KEY,
 marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
 profile_id UUID NOT NULL,
 name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
 url TEXT NOT NULL CHECK (length(url)<=4000 AND url LIKE 'https://%'),
 source_category_path TEXT[] NOT NULL DEFAULT '{}',
 enabled BOOLEAN NOT NULL DEFAULT false,
 interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 168),
 notes TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(profile_id,marketplace_id) REFERENCES discovery_profiles(id,marketplace_id),
 UNIQUE(marketplace_id,url)
);
CREATE INDEX discovery_sources_profile_idx ON discovery_sources(profile_id);
CREATE INDEX discovery_sources_marketplace_idx ON discovery_sources(marketplace_id,enabled);
COMMENT ON TABLE discovery_sources IS 'Configuration only. Not consumed by existing price or legacy search jobs.';
