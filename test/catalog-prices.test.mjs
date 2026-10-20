import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedOffer} from './helpers.mjs';
test('atualização diária sobrescreve somente a observação confirmada e falha preserva vitrine',async t=>{
 const f=await catalogFixture(t);await f.db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
 const offerId=await seedOffer(f.db,{affiliate:'https://shop.example.com/p?affiliate=yes'});
 const data={title:'Produto',brand:'',priceCents:45000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'',productUrl:'https://shop.example.com/p',images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
 const run=async result=>{const r=await f.call('post','/catalog/runs',{marketplaceId:'amazon',step:'prices',requestKey:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));const item=(await f.call('post',`/catalog/runs/${r.body.id}/claim`,{})).body.item;const response=await f.call('post',`/catalog/runs/${r.body.id}/results`,{itemId:item.id,leaseToken:item.lease_token,...result});assert.equal(response.status,200,JSON.stringify(response.body));};
 await f.db.query("UPDATE offers SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[offerId]);
 await run({outcome:'success',data});
 assert.ok(new Date((await f.db.query('SELECT expires_at FROM offers WHERE id=$1',[offerId])).rows[0].expires_at).getTime()>Date.now());await run({outcome:'success',data:{...data,priceCents:40000}});
 const history=(await f.db.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[offerId])).rows;assert.equal(history.length,1);assert.equal(history[0].price_cents,40000);
 await run({outcome:'technical_failure',reason:'incomplete'});
 const offer=(await f.db.query('SELECT * FROM offers WHERE id=$1',[offerId])).rows[0];assert.equal(offer.price_cents,40000);assert.equal(offer.refresh_status,'pending');assert.equal(offer.status,'published');assert.equal(offer.availability_status,'available');
 assert.equal((await f.db.query('SELECT price_cents FROM offer_price_history WHERE offer_id=$1',[offerId])).rows[0].price_cents,40000);
});
