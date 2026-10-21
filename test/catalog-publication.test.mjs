import {seedProduct} from './helpers.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import request from 'supertest';import {catalogFixture} from './catalog-helpers.mjs';
const endpoint='/api/admin/discovery/enrichment/review/publish-batch';
async function link(f,changes={}){const product=randomUUID(),id=randomUUID();await f.db.query("INSERT INTO products(id,name,category_path) VALUES($1,'Produto para publicar',ARRAY['Tecnologia'])",[product]);const category=(await f.db.query('SELECT category_ids FROM products WHERE id=$1',[product])).rows[0].category_ids.at(-1);const data={title:'Produto',description:'Descrição',brand:'Marca',images:[],priceCents:12345,missing:[],specifications:[],conditions:'',availability:'available',...changes};await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,extracted_at,confirmed_category_id) VALUES($1,'amazon',$2,$3,'completed',$4,clock_timestamp(),$5)",[id,'https://www.amazon.com.br/p/'+id,'https://www.amazon.com.br/p/'+id+'?tag=test-20',JSON.stringify(data),category]);await f.db.query('UPDATE discovery_links SET product_id=$2 WHERE id=$1',[id,product]);return {id,version:0};}
test('publicação em massa mantém validação individual, snapshot e idempotência sem bloquear links válidos',async t=>{
 const f=await catalogFixture(t),valid=await link(f,{rating:4.8,reviewCount:3102}),stale=await link(f),incomplete=await link(f,{priceCents:null}),unknown={id:randomUUID(),version:0};
 await f.db.query('UPDATE discovery_links SET enrichment_version=enrichment_version+1 WHERE id=$1',[stale.id]);
 const body={authorizedContent:true,items:[valid,stale,incomplete,unknown]},r=await f.browser.mutate('post',endpoint,body);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.published,1);const published=(await f.db.query('SELECT rating,review_count FROM offers WHERE id=$1',[r.body.results[0].offerId])).rows[0];assert.equal(published.rating,4.8);assert.equal(published.review_count,3102);assert.equal(r.body.failed,3);assert.deepEqual(r.body.results.map(row=>row.ok),[true,false,false,false]);assert.deepEqual(r.body.results.slice(1).map(row=>row.status),[409,409,404]);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM offers')).rows[0].n,1);
 const replay=await f.browser.mutate('post',endpoint,{authorizedContent:true,items:[valid]});assert.equal(replay.body.results[0].alreadyPublished,true);assert.equal((await f.db.query('SELECT count(*)::int n FROM offers')).rows[0].n,1);
});
test('publicação em massa exige login, XSRF, confirmação, IDs únicos e limite de lote',async t=>{
 const f=await catalogFixture(t),item=await link(f),body={authorizedContent:true,items:[item]};
 assert.equal((await request(f.app).post(endpoint).send(body)).status,403);
 assert.equal((await f.browser.agent.post(endpoint).set('Origin','http://localhost:3000').send(body)).status,403);
 for(const invalid of [{items:[item]},{...body,items:[]},{...body,items:[item,item]},{...body,items:Array.from({length:101},()=>({id:randomUUID(),version:0}))}])assert.equal((await f.browser.mutate('post',endpoint,invalid)).status,400);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM offers')).rows[0].n,0);
});

test('publicação exige vínculos revisados e confirmação; repetir não duplica oferta',async t=>{
 const f=await catalogFixture(t),id=randomUUID(),productId=await seedProduct(f.db),product=(await f.db.query('SELECT * FROM products WHERE id=$1',[productId])).rows[0];
 await f.db.query("UPDATE marketplaces SET allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 const data={title:'Produto',description:'',priceCents:15000,originalPriceCents:null,missing:[],images:[],specifications:[],conditions:''};
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,extracted_at) VALUES($1,'amazon','https://shop.example.com/p','https://shop.example.com/p?affiliate=1','completed',$2,clock_timestamp())",[id,JSON.stringify(data)]);
 const endpoint='/api/admin/discovery/enrichment/review/'+id+'/publish',body={version:0,authorizedContent:true};
 assert.equal((await f.browser.mutate('post',endpoint,body)).status,409);
 await f.db.query('UPDATE discovery_links SET confirmed_category_id=$2 WHERE id=$1',[id,product.category_ids.at(-1)]);
 await f.db.query('UPDATE discovery_links SET product_id=$2 WHERE id=$1',[id,productId]);
 const result=await f.browser.mutate('post',endpoint,body);assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal((await f.browser.mutate('post',endpoint,body)).body.offerId,result.body.offerId);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offers')).rows[0].n,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offer_price_history')).rows[0].n,1);
});
