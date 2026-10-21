import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {readFile} from 'node:fs/promises';
import {testDatabase,testConfig,createApp,seedOffer,seedProduct} from './helpers.mjs';
import {scrapedDataSchema} from '../dist/extraction-data.js';

test('produto usa nota e contagem da mesma oferta com mais avaliações, em todas as páginas',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig());
 const product=await seedProduct(db),offer=async(rating,count,changes={})=>{
  const id=await seedOffer(db,{productId:product,...changes});
  await db.query('UPDATE offers SET rating=$2,review_count=$3 WHERE id=$1',[id,rating,count]);return id;
 };
 await offer(5,10,{price:100});const winner=await offer(4.3,1200,{price:200});
 await offer(4.9,9000,{availability:'unavailable'});await offer(4.8,10000,{status:'pending'});await offer(null,15000);await offer(5,null);
 for(const path of ['/api/products','/api/products/'+product,'/api/products/'+product+'?page=1&pageSize=1']){
  const r=await request(app).get(path);assert.equal(r.status,200,JSON.stringify(r.body));
  const p=r.body.items?r.body.items[0]:r.body;assert.equal(p.rating,4.3);assert.equal(p.review_count,1200);assert.equal(p.rating_marketplace_name,'Amazon');assert.equal(p.min_price_cents,100);
 }
 const raw=await request(app).get('/api/offers/'+winner);assert.equal(raw.body.rating,4.3);assert.equal(raw.body.review_count,1200);
 await db.query('UPDATE offers SET rating=NULL,review_count=NULL WHERE product_id=$1',[product]);
 const empty=await request(app).get('/api/products/'+product);assert.equal(empty.body.rating,null);assert.equal(empty.body.review_count,null);
 await assert.rejects(()=>db.query('UPDATE offers SET rating=5.1 WHERE id=$1',[winner]));
 assert.equal(scrapedDataSchema.shape.rating.safeParse(8).success,false);assert.equal(scrapedDataSchema.shape.reviewCount.safeParse(-1).success,false);
});

test('migration configura campos opcionais nos perfis sem sobrescrever seletor customizado',async t=>{
 const {db,pg}=await testDatabase({through:'036z'});t.after(()=>db.end());
 await db.query(`UPDATE scraping_profiles SET rules=rules||'[ {"field":"rating","selectors":[".custom-rating"],"mode":"text","required":false} ]'::jsonb WHERE marketplace_id='amazon'`);
 await pg.exec(await readFile(new URL('../migrations/037_offer_ratings.sql',import.meta.url),'utf8'));
 const profiles=(await db.query('SELECT marketplace_id,rules FROM scraping_profiles')).rows;
 const amazon=profiles.find(p=>p.marketplace_id==='amazon');assert.equal(amazon.rules.filter(r=>r.field==='rating').length,1);assert.deepEqual(amazon.rules.find(r=>r.field==='rating').selectors,['.custom-rating']);assert.equal(amazon.rules.find(r=>r.field==='reviewCount').required,false);
 const ml=profiles.find(p=>p.marketplace_id==='mercadolivre');assert.ok(ml.rules.find(r=>r.field==='rating'));assert.ok(ml.rules.find(r=>r.field==='reviewCount'));
});
