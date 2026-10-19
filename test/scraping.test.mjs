import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,client,createApp,identity,seedProduct} from './helpers.mjs';
let db,admin,app,productId;const config=testConfig();let missing=false,calls=0;
const source='https://www.example.com/produto/123',affiliate=source+'?ref=oespertinho';
const extracted=()=>({title:'Produto de teste',priceCents:32100,originalPriceCents:44750,description:'Descrição extraída.',category:'',conditions:'Preço com cupom.',externalId:'SKU123',productUrl:source+'?dynamic=123#details',images:['https://images.example.com/item.jpg'],specifications:[{name:'Cor',value:'Preto'}],warnings:[],missing:missing?['price']:[],evidence:[{field:'title',selector:'h1'}],collectedAt:new Date().toISOString()});
const rules=[{field:'title',selectors:['h1'],mode:'text',required:true},{field:'price',selectors:['.price'],mode:'text',required:true}];
before(async()=>{({db}=await testDatabase());productId=await seedProduct(db);app=createApp(db,config,{verifyGoogle:async t=>identity(t),extractor:{extract:async()=>{calls++;return extracted();}}});admin=client(app);await admin.login('admin');});
after(async()=>db.end());
test('cadastro de marketplace e seletores exige admin e XSRF, com controle de versão',async()=>{
 const normal=client(app);await normal.login('alice');assert.equal((await normal.get('/api/admin/catalog-marketplaces')).status,403);assert.equal((await admin.agent.post('/api/admin/catalog-marketplaces').send({})).status,403);
 const body={id:'loja-teste',name:'Loja de teste',websiteUrl:'https://www.example.com',logoUrl:'https://cdn.example.com/logo.svg',allowedHosts:['www.example.com'],scrapingEnabled:true};assert.equal((await admin.mutate('post','/api/admin/catalog-marketplaces',{...body,allowedHosts:['127.0.0.1']})).status,400);assert.equal((await admin.mutate('post','/api/admin/catalog-marketplaces',body)).status,201);
 const publicMarket=(await admin.get('/api/marketplaces')).body.find(m=>m.id==='loja-teste');assert.equal(publicMarket.logo_url,body.logoUrl);assert.equal(publicMarket.website_url,body.websiteUrl);
 for(const logoUrl of ['http://www.example.com/logo.png','https://127.0.0.1/logo.png','https://internal.local/logo.png','https://user:secret@www.example.com/logo.png','data:image/svg+xml,test'])assert.equal((await admin.mutate('put','/api/admin/catalog-marketplaces/loja-teste',{...body,logoUrl})).status,400);
 const {logoUrl,...withoutLogo}=body;assert.equal((await admin.mutate('put','/api/admin/catalog-marketplaces/loja-teste',withoutLogo)).status,200);assert.equal((await admin.get('/api/admin/catalog-marketplaces')).body.find(m=>m.id==='loja-teste').logo_url,logoUrl);
 const profile={version:0,rules,waitTimeoutMs:1000,validityMinutes:60};assert.equal((await admin.mutate('put','/api/admin/selectors/loja-teste',profile)).status,200);assert.equal((await admin.mutate('put','/api/admin/selectors/loja-teste',profile)).status,409);assert.equal((await admin.get('/api/admin/selectors/loja-teste')).body.version,1);
});
test('teste de seletores não cadastra ofertas nem modifica regras salvas',async()=>{
 const response=await admin.mutate('post','/api/admin/selectors/loja-teste/test',{url:affiliate,profile:{version:1,rules,waitTimeoutMs:1000,validityMinutes:60}});assert.equal(response.status,200);assert.equal(response.body.isTest,true);assert.equal((await db.query('SELECT * FROM offers')).rows.length,0);assert.equal((await db.query('SELECT * FROM offer_import_previews')).rows.length,0);
});

