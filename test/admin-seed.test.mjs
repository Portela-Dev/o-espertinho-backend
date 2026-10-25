import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyAdminSeed,readAdminSeed,validateAdminSeed} from '../dist/admin-seed.js';
import {getCatalogSettings} from '../dist/catalog-settings.js';
import {testDatabase,seedProduct} from './helpers.mjs';

async function fixture(t){
 const {db}=await testDatabase();t.after(()=>db.end());
 await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)');
 await db.query("INSERT INTO schema_migrations VALUES('041_offer_sharing.sql','test-only')");
 return db;
}
async function snapshot(db,seed){
 const result={};
 for(const [table,rows]of Object.entries(seed.config)){
  const columns=Object.keys(rows[0]??{});if(!columns.length)continue;
  result[table]=(await db.query('SELECT '+columns.map(c=>'"'+c+'"').join(',')+' FROM '+table+' ORDER BY "'+columns[0]+'"')).rows;
 }
 return result;
}

test('snapshot inclui somente configurações e referências locais de sessão, sem catálogo ou segredos',async()=>{
 const seed=await readAdminSeed();validateAdminSeed(seed);
 assert.deepEqual(Object.keys(seed.config).sort(),['access_profiles','discovery_profiles','discovery_sources','extension_catalog_settings','marketplaces','offer_sharing_settings','review_ai_settings','scraping_profiles']);
 for(const key of ['marketplaces','scraping_profiles','discovery_profiles','discovery_sources','extension_catalog_settings'])assert.equal(seed.config[key].length,3);
 assert.equal(seed.config.access_profiles.length,3);
 for(const row of seed.config.discovery_sources)assert.equal('source_category_path' in row,false);
 const shopee=seed.config.extension_catalog_settings.find(r=>r.marketplace_id==='shopee');
 assert.equal(shopee.config.recipe.steps[0].source,'cookie');
 assert.equal(shopee.config.recipe.steps[1].headers['csrf-token'],'{{csrf}}');
 assert.equal(seed.config.scraping_profiles.find(r=>r.marketplace_id==='amazon').rules.some(r=>r.field==='externalId'),false);
 const dockerfile=await readFile(new URL('../Dockerfile',import.meta.url),'utf8');
 assert.match(dockerfile,/COPY --chown=node:node seeds \.\/seeds/);
});

test('seed inicializa as configurações atuais após migrations sem copiar usuários, categorias, catálogo ou links',async t=>{
 const db=await fixture(t),seed=await readAdminSeed();
 const users=(await db.query('SELECT * FROM users')).rows,categories=(await db.query('SELECT * FROM category_nodes')).rows;
 assert.equal((await applyAdminSeed(db,seed)).status,'applied');
 assert.deepEqual(await snapshot(db,seed),seed.config);
 assert.deepEqual((await db.query('SELECT * FROM users')).rows,users);
 assert.deepEqual((await db.query('SELECT * FROM category_nodes')).rows,categories);
 for(const table of ['products','offers','discovery_links','category_mappings','extension_catalog_runs','review_ai_product_drafts','sessions','extension_sessions'])assert.equal((await db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0,table);
 assert.deepEqual((await db.query('SELECT DISTINCT source_category_path FROM discovery_sources')).rows,[{source_category_path:[]}]);
 for(const row of seed.config.marketplaces){
  assert.equal((await getCatalogSettings(db,row.id)).config.recipe.id,row.id);
  const market=(await db.query('SELECT credentials_encrypted,configuration FROM marketplaces WHERE id=$1',[row.id])).rows[0];
  assert.equal(market.credentials_encrypted,null);assert.deepEqual(market.configuration,{});
 }
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='admin.seed.applied'")).rows[0].n,1);
});

test('novos snapshots podem configurar o Pixel sem reescrever o seed já publicado',async t=>{
 const db=await fixture(t),seed=await readAdminSeed();
 seed.id='admin-config-meta-pixel-test';
 seed.baseline.meta_pixel_settings=[{id:true,enabled:true,pixel_id:'1918844482826551'}];
 seed.config.meta_pixel_settings=[{id:true,enabled:false,pixel_id:'123456789012345'}];
 assert.equal((await applyAdminSeed(db,seed)).status,'applied');
 const row=(await db.query('SELECT enabled,pixel_id,version FROM meta_pixel_settings')).rows[0];
 assert.deepEqual(row,{enabled:false,pixel_id:'123456789012345',version:2});
});

test('reexecução é idempotente e preserva edições futuras e dados novos',async t=>{
 const db=await fixture(t),seed=await readAdminSeed();await applyAdminSeed(db,seed);
 await db.query("UPDATE marketplaces SET name='Nome alterado na VPS' WHERE id='amazon'");await seedProduct(db);
 const before=await snapshot(db,seed);
 assert.equal((await applyAdminSeed(db,seed)).status,'already_applied');
 assert.deepEqual(await snapshot(db,seed),before);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='admin.seed.applied'")).rows[0].n,1);
 const changed=structuredClone(seed);changed.config.marketplaces[0].name='Snapshot editado';
 await assert.rejects(()=>applyAdminSeed(db,changed),/outro conteúdo/);
});

test('dry-run exercita SQL e desfaz integralmente a preparação',async t=>{
 const db=await fixture(t),seed=await readAdminSeed(),before=await snapshot(db,seed);
 const result=await applyAdminSeed(db,seed,{dryRun:true});
 assert.equal(result.status,'preview');assert.equal(result.counts.discovery_sources,3);
 assert.deepEqual(await snapshot(db,seed),before);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,0);
});

