import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
test('falha final pode pausar a fonte; retomar a configuração não inicia job',async t=>{
 const f=await catalogFixture(t),config=defaultDiscoveryConfig(),profile=randomUUID(),source=randomUUID();config.extraction.itemSelector='.card';config.failures.timeout.action='pause_source';
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,'amazon','Fixture',$2)",[profile,JSON.stringify(config)]);
 await f.db.query("INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,enabled) VALUES($1,'amazon',$2,'Fixture','https://shop.example.com/list',true)",[source,profile]);
 const run=(await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'discover',requestKey:randomUUID()})).body,item=(await f.call('post',`/catalog/runs/${run.id}/claim`,{})).body.item;
 assert.ok(item.payload.startedAt);const result=await f.call('post',`/catalog/runs/${run.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'technical_failure',reason:'incomplete',failureType:'timeout'});assert.equal(result.status,200,JSON.stringify(result.body));
 assert.ok((await f.db.query('SELECT paused_at FROM discovery_sources WHERE id=$1',[source])).rows[0].paused_at);
 assert.equal((await f.browser.mutate('post',`/api/admin/extension-catalog/sources/${source}/resume`,{})).status,200);
 assert.equal((await f.db.query('SELECT paused_at FROM discovery_sources WHERE id=$1',[source])).rows[0].paused_at,null);assert.equal((await f.db.query('SELECT * FROM discovery_runs')).rows.length,0);
});
