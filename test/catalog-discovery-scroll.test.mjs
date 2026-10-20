import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';

async function setup(t,maxItems=4){
 const f=await catalogFixture(t),config=defaultDiscoveryConfig(),profile=randomUUID(),source=randomUUID();
 config.extraction.itemSelector='.card';config.pagination.mode='scroll';config.pagination.scrollStrategy='bottom';config.pagination.noProgressLimit=2;config.limits.maxItems=maxItems;config.limits.maxPages=20;
 await f.db.query("UPDATE marketplaces SET scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'],url_normalization_rules=$1 WHERE id='amazon'",[JSON.stringify([{type:'remove_path_suffix',marker:'/ref='}])]);
 await f.db.query("INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,'amazon','Scroll fixture',$2)",[profile,JSON.stringify(config)]);
 await f.db.query("INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,enabled) VALUES($1,'amazon',$2,'Scroll fixture','https://shop.example.com/list',true)",[source,profile]);
 const run=(await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'discover',requestKey:randomUUID()})).body;
 let last;
 const send=async(links,scroll)=>{
  const claim=await f.call('post',`/catalog/runs/${run.id}/claim`,{});assert.equal(claim.status,200);const item=claim.body.item;
  const body={itemId:item.id,leaseToken:item.lease_token,outcome:'success',links,done:false,checkpoint:{url:'https://shop.example.com/list',page:(item.payload.checkpoint?.page??0)+1,seen:[],found:0,noProgress:0,scroll}};
  const response=await f.call('post',`/catalog/runs/${run.id}/results`,body);assert.equal(response.status,200,JSON.stringify(response.body));
  last={body,itemId:item.id};return (await f.db.query('SELECT payload,result,status FROM extension_catalog_items WHERE id=$1',[item.id])).rows[0];
 };
 return {...f,run,send,last:()=>last};
}
const urls=['https://shop.example.com/a?tag=one','https://shop.example.com/a/ref=two?tag=two','https://shop.example.com/b'];
test('unique counts survive overlapping pages and resume; limits only count normalized new URLs',async t=>{
 const f=await setup(t);
 let row=await f.send(urls,{position:0,height:3000,viewport:800});assert.equal(row.result.checkpoint.found,2);
 row=await f.send(urls,{position:800,height:3000,viewport:800});assert.equal(row.result.checkpoint.found,2);assert.equal(row.result.checkpoint.noProgress,0);
 row=await f.send(urls,{position:2200,height:3000,viewport:800});assert.equal(row.result.checkpoint.noProgress,1);
 row=await f.send(urls,{position:2200,height:4000,viewport:800});assert.equal(row.result.checkpoint.noProgress,0);
 row=await f.send([...urls,'https://shop.example.com/c'],{position:3200,height:4000,viewport:800});assert.equal(row.result.checkpoint.found,3);
 row=await f.send(urls,{position:3200,height:4000,viewport:800});assert.equal(row.result.checkpoint.noProgress,1);
 await f.call('post',`/catalog/runs/${f.run.id}/action`,{action:'pause'});await f.call('post',`/catalog/runs/${f.run.id}/action`,{action:'resume'});
 row=await f.send([...urls,'https://shop.example.com/d','https://shop.example.com/e'],{position:3200,height:4000,viewport:800});
 assert.equal(row.status,'completed');assert.equal(row.result.checkpoint.found,4);assert.equal(row.payload.checkpoint.found,4);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM discovery_links')).rows[0].n,4);
 const replay=await f.call('post',`/catalog/runs/${f.run.id}/results`,f.last().body);assert.equal(replay.body.duplicate,true);
 await f.db.query('DELETE FROM extension_catalog_runs WHERE id=$1',[f.run.id]);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM extension_catalog_discovery_seen')).rows[0].n,0);
});
test('scroll finishes only after consecutive stable readings at the bottom',async t=>{
 const f=await setup(t,100),scroll={position:200,height:1000,viewport:800};
 await f.send(urls,scroll);let row=await f.send(urls,scroll);assert.equal(row.result.done,false);assert.equal(row.result.checkpoint.found,2);
 row=await f.send(urls,scroll);assert.equal(row.result.done,true);assert.equal(row.result.checkpoint.noProgress,2);assert.equal(row.result.checkpoint.found,2);
});
