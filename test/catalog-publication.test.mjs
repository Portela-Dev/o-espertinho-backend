import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedProduct} from './helpers.mjs';
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