test('configuração divergente e catálogo existente impedem inicialização sem sobrescrita',async t=>{
 const db=await fixture(t),seed=await readAdminSeed();
 await db.query("UPDATE review_ai_settings SET product_prompt='Prompt próprio da VPS'");
 const before=await snapshot(db,seed);
 await assert.rejects(()=>applyAdminSeed(db,seed),/Configuração divergente/);
 assert.deepEqual(await snapshot(db,seed),before);
 await seedProduct(db);
 await assert.rejects(()=>applyAdminSeed(db,seed),/banco sem catálogo/);
 assert.deepEqual(await snapshot(db,seed),before);
});

test('falha SQL após inserções reverte todas as mudanças e o marcador de aplicação',async t=>{
 const db=await fixture(t),seed=await readAdminSeed(),before=await snapshot(db,seed);
 const failing={...db,connect:async()=>{const c=await db.connect();return {...c,query:async(sql,args)=>{
  if(sql.startsWith('INSERT INTO "discovery_sources"'))throw new Error('Falha SQL simulada');
  return c.query(sql,args);
 }};}};
 await assert.rejects(()=>applyAdminSeed(failing,seed),/Falha SQL simulada/);
 assert.deepEqual(await snapshot(db,seed),before);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,0);
 assert.equal((await applyAdminSeed(db,seed)).status,'applied');
});

test('validação rejeita credenciais fixas, entidades proibidas e referências inconsistentes antes de escrever',async()=>{
 const seed=await readAdminSeed();
 for(const mutate of [
  s=>{s.config.users=[];},
  s=>{s.config.marketplaces[0].credentials_encrypted='never-export';},
  s=>{s.config.extension_catalog_settings.find(r=>r.marketplace_id==='mercadolivre').config.recipe.steps[1].headers['X-CSRF-Token']='fixed-secret';},
  s=>{s.config.extension_catalog_settings[0].config.recipe.steps[0].headers.Authorization='Bearer secret';},
  s=>{s.config.discovery_sources[0].source_category_path=['Categoria proibida'];},
  s=>{s.config.discovery_sources[0].profile_id='00000000-0000-4000-8000-000000000000';}
 ]){const copy=structuredClone(seed);mutate(copy);assert.throws(()=>validateAdminSeed(copy));}
});

test('seed exige migrations aplicadas',async t=>{
 const db=await fixture(t),seed=await readAdminSeed();await db.query('DELETE FROM schema_migrations');
 await assert.rejects(()=>applyAdminSeed(db,seed),/migrations/);
});