test('marketplace normalization is configurable, preview-only and preserved for older clients',async()=>{
 const rules=[{type:'remove_path_suffix',marker:'/tracking/'}],body={id:'normalization-test',name:'Normalization test',websiteUrl:'https://shop.example.com',allowedHosts:['shop.example.com'],scrapingEnabled:true,urlNormalizationRules:rules};
 assert.equal((await admin.mutate('post','/api/admin/catalog-marketplaces',body)).status,201);
 const preview={url:'https://shop.example.com/p/123/tracking/context?x=1#details',allowedHosts:body.allowedHosts,rules};
 const before=calls;assert.deepEqual((await admin.mutate('post','/api/admin/catalog-marketplaces/normalize-url',preview)).body,{url:'https://shop.example.com/p/123'});assert.equal(calls,before);
 assert.equal((await admin.mutate('post','/api/admin/catalog-marketplaces/normalize-url',{...preview,url:'https://evil.example/p/123'})).status,400);
 assert.equal((await admin.mutate('post','/api/admin/catalog-marketplaces/normalize-url',{...preview,url:'https://shop.example.com/tracking/context'})).status,400);
 const normal=client(app);await normal.login('alice');assert.equal((await normal.mutate('post','/api/admin/catalog-marketplaces/normalize-url',preview)).status,403);
 const {urlNormalizationRules,...oldBody}=body;assert.equal((await admin.mutate('put','/api/admin/catalog-marketplaces/'+body.id,oldBody)).status,200);
 assert.deepEqual((await db.query('SELECT url_normalization_rules FROM marketplaces WHERE id=$1',[body.id])).rows[0].url_normalization_rules,rules);
 assert.equal((await admin.mutate('put','/api/admin/catalog-marketplaces/'+body.id,{...body,urlNormalizationRules:[{type:'script',marker:'/x'}]})).status,400);
 assert.equal((await admin.mutate('put','/api/admin/catalog-marketplaces/'+body.id,{...body,urlNormalizationRules:[]})).status,200);
 assert.deepEqual((await db.query('SELECT url_normalization_rules FROM marketplaces WHERE id=$1',[body.id])).rows[0].url_normalization_rules,[]);
});
test('prévia não cadastra oferta; confirmação mantém link original, imagens e características pendentes',async()=>{
 const response=await admin.mutate('post','/api/admin/link-imports/preview',{productId,marketplaceId:'loja-teste',url:affiliate,category:'Tecnologia'});assert.equal(response.status,200);assert.equal(response.body.canConfirm,true);assert.equal((await db.query('SELECT * FROM offers')).rows.length,0);
 assert.equal(response.body.data.productUrl,source);const stored=(await db.query('SELECT * FROM offer_import_previews WHERE id=$1',[response.body.previewId])).rows[0];assert.equal(stored.source_url,source);assert.equal(stored.result.productUrl,source);assert.equal(stored.affiliate_url,affiliate);
 const previewId=response.body.previewId;assert.equal((await admin.mutate('post','/api/admin/link-imports/confirm',{previewId,authorizedContent:false})).status,400);
 const confirmed=await admin.mutate('post','/api/admin/link-imports/confirm',{previewId,authorizedContent:true,affiliateUrl:'https://evil.test/'});assert.equal(confirmed.status,201);const offer=(await db.query('SELECT * FROM offers WHERE id=$1',[confirmed.body.offerId])).rows[0];assert.equal(offer.status,'pending');assert.equal(offer.source,'scraped');assert.equal(offer.affiliate_url,affiliate);assert.equal(offer.product_url,source);assert.equal(offer.price_cents,32100);assert.equal(offer.specifications[0].value,'Preto');assert.equal(offer.images.length,1);assert.equal(offer.category,'Tecnologia');
 assert.equal((await admin.mutate('post','/api/admin/link-imports/confirm',{previewId,authorizedContent:true})).status,409);assert.equal((await admin.get('/api/offers/'+offer.id)).status,404);
 assert.equal((await admin.mutate('post','/api/admin/offers/'+offer.id+'/review',{action:'publish',expectedUpdatedAt:offer.updated_at.toISOString()})).status,200);assert.equal((await admin.get('/api/offers?marketplace=loja-teste')).body.total,1);assert.equal((await admin.get('/api/offers/'+offer.id)).body.marketplace_name,'Loja de teste');assert.equal((await admin.mutate('post','/api/offers/'+offer.id+'/click',{placement:'detail'})).status,200);
 assert.equal((await admin.mutate('delete','/api/admin/catalog-marketplaces/loja-teste')).status,409);
});
test('confirmação bloqueia duplicação, dados ausentes, prévia expirada e alterações nas regras',async()=>{
 const preview=async()=>{const r=await admin.mutate('post','/api/admin/link-imports/preview',{productId,marketplaceId:'loja-teste',url:affiliate});assert.equal(r.status,200);return r.body;};const confirm=p=>admin.mutate('post','/api/admin/link-imports/confirm',{previewId:p.previewId,authorizedContent:true});
 assert.equal((await confirm(await preview())).status,409);
 missing=true;const invalid=await preview();assert.equal(invalid.canConfirm,false);assert.equal((await confirm(invalid)).status,409);missing=false;
 const expired=await preview();await db.query('UPDATE offer_import_previews SET expires_at=$2 WHERE id=$1',[expired.previewId,new Date(Date.now()-1000)]);assert.equal((await confirm(expired)).status,409);
 const changed=await preview();await admin.mutate('put','/api/admin/selectors/loja-teste',{version:1,rules,waitTimeoutMs:1000,validityMinutes:60});assert.equal((await confirm(changed)).status,409);
});
test('prévia pertence ao administrador que a gerou e redirecionamentos precisam de domínio cadastrado',async()=>{
 const p=await admin.mutate('post','/api/admin/link-imports/preview',{productId,marketplaceId:'loja-teste',url:affiliate});const another=client(app);await another.login('otheradmin');await db.query("UPDATE users SET role='admin',access_profile_id='admin' WHERE email='otheradmin@gmail.com'");assert.equal((await another.mutate('post','/api/admin/link-imports/confirm',{previewId:p.body.previewId,authorizedContent:true})).status,404);
 const before=calls;assert.equal((await admin.mutate('post','/api/admin/link-imports/preview',{productId,marketplaceId:'loja-teste',url:'https://evil.test/'})).status,400);assert.equal(calls,before);
});

test('Amazon aceita os domínios do link curto e rejeita domínios semelhantes',async()=>{
 const {assertRegisteredLink}=await import('../dist/scraping-admin.js');
 const hosts=(await db.query("SELECT allowed_hosts FROM marketplaces WHERE id='amazon'")).rows[0].allowed_hosts;
 for(const host of ['link.amazon','amzlinks.in','www.amazon.com.br','amzn.to'])assert.ok(hosts.includes(host));
 for(const host of ['link.amazon','amzlinks.in'])assert.equal(await assertRegisteredLink(db,'amazon','https://'+host+'/B01rERc8f'),'https://'+host+'/B01rERc8f');
 for(const url of ['http://link.amazon/B01rERc8f','https://link.amazon.evil.example/B01rERc8f','https://link.amazon@evil.example/B01rERc8f'])await assert.rejects(()=>assertRegisteredLink(db,'amazon',url),e=>e.status===400);
});
