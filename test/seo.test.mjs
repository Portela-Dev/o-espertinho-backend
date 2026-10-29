import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {testDatabase,createApp,testConfig,seedProduct,seedOffer} from './helpers.mjs';

test('public sitemap includes only listed products and their ancestor categories with stable pagination',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig());
 const listed=await seedProduct(db,{name:'Listado',category:'SEO',subcategory:'Filho'});
 await seedOffer(db,{productId:listed});
 const pending=await seedProduct(db,{name:'Pendente',category:'Privada'});await seedOffer(db,{productId:pending,status:'pending'});
 const unavailable=await seedProduct(db,{name:'Indisponível',category:'Privada'});await seedOffer(db,{productId:unavailable,availability:'unavailable'});
 const noLink=await seedProduct(db,{name:'Sem link',category:'Privada'});const withoutLink=await seedOffer(db,{productId:noLink});await db.query('UPDATE offers SET affiliate_url=NULL WHERE id=$1',[withoutLink]);
 await seedProduct(db,{name:'Sem oferta',category:'Vazia'});
 let res=await request(app).get('/api/seo/sitemap');assert.equal(res.status,200);assert.match(res.headers['cache-control'],/max-age=300/);
 assert.equal(res.body.total,3);assert.equal(res.body.totalPages,1);assert.equal(res.body.pageSize,1000);assert.equal(res.body.items.filter(i=>i.type==='product')[0].id,listed);
 const ids=(await db.query('SELECT category_ids FROM products WHERE id=$1',[listed])).rows[0].category_ids;
 assert.deepEqual(new Set(res.body.items.filter(i=>i.type==='category').map(i=>i.id)),new Set(ids));
 for(const item of res.body.items)assert.deepEqual(Object.keys(item).sort(),['id','type','updated_at']);
 for(const page of ['0','-1','10001','1.5','invalid'])assert.equal((await request(app).get('/api/seo/sitemap?page='+page)).status,400);
 // A catalog larger than one shard, using the disposable database only.
 await db.query("INSERT INTO products(id,name,category) SELECT gen_random_uuid(),'SEO bulk '||i,'SEO' FROM generate_series(1,1001) i");
 await db.query("INSERT INTO offers(id,marketplace_id,external_id,title,product_url,affiliate_url,price_cents,status,source,product_id,expires_at) SELECT gen_random_uuid(),'amazon',p.id::text,p.name,'https://example.com/p','https://example.com/a/'||p.id::text,100,'published','manual',p.id,now()+interval '1 day' FROM products p WHERE p.name LIKE 'SEO bulk %'");
 const a=(await request(app).get('/api/seo/sitemap?page=1')).body,b=(await request(app).get('/api/seo/sitemap?page=2')).body;
 assert.equal(a.total,1004);assert.equal(a.totalPages,2);assert.equal(a.items.length,1000);assert.equal(b.items.length,4);
 assert.equal(new Set([...a.items,...b.items].map(i=>i.type+':'+i.id)).size,1004);
 assert.deepEqual((await request(app).get('/api/seo/sitemap?page=1')).body,a);
 assert.equal((await request(app).get('/api/seo/sitemap?page=3')).body.items.length,0);
});
