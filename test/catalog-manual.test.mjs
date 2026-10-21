import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedProduct} from './helpers.mjs';
test('prévia manual aguarda extensão e pode ser confirmada sem serviço extrator',async t=>{
 const f=await catalogFixture(t),productId=await seedProduct(f.db);await f.db.query("UPDATE marketplaces SET catalog_executor='extension',allowed_hosts=ARRAY['shop.example.com'],scraping_enabled=true WHERE id='amazon'");
 const request=await f.browser.mutate('post','/api/admin/link-imports/preview',{marketplaceId:'amazon',productId,url:'https://shop.example.com/p?affiliate=yes'});assert.equal(request.status,202,JSON.stringify(request.body));
 const id=request.body.executionId,item=(await f.call('post',`/catalog/runs/${id}/claim`,{})).body.item;
 const data={title:'Produto',rating:4.5,reviewCount:67,priceCents:15000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'manual-test',productUrl:'https://shop.example.com/p',images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
 assert.equal((await f.call('post',`/catalog/runs/${id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'success',data})).status,200);
 const waiting=await f.browser.get('/api/admin/extension-catalog/manual/'+id);assert.equal(waiting.body.requiresFinalize,true);assert.equal((await f.db.query('SELECT * FROM offer_import_previews')).rows.length,0);
 const preview=await f.browser.mutate('post','/api/admin/extension-catalog/manual/'+id+'/finalize',{});assert.equal(preview.status,200);assert.equal(preview.body.canConfirm,true);assert.equal(preview.body.previewId,id);
 const again=await f.browser.get('/api/admin/extension-catalog/manual/'+id);assert.equal(again.body.previewId,id);
 const confirmed=await f.browser.mutate('post','/api/admin/link-imports/confirm',{previewId:id,authorizedContent:true});assert.equal(confirmed.status,201,JSON.stringify(confirmed.body));const saved=(await f.db.query('SELECT rating,review_count FROM offers WHERE id=$1',[confirmed.body.offerId])).rows[0];assert.equal(saved.rating,4.5);assert.equal(saved.review_count,67);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offer_import_previews')).rows[0].n,1);
});
