import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase,testConfig,createApp,client,identity,seedOffer} from './helpers.mjs';

test('retired endpoints cannot create jobs, read credentials or contact a marketplace',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const admin=client(createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}));await admin.login('admin');
 for(const [method,path] of [['get','/admin/marketplaces'],['put','/admin/marketplaces/amazon'],['post','/admin/marketplaces/amazon/test'],['get','/admin/mercadolivre/oauth/status'],['post','/admin/offer-refresh/run'],['get','/admin/offer-refresh'],['post','/admin/discovery/sources/'+randomUUID()+'/run'],['post','/admin/discovery/enrichment/runs'],['put','/admin/discovery/enrichment/settings/amazon'],['post','/admin/rules'],['post','/admin/offers']]){
  const response=method==='get'?await admin.get('/api'+path):await admin.mutate(method,'/api'+path,{});assert.equal(response.status,404,path);
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM extension_catalog_runs')).rows[0].n,0);
 const settings=await admin.get('/api/admin/extension-catalog/settings/amazon');assert.equal(settings.body.catalog_executor,'extension');
 assert.equal((await admin.mutate('put','/api/admin/extension-catalog/settings/amazon',{version:settings.body.version,executor:'legacy',config:settings.body.config})).status,400);
});

test('retirement migration preserves commercial data, receipts and encrypted archive while closing leases',async t=>{
 const {db,pg}=await testDatabase({through:'030_migrate_extension_recipes.sql'});t.after(()=>db.end());
 const offer=await seedOffer(db,{price:43210});await db.query("UPDATE marketplaces SET credentials_encrypted='encrypted-archive' WHERE id='amazon'");
 const priceRun=randomUUID();await db.query("INSERT INTO offer_refresh_runs(id,trigger,status,total) VALUES($1,'manual','running',2)",[priceRun]);
 for(const [status,outcome] of [['done','updated'],['running',null]])await db.query("INSERT INTO offer_refresh_items(id,run_id,offer_id,marketplace_id,expected_updated_at,status,outcome) VALUES($1,$2,$3,'amazon',now(),$4,$5)",[randomUUID(),priceRun,offer,status,outcome]);
 const enrichRun=randomUUID();await db.query("INSERT INTO enrichment_runs(id,marketplace_id,status,snapshot,total,worker_id) VALUES($1,'amazon','running','{}',1,$2)",[enrichRun,randomUUID()]);
 const before=(await db.query('SELECT id,product_id,price_cents,status FROM offers')).rows;
 await pg.exec(await readFile(new URL('../migrations/031_retire_browser_services.sql',import.meta.url),'utf8'));
 assert.deepEqual((await db.query('SELECT id,product_id,price_cents,status FROM offers')).rows,before);
 assert.equal((await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='amazon'")).rows[0].credentials_encrypted,'encrypted-archive');
 assert.equal((await db.query('SELECT status FROM offer_refresh_runs WHERE id=$1',[priceRun])).rows[0].status,'cancelled');
 assert.equal((await db.query("SELECT count(*)::int n FROM offer_refresh_items WHERE outcome='updated'")).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM offer_refresh_items WHERE status='running'")).rows[0].n,0);
 assert.equal((await db.query('SELECT worker_id FROM enrichment_runs WHERE id=$1',[enrichRun])).rows[0].worker_id,null);
 assert.equal((await db.query('SELECT enabled FROM offer_refresh_settings')).rows[0].enabled,false);
 await assert.rejects(()=>db.query("UPDATE marketplaces SET catalog_executor='legacy' WHERE id='amazon'"));
 await db.query("INSERT INTO marketplaces(id,name,website_url,allowed_hosts) VALUES('another','Another','https://shop.example.com',ARRAY['shop.example.com'])");
 assert.equal((await db.query("SELECT catalog_executor FROM marketplaces WHERE id='another'")).rows[0].catalog_executor,'extension');
});
