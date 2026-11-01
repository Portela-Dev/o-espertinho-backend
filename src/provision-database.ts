import 'dotenv/config';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createDatabase,type Database} from './db.js';
import {migrate} from './migrate.js';
const identifier=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export async function provisionDatabase(db:Database,applicationUrl:string){
 const url=new URL(applicationUrl),role=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
 if(!/^[a-z][a-z0-9_]{2,62}$/.test(role)||password.length<24)throw new Error('Use uma conta de aplicação distinta com nome simples e senha de pelo menos 24 caracteres.');
 const current=(await db.query('SELECT current_user AS name,current_database() AS database')).rows[0];
 if(role==='postgres'||role.startsWith('pg_')||role===current.name||decodeURIComponent(url.pathname.slice(1))!==current.database)throw new Error('A conta de aplicação deve ser diferente da conta de migrations e usar o mesmo banco.');
 const existing=(await db.query('SELECT oid FROM pg_roles WHERE rolname=$1',[role])).rows[0];
 if(existing&&(await db.query("SELECT 1 FROM pg_auth_members WHERE member=$1 UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner=$1 UNION ALL SELECT 1 FROM pg_database WHERE datdba=$1 UNION ALL SELECT 1 FROM pg_roles WHERE oid=$1 AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)",[existing.oid])).rows.length)throw new Error('Use uma conta exclusiva sem privilégios administrativos, associação a outras roles ou propriedade de schemas/bancos.');
 await migrate(db);
 const c=await db.connect();try{await c.query('BEGIN');
  if(!existing)await c.query(`CREATE ROLE ${identifier(role)} LOGIN`);
  await c.query(`ALTER ROLE ${identifier(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${literal(password)}`);
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${identifier(current.database)} FROM PUBLIC`);
  await c.query(`GRANT CONNECT ON DATABASE ${identifier(current.database)} TO ${identifier(role)}`);
  await c.query(`REVOKE ALL ON SCHEMA public FROM ${identifier(role)}`);
  await c.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
  await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${identifier(role)}`);
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows;
  const archive=new Set(['review_ai_inventory_state','amazon_sitestripe_session','amazon_browser_session','marketplace_oauth_states','affiliate_proof_recipes','enrichment_settings','offer_refresh_settings','offer_refresh_runs','offer_refresh_items','enrichment_runs','enrichment_items','discovery_runs','discovery_run_links','discovery_run_events','search_rules','sync_runs']);
  for(const table of tables){
   if(archive.has(table.tablename))continue;
   if(table.tablename==='marketplaces'){
    const columns='id,name,website_url,logo_url,allowed_hosts,scraping_enabled,url_normalization_rules,catalog_executor,updated_at';
    for(const permission of ['SELECT','INSERT','UPDATE'])await c.query(`GRANT ${permission} (${columns}) ON TABLE public.marketplaces TO ${identifier(role)}`);
    await c.query(`GRANT DELETE ON TABLE public.marketplaces TO ${identifier(role)}`);
   }else await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${identifier(table.tablename)} TO ${identifier(role)}`);
  }
  // Source/profile deletion checks historical references, without mutating archived rows.
  await c.query(`GRANT SELECT ON discovery_runs TO ${identifier(role)}`);
  await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier(role)}`);
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.env.MIGRATION_DATABASE_URL||!process.env.DATABASE_URL)throw new Error('Configure MIGRATION_DATABASE_URL e DATABASE_URL separadas.');
 const db=createDatabase(process.env.MIGRATION_DATABASE_URL);
 try{await provisionDatabase(db,process.env.DATABASE_URL);console.log('Migrations e permissões da conta de aplicação configuradas.');}finally{await db.end();}
}
