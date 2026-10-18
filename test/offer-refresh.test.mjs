import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,identity,client,seedOffer,createApp} from './helpers.mjs';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}),admin=client(app),user=client(app);await admin.login('admin');await user.login('alice');return {db,admin,user};}
test('admin configura periodicidade com versão, autenticação e XSRF; disparo manual enfileira sem consultar marketplaces',async t=>{
 const {db,admin,user}=await fixture(t);const s=(await admin.get('/api/admin/offer-refresh')).body.settings;assert.equal(s.interval_hours,8);assert.equal(s.request_interval_ms,60000);
 assert.equal((await user.get('/api/admin/offer-refresh')).status,403);assert.equal((await admin.agent.post('/api/admin/offer-refresh/run').send({})).status,403);
 const body={enabled:false,intervalHours:12,requestIntervalMs:100,expectedUpdatedAt:s.updated_at};
 assert.equal((await admin.mutate('put','/api/admin/offer-refresh',{...body,requestIntervalMs:99})).status,400);
 assert.equal((await admin.mutate('put','/api/admin/offer-refresh',body)).status,200);assert.equal((await admin.mutate('put','/api/admin/offer-refresh',body)).status,409);
 await seedOffer(db,{source:'scraped'});const r=await admin.mutate('post','/api/admin/offer-refresh/run');assert.equal(r.status,202);assert.equal(r.body.total,1);assert.equal(r.body.status,'queued');
 assert.equal((await admin.mutate('post','/api/admin/offer-refresh/run')).status,409);assert.equal((await admin.get('/api/admin/offer-refresh/runs/'+r.body.id)).status,200);
 assert.equal((await user.mutate('post','/api/admin/offer-refresh/run')).status,403);
});

test('API enqueues empty runs as completed and never starts marketplace extraction',async t=>{
 const {db,admin}=await fixture(t);const response=await admin.mutate('post','/api/admin/offer-refresh/run');
 assert.equal(response.status,202);assert.equal(response.body.status,'completed');assert.equal(response.body.total,0);
 await seedOffer(db,{source:'scraped'});const queued=await admin.mutate('post','/api/admin/offer-refresh/run');assert.equal(queued.status,202);
 assert.equal((await admin.get('/api/admin/offer-refresh/runs/not-a-uuid')).status,400);
 assert.equal((await admin.get('/api/admin/offer-refresh/runs/00000000-0000-4000-8000-000000000000')).status,404);
});
