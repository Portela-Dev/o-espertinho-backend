import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedOffer} from './helpers.mjs';
import {priceRefreshDueSql} from '../dist/catalog-price-policy.js';
test('atualização diária sobrescreve somente a observação confirmada e falha preserva vitrine',async t=>{
 const f=await catalogFixture(t);await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 const offerId=await seedOffer(f.db,{affiliate:'https://shop.example.com/p?affiliate=yes'});
 await f.db.query('UPDATE offers SET product_url=$1 WHERE id=$2',['https://shop.example.com/original',offerId]);
 const data={title:'Produto',brand:'',rating:4.7,reviewCount:503,priceCents:45000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'',productUrl:'https://shop.example.com/p',images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
 const run=async result=>{await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[offerId]);const r=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));const item=(await f.call('post',`/catalog/runs/${r.body.id}/claim`,{})).body.item;assert.equal(item.payload.url,'https://shop.example.com/original');assert.equal(item.payload.url,item.payload.originalUrl);assert.notEqual(item.payload.url,'https://shop.example.com/p?affiliate=yes');const response=await f.call('post',`/catalog/runs/${r.body.id}/results`,{itemId:item.id,leaseToken:item.lease_token,...result});assert.equal(response.status,200,JSON.stringify(response.body));};
 await f.db.query("UPDATE offers SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[offerId]);
 await run({outcome:'success',data});
 assert.ok(new Date((await f.db.query('SELECT expires_at FROM offers WHERE id=$1',[offerId])).rows[0].expires_at).getTime()>Date.now());await run({outcome:'success',data:{...data,priceCents:40000}});
 const history=(await f.db.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[offerId])).rows;assert.equal(history.length,1);assert.equal(history[0].price_cents,40000);
 await run({outcome:'technical_failure',reason:'incomplete'});
 const offer=(await f.db.query('SELECT * FROM offers WHERE id=$1',[offerId])).rows[0];assert.equal(offer.price_cents,40000);assert.equal(offer.rating,4.7);assert.equal(offer.review_count,503);assert.equal(offer.refresh_status,'pending');assert.equal(offer.status,'published');assert.equal(offer.availability_status,'available');
 assert.equal((await f.db.query('SELECT price_cents FROM offer_price_history WHERE offer_id=$1',[offerId])).rows[0].price_cents,40000);
 await f.db.query("INSERT INTO extension_catalog_settings(marketplace_id,config) VALUES('amazon',$1) ON CONFLICT(marketplace_id) DO UPDATE SET config=extension_catalog_settings.config||EXCLUDED.config",[JSON.stringify({blockRules:[{kind:'unavailable',match:'selector',value:'#stock-unavailable'}]})]);
 await run({outcome:'unavailable',data:{...data,priceCents:null,missing:['price']}});
 const unavailable=(await f.db.query('SELECT * FROM offers WHERE id=$1',[offerId])).rows[0];assert.equal(unavailable.availability_status,'unavailable');assert.equal(unavailable.refresh_status,'updated');assert.equal(unavailable.last_refresh_error,null);assert.equal(unavailable.price_cents,40000);
 assert.equal((await f.db.query('SELECT price_cents FROM offer_price_history WHERE offer_id=$1',[offerId])).rows[0].price_cents,null);
});


test('fila e contador consideram somente ofertas sem atualização ou com pelo menos 24h, antes do limite',async t=>{
 const f=await catalogFixture(t);
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true WHERE id IN ('amazon','mercadolivre')");
 const recent=await seedOffer(f.db),old=await seedOffer(f.db),never=await seedOffer(f.db),boundary=await seedOffer(f.db),other=await seedOffer(f.db,{marketplace:'mercadolivre'});
 await seedOffer(f.db,{status:'pending'});await seedOffer(f.db,{status:'expired'});const noAffiliate=await seedOffer(f.db);await f.db.query('UPDATE offers SET affiliate_url=NULL WHERE id=$1',[noAffiliate]);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '100 days' WHERE id=$1",[never]);
 assert.equal((await f.db.query(`SELECT ${priceRefreshDueSql} AS due FROM (VALUES(NULL::timestamptz)) offers(data_updated_at)`)).rows[0].due,true);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp() WHERE id=$1",[recent]);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[old]);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '24 hours' WHERE id=$1",[boundary]);
 const stats=(await f.call('get','/catalog/stats?marketplaceId=amazon')).body;assert.deepEqual(stats.prices,{pending:3,total:4});
 const start=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',limit:2,requestKey:randomUUID()});assert.equal(start.status,201,JSON.stringify(start.body));
 const queued=(await f.db.query('SELECT target_id FROM extension_catalog_items WHERE run_id=$1',[start.body.id])).rows.map(row=>row.target_id);
 assert.deepEqual(new Set(queued),new Set([never,old]));assert.ok(!queued.includes(recent));assert.ok(!queued.includes(other));
 await f.call('post','/catalog/runs/'+start.body.id+'/action',{action:'cancel'});
 const all=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(all.body.total,stats.prices.pending);
 const selected=(await f.db.query('SELECT target_id FROM extension_catalog_items WHERE run_id=$1',[all.body.id])).rows.map(row=>row.target_id);assert.deepEqual(new Set(selected),new Set([never,old,boundary]));
 await f.call('post','/catalog/runs/'+all.body.id+'/action',{action:'cancel'});
 await f.db.query('UPDATE offers SET data_updated_at=clock_timestamp() WHERE marketplace_id=$1',['amazon']);
 assert.equal((await f.call('get','/catalog/stats?marketplaceId=amazon')).body.prices.pending,0);
 const none=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(none.status,409);assert.match(none.body.error,/Não há itens elegíveis/);
});

test('uma atualização bem-sucedida deixa a oferta fora da próxima análise nas 24h seguintes',async t=>{
 const f=await catalogFixture(t),offer=await seedOffer(f.db);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '25 hours' WHERE id=$1",[offer]);
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true WHERE id='amazon'");
 const run=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(run.status,201);
 const item=(await f.call('post','/catalog/runs/'+run.body.id+'/claim',{})).body.item;
 const data={title:'Produto',brand:'',priceCents:15000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'',productUrl:item.payload.originalUrl,images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
 const result=await f.call('post','/catalog/runs/'+run.body.id+'/results',{itemId:item.id,leaseToken:item.lease_token,outcome:'success',data});assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal((await f.call('get','/catalog/stats?marketplaceId=amazon')).body.prices.pending,0);
 const next=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(next.status,409,JSON.stringify(next.body));
 assert.equal((await f.db.query('SELECT price_cents FROM offers WHERE id=$1',[offer])).rows[0].price_cents,15000);
});
