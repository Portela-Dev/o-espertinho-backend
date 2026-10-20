import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../dist/db.js';
import {provisionDatabase} from '../dist/provision-database.js';
import {assertRestrictedDatabase} from '../dist/database-security.js';
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
  await assert.rejects(()=>assertRestrictedDatabase(owner));
  const id=randomUUID();await app.query("INSERT INTO products(id,name,category,category_path) VALUES($1,'Dado preservado','Tecnologia',ARRAY['Tecnologia'])",[id]);
  await app.query("UPDATE products SET name='Atualizado' WHERE id=$1",[id]);
  for(const table of ['amazon_sitestripe_session','affiliate_proof_recipes','offer_refresh_items','enrichment_items'])await assert.rejects(()=>app.query('SELECT * FROM '+table),error=>error.code==='42501');
  await assert.rejects(()=>app.query('SELECT credentials_encrypted FROM marketplaces'),error=>error.code==='42501');
  await app.query("SELECT id,name,allowed_hosts,catalog_executor FROM marketplaces");
  await assert.rejects(()=>app.query('SELECT * FROM schema_migrations'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('CREATE TABLE public.not_allowed(id int)'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('DROP TABLE products CASCADE'),error=>error.code==='42501');
  await assert.rejects(()=>app.query('CREATE ROLE not_allowed'),error=>error.code==='42501');
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
