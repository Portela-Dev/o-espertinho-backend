import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {testDatabase,testConfig,createApp,seedOffer,seedProduct} from './helpers.mjs';

test('listagem retorna marketplaces únicos apenas das ofertas públicas disponíveis',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());
 const productId=await seedProduct(db);
 await db.query("INSERT INTO marketplaces(id,name,website_url,logo_url) VALUES('loja-teste','Loja Teste','https://loja.example','https://loja.example/logo.png')");
 for(const marketplace of ['amazon','amazon','mercadolivre','loja-teste'])await seedOffer(db,{productId,marketplace});
 const unavailable=await seedProduct(db);
 await seedOffer(db,{productId:unavailable,marketplace:'mercadolivre',availability:'unavailable'});
 await seedOffer(db,{productId:unavailable,status:'pending'});
 const hidden=await seedOffer(db,{productId,marketplace:'loja-teste'});
 await db.query('UPDATE offers SET affiliate_url=NULL WHERE id=$1',[hidden]);
 // Remove the only valid offer from this marketplace; a private offer cannot add its logo.
 await db.query("UPDATE offers SET availability_status='unavailable' WHERE product_id=$1 AND marketplace_id='loja-teste' AND affiliate_url IS NOT NULL",[productId]);
 const app=createApp(db,testConfig());
 for(const query of ['', '?marketplace=amazon']){
  const res=await request(app).get('/api/products'+query);
  assert.equal(res.status,200,JSON.stringify(res.body));assert.equal(res.body.total,1);
  assert.deepEqual(res.body.items[0].marketplaces.map(m=>m.id),['amazon','mercadolivre']);
  assert.equal(res.body.items[0].offer_count,3);
 }
 // An arbitrary newly registered marketplace needs no code change to appear.
 await seedOffer(db,{productId,marketplace:'loja-teste'});
 const res=await request(app).get('/api/products');
 const store=res.body.items[0].marketplaces.find(m=>m.id==='loja-teste');
 assert.equal(store.name,'Loja Teste');assert.equal(store.logo_url,'https://loja.example/logo.png');
});
