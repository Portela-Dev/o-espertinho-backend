import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
export async function source(f){
 const profileId=randomUUID(),sourceId=randomUUID(),config=defaultDiscoveryConfig();config.extraction.itemSelector='.card';
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',allowed_hosts=ARRAY['shop.example.com'],website_url='https://shop.example.com',scraping_enabled=true WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,'amazon','Fixture',$2)",[profileId,JSON.stringify(config)]);
 await f.db.query("INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,enabled) VALUES($1,'amazon',$2,'Fixture','https://shop.example.com/list',true)",[sourceId,profileId]);
 return sourceId;
}
test('fila durável tem idempotência, exclusão por marketplace, pausa, reserva e cancelamento',async t=>{
 const f=await catalogFixture(t);await source(f);
 const input={marketplaceId:'amazon',step:'discover',requestKey:randomUUID()};
 const started=await f.call('post','/catalog/runs',input);assert.equal(started.status,201,JSON.stringify(started.body));
 const id=started.body.id;
 assert.equal((await f.call('post','/catalog/runs',input)).body.id,id);
 assert.equal((await f.call('post','/catalog/runs',{...input,requestKey:randomUUID()})).status,409);
 const item=(await f.call('post',`/catalog/runs/${id}/claim`,{})).body.item;assert.ok(item.lease_token);
 assert.equal((await f.call('post',`/catalog/runs/${id}/claim`,{})).body.item,null);
 assert.equal((await f.call('post',`/catalog/runs/${id}/heartbeat`,{itemId:item.id,leaseToken:randomUUID()})).status,409);
 assert.equal((await f.call('post',`/catalog/runs/${id}/action`,{action:'human',reason:'challenge'})).body.status,'waiting_for_human');
 assert.equal((await f.call('post',`/catalog/runs/${id}/claim`,{})).status,409);
 await f.call('post',`/catalog/runs/${id}/action`,{action:'resume'});
 await f.call('post',`/catalog/runs/${id}/action`,{action:'cancel'});
 assert.equal((await f.call('get',`/catalog/runs/${id}`)).body.status,'cancelled');
 assert.equal((await f.call('post',`/catalog/runs/${id}/heartbeat`,{itemId:item.id,leaseToken:item.lease_token})).status,409);
});
