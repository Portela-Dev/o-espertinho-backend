CREATE TABLE access_profiles (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
 description TEXT NOT NULL DEFAULT '',
 permissions TEXT[] NOT NULL DEFAULT '{}',
 system BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK (permissions <@ ARRAY['overview','catalog','marketplaces','selectors','updates','activity','users']::text[])
);
CREATE UNIQUE INDEX access_profiles_name_idx ON access_profiles(lower(name));
INSERT INTO access_profiles(id,name,description,permissions,system) VALUES
 ('admin','Administrador','Acesso completo, incluindo gestão de usuários e perfis.',ARRAY['overview','catalog','marketplaces','selectors','updates','activity','users'],true),
 ('user','Usuário','Conta pessoal, sem acesso à administração.','{}',true),
 ('editor','Editor de catálogo','Produtos, links e revisão de ofertas.',ARRAY['catalog'],false);
ALTER TABLE users ADD COLUMN access_profile_id TEXT NOT NULL DEFAULT 'user' REFERENCES access_profiles(id);
UPDATE users SET access_profile_id='admin' WHERE role='admin';
ALTER TABLE users ADD COLUMN blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_profile_role CHECK ((role='admin')=(access_profile_id='admin'));
CREATE INDEX users_profile_idx ON users(access_profile_id);
