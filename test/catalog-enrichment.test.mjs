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
 const result=await f.call('post',`/catalog/runs/${run.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'success',data,sourceCategoryPath:path});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.deepEqual(link.source_category_path,path);assert.equal(link.confirmed_category_id,null);assert.equal(link.product_id,null);assert.equal(link.enrichment_data.productUrl,link.url);
 const review=await f.browser.get('/api/admin/discovery/enrichment/review');assert.equal(review.body.items[0].suggested_category_id,category);assert.equal(review.body.items[0].confirmed_category_id,null);
});
