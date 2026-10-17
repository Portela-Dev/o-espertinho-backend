import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,identity,client,seedOffer,seedProduct,createApp} from './helpers.mjs';
let db,admin,user,app;
before(async()=>{({db}=await testDatabase());app=createApp(db,testConfig(),{verifyGoogle:async t=>identity(t),extractor:{extract:async url=>({title:'Fone extraído',priceCents:32100,originalPriceCents:null,description:'',category:'Outra',conditions:'',externalId:randomUUID(),productUrl:url,images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()})}});admin=client(app);user=client(app);await admin.login('admin');await user.login('alice');});
after(async()=>db.end());
const draft={name:'Headset preto H510',brand:'Redragon',model:'H510 preto',category:'Tecnologia',subcategory:'Áudio'};
const offerBody=productId=>({productId,marketplaceId:'mercadolivre',externalId:randomUUID(),title:'Anúncio',category:'Ignorada',productUrl:'https://www.mercadolivre.com.br/item',affiliateUrl:'https://www.mercadolivre.com.br/sec/'+randomUUID(),priceCents:32100,expiresAt:new Date(Date.now()+3600000).toISOString(),authorizedContent:true});

test('produto exige admin e XSRF; produto sem links tem página e fica fora da vitrine',async()=>{
 assert.equal((await user.mutate('post','/api/admin/products',draft)).status,403);assert.equal((await admin.agent.post('/api/admin/products').send(draft)).status,403);
 const r=await admin.mutate('post','/api/admin/products',draft);assert.equal(r.status,201);assert.match(r.body.sku,/^ESP-\d+$/);assert.equal(r.body.category,'Tecnologia');
 const detail=await user.get('/api/products/'+r.body.id);assert.equal(detail.status,200);assert.equal('sku' in detail.body,false);assert.equal(detail.body.status,'unavailable');assert.equal(detail.body.available,false);assert.deepEqual(detail.body.offers,[]);assert.equal(detail.body.min_price_cents,null);assert.equal((await user.get('/api/products')).body.total,0);
 assert.equal((await admin.get('/api/admin/products')).body[0].link_count,0);assert.equal((await admin.get('/api/admin/products')).body[0].sku,r.body.sku);
});
test('nenhuma entrada aceita link sem produto existente, incluindo importação e prévia',async()=>{
 const b=offerBody(undefined);assert.equal((await admin.mutate('post','/api/admin/offers',b)).status,400);assert.equal((await admin.mutate('post','/api/admin/offers',{...b,productId:randomUUID()})).status,404);
 assert.equal((await admin.mutate('post','/api/admin/link-imports/preview',{marketplaceId:'amazon',url:'https://www.amazon.com.br/dp/B012345678'})).status,400);
 assert.equal((await admin.mutate('post','/api/admin/amazon/import',{asin:'B012345678'})).status,400);assert.equal((await admin.mutate('post','/api/admin/mercadolivre/import',{itemId:'MLB12345',affiliateUrl:b.affiliateUrl,authorizedContent:true})).status,400);
 await assert.rejects(()=>db.query("INSERT INTO offers(id,marketplace_id,external_id,title,product_url,price_cents,source,expires_at) VALUES($1,'amazon','missing','X','https://www.amazon.com.br',100,'manual',now())",[randomUUID()]));
});
test('vitrine agrupa links, calcula faixa apenas com publicadas válidas e filtra por produto',async()=>{
 const p=await seedProduct(db,{name:'Produto faixa exclusiva'});
 await seedOffer(db,{productId:p,price:32100});await seedOffer(db,{productId:p,price:45000,marketplace:'mercadolivre',affiliate:'https://www.mercadolivre.com.br/sec/range'});
 await seedOffer(db,{productId:p,price:100,status:'pending'});await seedOffer(db,{productId:p,price:90000,status:'rejected'});await seedOffer(db,{productId:p,price:80000,availability:'unavailable',expires:new Date(Date.now()-1000)});await seedOffer(db,{productId:p,price:70000,status:'expired'});
 const list=await user.get('/api/products?q=faixa');assert.equal(list.status,200);assert.equal(list.body.total,1);assert.equal(list.body.items[0].min_price_cents,32100);assert.equal(list.body.items[0].max_price_cents,45000);assert.equal(list.body.items[0].offer_count,2);
 const code=(await db.query('SELECT sku FROM products WHERE id=$1',[p])).rows[0].sku;assert.equal('sku' in list.body.items[0],false);assert.equal((await user.get('/api/products?q='+encodeURIComponent(code))).body.total,0);assert.ok((await admin.get('/api/admin/products?q='+encodeURIComponent(code))).body.some(p=>p.sku===code));
 const detail=(await user.get('/api/products/'+p)).body;assert.equal(detail.available,true);assert.equal(detail.offers.length,2);assert.equal(detail.max_price_cents,45000);
 assert.equal((await user.get('/api/products?q=faixa&marketplace=mercadolivre')).body.total,1);assert.equal((await user.get('/api/products?q=faixa&maxPrice=32099')).body.total,0);assert.equal((await user.get('/api/products?maxPrice=-1')).status,400);
 assert.equal((await user.get('/api/products?q='+encodeURIComponent("' OR 1=1 --"))).body.total,0);
 await db.query("UPDATE offers SET status='expired' WHERE product_id=$1",[p]);assert.equal((await user.get('/api/products?q=faixa')).body.total,0);assert.equal((await user.get('/api/products/'+p)).body.available,false);
});
test('classificação é do produto, sugestões são reutilizadas e edição propaga aos links',async()=>{
 const create=await admin.mutate('post','/api/admin/products',{...draft,name:'Produto classificação',category:'  tecnologia ',subcategory:'Fones   de ouvido'});assert.equal(create.status,201);assert.equal(create.body.category,'Tecnologia');assert.equal(create.body.subcategory,'Fones de ouvido');
 const p=create.body,id=await seedOffer(db,{productId:p.id});let o=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];assert.equal(o.subcategory,'Fones de ouvido');
 const response=await admin.mutate('put','/api/admin/products/'+p.id,{...draft,category:'Casa',subcategory:'Escritório',expectedUpdatedAt:p.updated_at});assert.equal(response.status,200);o=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];assert.equal(o.category,'Casa');assert.equal(o.subcategory,'Escritório');assert.equal(o.status,'published');assert.equal(o.price_cents,99990);
 assert.equal((await admin.mutate('put','/api/admin/products/'+p.id,{...draft,expectedUpdatedAt:p.updated_at})).status,409);
 const options=(await admin.get('/api/admin/category-options')).body;assert.ok(options.some(x=>x.subcategory==='Fones de ouvido'));assert.ok(options.some(x=>x.category==='Casa'&&x.subcategory==='Escritório'));
 const updated=response.body;assert.equal((await admin.mutate('put','/api/admin/products/'+p.id,{...draft,category:'Casa',subcategory:'',expectedUpdatedAt:updated.updated_at})).status,200);
 assert.equal((await admin.mutate('put','/api/admin/offers/'+id+'/classification',{category:'Outra'})).status,409);
});
test('mesmo identificador externo pode ter links diferentes; produto é obrigatório e pode ser corrigido',async()=>{
 const p=await seedProduct(db),other=await seedProduct(db,{category:'Casa'}),b=offerBody(p);b.externalId='MESMO-ITEM';
 const first=await admin.mutate('post','/api/admin/offers',b);assert.equal(first.status,201);const second=await admin.mutate('post','/api/admin/offers',{...b,affiliateUrl:b.affiliateUrl+'-outro'});assert.equal(second.status,201);assert.equal(first.body.category,'Tecnologia');
 assert.equal((await admin.mutate('post','/api/admin/offers',b)).status,409);
 await assert.rejects(()=>db.query('DELETE FROM products WHERE id=$1',[p]));
 const reassigned=await admin.mutate('put','/api/admin/offers/'+first.body.id+'/product',{productId:other,expectedUpdatedAt:first.body.updated_at});assert.equal(reassigned.status,200);const o=(await db.query('SELECT * FROM offers WHERE id=$1',[first.body.id])).rows[0];assert.equal(o.product_id,other);assert.equal(o.category,'Casa');assert.equal(o.status,'pending');assert.equal(o.affiliate_url,b.affiliateUrl);
});
test('prévia fixa o produto escolhido, herda classificação e exige nova prévia se produto mudar',async()=>{
 const p=(await admin.mutate('post','/api/admin/products',{...draft,name:'Produto prévia'})).body;
 const preview=async()=>admin.mutate('post','/api/admin/link-imports/preview',{marketplaceId:'amazon',productId:p.id,url:'https://www.amazon.com.br/dp/B012345678?tag=test-20&preview='+randomUUID(),category:'Ignorada',sellerName:'Loja A'});
 const first=await preview();assert.equal(first.status,200);assert.equal(first.body.product.id,p.id);assert.equal(first.body.data.category,p.category);
 await admin.mutate('put','/api/admin/products/'+p.id,{...draft,name:'Produto alterado',expectedUpdatedAt:p.updated_at});assert.equal((await admin.mutate('post','/api/admin/link-imports/confirm',{previewId:first.body.previewId,authorizedContent:true})).status,409);
 const fresh=await preview();const confirmed=await admin.mutate('post','/api/admin/link-imports/confirm',{previewId:fresh.body.previewId,authorizedContent:true,productId:randomUUID()});assert.equal(confirmed.status,201);const o=(await db.query('SELECT * FROM offers WHERE id=$1',[confirmed.body.offerId])).rows[0];assert.equal(o.product_id,p.id);assert.equal(o.seller_name,'Loja A');
});
