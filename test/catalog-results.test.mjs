import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
import {seedOffer} from './helpers.mjs';
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

test('pular preço em pausa aceita reserva antiga, preserva oferta e histórico e avança sem recriar o ciclo',async t=>{
 const f=await setup(t),offers=[];
 for(let i=0;i<2;i++)offers.push(await seedOffer(f.db,{affiliate:'https://shop.example.com/'+randomUUID()}));
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '2 days' WHERE id=ANY($1::uuid[])",[offers]);
 const {run,item}=await start(f,'prices'),path=`/catalog/runs/${run.id}/skip`,body={itemId:item.id,leaseToken:item.lease_token};
 const before=(await f.db.query('SELECT price_cents,availability_status FROM offers WHERE id=$1',[item.target_id])).rows[0];
 assert.equal((await f.call('post',path,body)).status,409);
 await f.call('post',`/catalog/runs/${run.id}/action`,{action:'technical',reason:'permission'});
 assert.equal((await f.call('post',path,{...body,leaseToken:randomUUID()})).status,409);
 assert.equal((await f.call('post',path,{...body,cookies:[]})).status,400);
 await f.db.query("UPDATE extension_catalog_items SET lease_until=clock_timestamp()-interval '1 hour' WHERE id=$1",[item.id]);
 const skipped=await f.call('post',path,body);assert.equal(skipped.status,200,JSON.stringify(skipped.body));assert.equal(skipped.body.id,run.id);assert.equal(skipped.body.status,'running');assert.equal(skipped.body.skipped,1);
 const saved=(await f.db.query('SELECT price_cents,availability_status,refresh_status,last_refresh_error FROM offers WHERE id=$1',[item.target_id])).rows[0];
 assert.equal(saved.price_cents,before.price_cents);assert.equal(saved.availability_status,before.availability_status);assert.equal(saved.refresh_status,'pending');assert.equal(saved.last_refresh_error,'Atualização pendente');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM offer_price_history WHERE offer_id=$1',[item.target_id])).rows[0].n,0);
 assert.equal((await f.call('post',path,body)).body.skipped,1);
 assert.equal((await f.call('post',`/catalog/runs/${run.id}/results`,{...body,outcome:'technical_failure',reason:'incomplete'})).status,409);
 const next=await f.call('post',`/catalog/runs/${run.id}/claim`,{});assert.notEqual(next.body.item.id,item.id);
 await f.call('post',`/catalog/runs/${run.id}/action`,{action:'pause'});
 const last=await f.call('post',path,{itemId:next.body.item.id,leaseToken:next.body.item.lease_token});assert.equal(last.body.status,'completed');assert.equal(last.body.skipped,2);
 const again=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(again.status,201);assert.equal(again.body.total,2);
 const cancelledItem=(await f.call('post',`/catalog/runs/${again.body.id}/claim`,{})).body.item;
 await f.call('post',`/catalog/runs/${again.body.id}/action`,{action:'cancel'});
 assert.equal((await f.call('post',`/catalog/runs/${again.body.id}/skip`,{itemId:cancelledItem.id,leaseToken:cancelledItem.lease_token})).status,409);
});

test('pular recusa outra execução, cancelamento e descoberta',async t=>{
 const f=await setup(t),{run,item}=await start(f),body={itemId:item.id,leaseToken:item.lease_token};
 assert.equal((await f.call('post',`/catalog/runs/${run.id}/skip`,body)).status,409);
 assert.equal((await f.call('post',`/catalog/runs/${randomUUID()}/skip`,body)).status,404);
 await f.call('post',`/catalog/runs/${run.id}/action`,{action:'cancel'});
 assert.equal((await f.call('post',`/catalog/runs/${run.id}/skip`,body)).status,409);
});
