import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
async function setup(t){const f=await catalogFixture(t),profile=randomUUID(),source=randomUUID(),config=defaultDiscoveryConfig();config.extraction.itemSelector='.card';
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,'amazon','Fixture',$2)",[profile,JSON.stringify(config)]);
 await f.db.query("INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,enabled) VALUES($1,'amazon',$2,'Fixture','https://shop.example.com/list',true)",[source,profile]);return f;}
async function start(f,step='discover'){const run=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step,requestKey:randomUUID()});assert.equal(run.status,201,JSON.stringify(run.body));const claim=await f.call('post',`/catalog/runs/${run.body.id}/claim`,{});return {run:run.body,item:claim.body.item};}
test('descoberta normaliza URLs, preserva arquivados e aceita reenvio idempotente',async t=>{
 const f=await setup(t),{run,item}=await start(f);const body={itemId:item.id,leaseToken:item.lease_token,outcome:'success',links:['https://shop.example.com/p?tracking=1#x','https://shop.example.com/p?tracking=2'],done:true};
 const url=`/catalog/runs/${run.id}/results`;assert.equal((await f.call('post',url,body)).status,200);
 assert.equal((await f.call('post',url,body)).body.duplicate,true);
 assert.deepEqual((await f.db.query('SELECT url FROM discovery_links')).rows,[{url:'https://shop.example.com/p'}]);
 await f.db.query("UPDATE discovery_links SET status='archived'");const next=await start(f);await f.call('post',`/catalog/runs/${next.run.id}/results`,{...body,itemId:next.item.id,leaseToken:next.item.lease_token});
 assert.equal((await f.db.query('SELECT status FROM discovery_links')).rows[0].status,'archived');
});
test('cancelamento ou reserva expirada impede gravação e payload de sessão é recusado',async t=>{
 const f=await setup(t),{run,item}=await start(f);const path=`/catalog/runs/${run.id}/results`,result={itemId:item.id,leaseToken:item.lease_token,outcome:'success',links:['https://shop.example.com/p'],done:true};
 assert.equal((await f.call('post',path,{...result,cookies:[]})).status,400);
 await f.call('post',`/catalog/runs/${run.id}/action`,{action:'cancel'});assert.equal((await f.call('post',path,result)).status,409);
 assert.equal((await f.db.query('SELECT * FROM discovery_links')).rows.length,0);
});
