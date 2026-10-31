import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../dist/db.js';
import {provisionDatabase} from '../dist/provision-database.js';
import {assertRestrictedDatabase} from '../dist/database-security.js';
import {previewPurge,executePurge} from '../dist/catalog-purge.js';
import {seedOffer,seedProduct,client,createApp,testConfig,identity} from './helpers.mjs';
import {applyAdminSeed,readAdminSeed} from '../dist/admin-seed.js';
const url=process.env.TEST_DATABASE_ADMIN_URL;
test('PostgreSQL real: provisionamento preserva dados e restringe runtime, DDL e migrations',{skip:!url},async()=>{
 const suffix=randomUUID().replaceAll('-','').slice(0,12),database='security_'+suffix,role='app_'+suffix;
 const admin=createDatabase(url);let owner,app;
 try{
  await admin.query(`CREATE DATABASE "${database}"`);
  const ownerUrl=new URL(url);ownerUrl.pathname='/'+database;owner=createDatabase(ownerUrl.href);
  const appUrl=new URL(ownerUrl);appUrl.username=role;appUrl.password='test-only-random-application-password';
  await assert.rejects(()=>provisionDatabase(owner,ownerUrl.href));
  await provisionDatabase(owner,appUrl.href);app=createDatabase(appUrl.href);await assertRestrictedDatabase(app);
  assert.equal((await app.query("SELECT catalog_category_key(ARRAY['Eletrônicos','Fones']) AS key")).rows[0].key,'eletronico>fone');
  const seed=await readAdminSeed();
  const previewCli=spawnSync(process.execPath,['dist/admin-seed-cli.js','--dry-run'],{env:{...process.env,MIGRATION_DATABASE_URL:ownerUrl.href},encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(previewCli.status,0,previewCli.stderr);assert.equal(JSON.parse(previewCli.stdout).status,'preview');
  const seeds=await Promise.all([applyAdminSeed(owner,seed),applyAdminSeed(owner,seed)]);
  assert.deepEqual(seeds.map(r=>r.status).sort(),['already_applied','applied']);
  const repeatCli=spawnSync(process.execPath,['dist/admin-seed-cli.js'],{env:{...process.env,MIGRATION_DATABASE_URL:ownerUrl.href},encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(repeatCli.status,0,repeatCli.stderr);assert.equal(JSON.parse(repeatCli.stdout).status,'already_applied');
  assert.equal((await app.query("SELECT count(*)::int AS n FROM extension_catalog_settings")).rows[0].n,3);
  assert.equal((await app.query("SELECT count(*)::int AS n FROM discovery_sources WHERE source_category_path<>'{}'")).rows[0].n,0);
  await assert.rejects(()=>assertRestrictedDatabase(owner));
  const id=randomUUID();await app.query("INSERT INTO products(id,name,category,category_path) VALUES($1,'Dado preservado','Tecnologia',ARRAY['Tecnologia'])",[id]);
  await app.query("UPDATE products SET name='Atualizado' WHERE id=$1",[id]);
  for(const table of ['amazon_sitestripe_session','affiliate_proof_recipes','offer_refresh_items','enrichment_items'])await assert.rejects(()=>app.query('SELECT * FROM '+table),error=>error.code==='42501');
  // Global category operations must also work without migration privileges.
  const categoryProduct=await seedProduct(app,{category:'Categorias runtime'});
  const categoryId=(await app.query('SELECT category_ids FROM products WHERE id=$1',[categoryProduct])).rows[0].category_ids[0];
  const categoryClient=client(createApp(app,testConfig(),{verifyGoogle:async token=>identity(token)}));await categoryClient.login('admin');
  const categoryInput={action:'rename',sourceId:categoryId,name:'Categorias runtime atualizadas'};
  const categoryPreview=await categoryClient.mutate('post','/api/admin/categories/preview',categoryInput);assert.equal(categoryPreview.status,200,JSON.stringify(categoryPreview.body));
  const categoryApplied=await categoryClient.mutate('post','/api/admin/categories/apply',{...categoryInput,revision:categoryPreview.body.revision,confirm:true});assert.equal(categoryApplied.status,200,JSON.stringify(categoryApplied.body));
  assert.deepEqual((await app.query('SELECT category_path FROM products WHERE id=$1',[categoryProduct])).rows[0].category_path,['Categorias runtime atualizadas']);
  const concurrentInput={action:'rename',sourceId:categoryId,name:'Categorias runtime concorrência'};
  const concurrentPreview=await categoryClient.mutate('post','/api/admin/categories/preview',concurrentInput);
  const concurrentResults=await Promise.all([1,2].map(()=>categoryClient.mutate('post','/api/admin/categories/apply',{...concurrentInput,revision:concurrentPreview.body.revision,confirm:true})));
  assert.deepEqual(concurrentResults.map(r=>r.status).sort(),[200,409]);
  assert.deepEqual((await app.query('SELECT category_path FROM products WHERE id=$1',[categoryProduct])).rows[0].category_path,['Categorias runtime concorrência']);

  // Purge reaches only dependencies of deleted rows through fixed definer triggers;
  // runtime still cannot read or mutate the retired workers' tables directly.
  const purgeProduct=await seedProduct(app,{name:'Produto do expurgo'}),offer=await seedOffer(app,{productId:purgeProduct}),legacyRun=randomUUID(),legacyItem=randomUUID();
  const actor=(await owner.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0].id;
  await owner.query("INSERT INTO offer_refresh_runs(id,trigger,status) VALUES($1,'manual','completed')",[legacyRun]);
  await owner.query("INSERT INTO offer_refresh_items(id,run_id,offer_id,marketplace_id,expected_updated_at,status) VALUES($1,$2,$3,'amazon',clock_timestamp(),'done')",[legacyItem,legacyRun,offer]);
  await app.query("UPDATE offers SET availability_status='unavailable' WHERE id=$1",[offer]);
  await owner.query("UPDATE offers SET unavailable_since=clock_timestamp()-interval '31 days' WHERE id=$1",[offer]);
  const key=Buffer.alloc(32,1).toString('base64'),preview=await previewPurge(app,key,actor,{products:false});assert.equal(preview.counts.offers,1);
  const purged=await executePurge(app,key,actor,{previewToken:preview.previewToken,confirmed:true});assert.equal(purged.counts.offers,1);
  assert.equal((await owner.query('SELECT id FROM offer_refresh_items WHERE id=$1',[legacyItem])).rows.length,0);
  assert.equal((await owner.query('SELECT id FROM offer_refresh_runs WHERE id=$1',[legacyRun])).rows.length,0);
  await assert.rejects(()=>app.query('SELECT * FROM offer_refresh_items'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('SELECT credentials_encrypted FROM marketplaces'),error=>error.code==='42501');
  await app.query("SELECT id,name,allowed_hosts,catalog_executor FROM marketplaces");
  await assert.rejects(()=>app.query('SELECT * FROM schema_migrations'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('CREATE TABLE public.not_allowed(id int)'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('DROP TABLE products CASCADE'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('CREATE ROLE not_allowed'),error=>error.code==='42501');
  const cli=spawnSync(process.execPath,['dist/migrate-cli.js'],{env:{...process.env,MIGRATION_DATABASE_URL:ownerUrl.href,DATABASE_URL:appUrl.href,APP_ORIGIN:'http://localhost:4200'},encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/grants/);
  await provisionDatabase(owner,appUrl.href);assert.equal((await app.query('SELECT name FROM products WHERE id=$1',[id])).rows[0].name,'Atualizado');
  await owner.query(`GRANT pg_monitor TO "${role}"`);await assert.rejects(()=>assertRestrictedDatabase(app));await assert.rejects(()=>provisionDatabase(owner,appUrl.href));
 }finally{
  await app?.end();await owner?.end();
  // Pool.end resolves before PostgreSQL necessarily finishes closing each socket.
  // A normal DROP waits for disconnection instead of killing these test clients.
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();
 }
});
