import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {categoryKey} from '../dist/enrichment-admin.js';
export const data={title:'Produto',brand:'Marca',priceCents:15000,originalPriceCents:null,description:'Descrição',category:'Áudio',conditions:'',externalId:'',productUrl:'https://shop.example.com/p',images:['https://cdn.example.com/photo.png'],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
test('enriquecimento persiste árvore e observação sem confirmar mapeamento ou atribuir produto',async t=>{
 const f=await catalogFixture(t),id=randomUUID(),category=(await f.db.query("SELECT ids FROM register_category_path(ARRAY['Tecnologia','Áudio'])")).rows[0].ids.at(-1),path=['Eletrônicos','Som'];
 await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url) VALUES($1,'amazon','https://shop.example.com/p','https://shop.example.com/p?affiliate=yes')",[id]);
 await f.db.query("INSERT INTO category_mappings(id,marketplace_id,source_path,source_key,category_id) VALUES($1,'amazon',$2,$3,$4)",[randomUUID(),path,categoryKey(path),category]);
 const run=(await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'enrich',requestKey:randomUUID()})).body;
 const item=(await f.call('post',`/catalog/runs/${run.id}/claim`,{})).body.item;
 assert.equal(item.payload.url,'https://shop.example.com/p');assert.equal(item.payload.originalUrl,item.payload.url);
 const result=await f.call('post',`/catalog/runs/${run.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'success',data,sourceCategoryPath:path});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.deepEqual(link.source_category_path,path);assert.equal(link.confirmed_category_id,null);assert.equal(link.product_id,null);assert.equal(link.enrichment_data.productUrl,link.url);
 const review=await f.browser.get('/api/admin/discovery/enrichment/review');assert.equal(review.body.items[0].suggested_category_id,category);assert.equal(review.body.items[0].confirmed_category_id,null);
 assert.equal(link.enrichment_data.availability,'available');
 assert.equal(link.affiliate_url,'https://shop.example.com/p?affiliate=yes');
});

test('indisponibilidade explícita conclui enriquecimento sem falha e persiste estado para revisão',async t=>{
 const f=await catalogFixture(t),id=randomUUID();
 await f.db.query("UPDATE marketplaces SET scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url) VALUES($1,'amazon','https://shop.example.com/p','https://shop.example.com/affiliate')",[id]);
 await f.db.query("INSERT INTO extension_catalog_settings(marketplace_id,config) VALUES('amazon',$1) ON CONFLICT(marketplace_id) DO UPDATE SET config=extension_catalog_settings.config||EXCLUDED.config",[JSON.stringify({blockRules:[{kind:'unavailable',match:'selector',value:'#stock-unavailable'}]})]);
 const run=(await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'enrich',requestKey:randomUUID()})).body;
 const item=(await f.call('post',`/catalog/runs/${run.id}/claim`,{})).body.item;
 const result=await f.call('post',`/catalog/runs/${run.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'unavailable',data:{...data,priceCents:null,missing:['price']}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 assert.equal(link.extraction_status,'completed');assert.equal(link.extraction_error,null);assert.equal(link.enrichment_data.availability,'unavailable');assert.equal(link.enrichment_data.priceCents,null);assert.deepEqual(link.enrichment_data.missing,[]);
 const summary=(await f.call('get',`/catalog/runs/${run.id}`)).body;assert.equal(summary.completed,1);assert.equal(summary.failed,0);
});

test('nova extração libera anúncio inválido para análise futura sem confirmar nem publicar automaticamente',async t=>{
 const f=await catalogFixture(t),id=randomUUID();
 await f.db.query("UPDATE catalog_resolver_settings SET mode='legacy'");
 await f.db.query("UPDATE marketplaces SET scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,ai_resolution) VALUES($1,'amazon','https://shop.example.com/p','https://shop.example.com/affiliate',$2)",[id,JSON.stringify({product:{action:'invalid',reason:'128 GB contra 256 GB.'}})]);
 const settings=(await f.browser.get('/api/admin/discovery/enrichment/ai/settings')).body;
 await f.browser.mutate('put','/api/admin/discovery/enrichment/ai/settings',{...settings,productEnabled:true});
 const run=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'enrich',requestKey:randomUUID()});assert.equal(run.status,201,JSON.stringify(run.body));
 const item=(await f.call('post',`/catalog/runs/${run.body.id}/claim`,{})).body.item;
 const result=await f.call('post',`/catalog/runs/${run.body.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'success',data,sourceCategoryPath:[]});assert.equal(result.status,200,JSON.stringify(result.body));
 const link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.deepEqual(link.ai_resolution,{});assert.equal(link.product_id,null);assert.equal(link.published_offer_id,null);
 const queue=await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=product');assert.equal(queue.status,200,JSON.stringify(queue.body));assert.deepEqual(queue.body.items.map(i=>i.id),[id]);
});
