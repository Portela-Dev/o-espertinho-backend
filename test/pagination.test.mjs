import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,client,createApp,identity,seedOffer} from './helpers.mjs';
import {pagedQuery} from '../dist/pagination.js';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}),admin=client(app),user=client(app);await admin.login('admin');await user.login('alice');return {db,admin,user};}
test('paged queries validate bounded integers, stable order, empty results and clamp deleted last pages',async t=>{
 const {db}=await fixture(t);
 const sql='SELECT id FROM marketplaces ORDER BY id';
 const all=await pagedQuery(db,{},sql);assert.ok(Array.isArray(all));
 const first=await pagedQuery(db,{paginate:'true',page:1,pageSize:1},sql),second=await pagedQuery(db,{paginate:'true',page:2,pageSize:1},sql);
 assert.equal(first.total,all.length);assert.equal(first.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);
 assert.equal((await pagedQuery(db,{paginate:'true',page:999,pageSize:1},sql)).page,all.length);
 assert.deepEqual(await pagedQuery(db,{paginate:'true'},'SELECT id FROM marketplaces WHERE false'),{items:[],total:0,page:1,pageSize:20});
 for(const query of [{page:0},{page:-1},{page:1.5},{page:100001},{pageSize:0},{pageSize:51},{pageSize:'invalid'}])await assert.rejects(()=>pagedQuery(db,{paginate:'true',...query},sql));
});
test('personal pagination counts only the current user and preserves ownership checks',async t=>{
 const {db,admin,user}=await fixture(t);const ids=[await seedOffer(db),await seedOffer(db)];
 for(const id of ids)assert.equal((await admin.mutate('put','/api/me/favorites/'+id)).status,200);
 for(let i=0;i<3;i++){
  await admin.mutate('post','/api/me/collections',{name:'Catalog '+i});
  await admin.mutate('post','/api/me/filters',{name:'Filter '+i,filters:{}});
 }
 for(const route of ['favorites','collections','filters']){
  const first=await admin.get('/api/me/'+route+'?paginate=true&pageSize=1');assert.equal(first.status,200);assert.equal(first.body.items.length,1);assert.ok(first.body.total>=2);
  const second=await admin.get('/api/me/'+route+'?paginate=true&pageSize=1&page=2');assert.notEqual(first.body.items[0].id,second.body.items[0].id);
  assert.equal((await user.get('/api/me/'+route+'?paginate=true')).body.total,0);
 }
 const collection=(await admin.get('/api/me/collections')).body[0];for(const id of ids)await admin.mutate('put','/api/me/collections/'+collection.id+'/items/'+id);
 const result=await admin.get('/api/me/collections/'+collection.id+'?paginate=true&pageSize=1&page=2');assert.equal(result.body.total,2);assert.equal(result.body.items.length,1);assert.equal(result.body.name,collection.name);
 assert.equal((await user.get('/api/me/collections/'+collection.id+'?paginate=true')).status,404);
});
test('administrative collections page without caps and public product range is independent of offer page',async t=>{
 const {db,admin,user}=await fixture(t);const a=await seedOffer(db,{source:'scraped',price:10000}),product=(await db.query('SELECT product_id FROM offers WHERE id=$1',[a])).rows[0].product_id;
 await seedOffer(db,{source:'scraped',price:20000,productId:product});await seedOffer(db,{source:'scraped'});
 for(let i=0;i<105;i++)await db.query('INSERT INTO audit_logs(id,action,entity_id) VALUES($1,$2,$3)',[randomUUID(),'test.entry',String(i)]);
 for(const path of ['products','catalog-marketplaces','link-imports','offers?status=all','audit']){
  const separator=path.includes('?')?'&':'?';const url='/api/admin/'+path+separator+'paginate=true&pageSize=1';const first=await admin.get(url),second=await admin.get(url+'&page=2');assert.equal(first.status,200,url);assert.equal(first.body.items.length,1,url);assert.ok(first.body.total>1,url);assert.notEqual(first.body.items[0].id,second.body.items[0].id,url);assert.equal((await user.get(url)).status,403,url);
 }
 assert.equal((await admin.get('/api/admin/audit?paginate=true&pageSize=1&page=105')).body.total,105);
 const profiles=await admin.get('/api/admin/access-profiles?paginate=true&pageSize=1');assert.equal(profiles.body.profiles.length,1);assert.ok(profiles.body.permissions.length);assert.ok(profiles.body.total>=2);
 const detail=await admin.get('/api/products/'+product+'?paginate=true&pageSize=1&page=2');assert.equal(detail.body.offers.length,1);assert.equal(detail.body.offer_count,2);assert.equal(detail.body.min_price_cents,10000);assert.equal(detail.body.max_price_cents,20000);assert.equal(detail.body.sku,undefined);
 for(const offer of (await db.query('SELECT id,marketplace_id FROM offers')).rows)await db.query("INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,$3,'detail')",[randomUUID(),offer.id,offer.marketplace_id]);
 const stats=await admin.get('/api/admin/stats?paginate=true&topPage=2&pageSize=1');assert.equal(stats.body.top.length,1);assert.equal(stats.body.topTotal,3);assert.equal(stats.body.topPage,2);assert.equal(stats.body.totalClicks,3);
});

test('users accept selected page size, preserve filters and validate server limits',async t=>{
 const {admin}=await fixture(t);
 const first=await admin.get('/api/admin/users?pageSize=1');assert.equal(first.status,200);assert.equal(first.body.items.length,1);assert.equal(first.body.pageSize,1);assert.equal(first.body.total,2);
 const second=await admin.get('/api/admin/users?pageSize=1&page=2');assert.notEqual(first.body.items[0].id,second.body.items[0].id);
 const resized=await admin.get('/api/admin/users?pageSize=50&page=1');assert.equal(resized.body.items.length,2);assert.equal(resized.body.page,1);assert.equal(resized.body.pageSize,50);
 const filtered=await admin.get('/api/admin/users?pageSize=5&q=alice');assert.equal(filtered.body.total,1);assert.equal(filtered.body.items[0].email,'alice@gmail.com');
 for(const value of ['0','51','1.5','invalid'])assert.equal((await admin.get('/api/admin/users?pageSize='+value)).status,400);
});
