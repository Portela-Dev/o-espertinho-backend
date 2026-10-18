import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cancelOfferRefresh} from '../dist/offer-refresh.js';
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

test('cancelamento exige admin e XSRF, preserva resultados, invalida tentativas e libera outra rodada',async t=>{
 const {db,admin,user}=await fixture(t),first=await seedOffer(db,{source:'scraped',price:15000}),second=await seedOffer(db,{source:'scraped',price:20000});
 const run=(await admin.mutate('post','/api/admin/offer-refresh/run')).body;
 await db.query("UPDATE offer_refresh_runs SET status='running',processed=1,pending=1,next_item_at=now()+interval '5 minutes' WHERE id=$1",[run.id]);
 await db.query("UPDATE offer_refresh_items SET status='done',outcome='pending',finished_at=now(),error='Falha técnica' WHERE run_id=$1 AND offer_id=$2",[run.id,first]);
 const progress=(await admin.get('/api/admin/offer-refresh')).body.active;assert.equal(progress.phase,'paused');assert.equal(progress.pause_reason,'technical_failure');
 await db.query("UPDATE offer_refresh_items SET status='running',attempt_id=$1,lease_until=now()+interval '5 minutes' WHERE run_id=$2 AND offer_id=$3",[randomUUID(),run.id,second]);
 assert.equal((await admin.get('/api/admin/offer-refresh')).body.active.phase,'extracting');
 const path='/api/admin/offer-refresh/runs/'+run.id+'/cancel';
 assert.equal((await user.mutate('post',path)).status,403);assert.equal((await admin.agent.post(path).send({})).status,403);
 const cancelled=await admin.mutate('post',path);assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'cancelled');assert.ok(cancelled.body.cancelled_at);assert.equal(cancelled.body.processed,2);assert.equal(cancelled.body.pending,1);assert.equal(cancelled.body.skipped,1);
 const item=(await db.query('SELECT * FROM offer_refresh_items WHERE run_id=$1 AND offer_id=$2',[run.id,second])).rows[0];assert.equal(item.status,'done');assert.equal(item.outcome,'skipped');assert.equal(item.attempt_id,null);assert.equal(item.lease_until,null);
 assert.equal((await admin.get('/api/admin/offer-refresh')).body.active,null);assert.equal((await db.query('SELECT price_cents FROM offers WHERE id=$1',[first])).rows[0].price_cents,15000);assert.equal((await db.query('SELECT count(*)::int AS n FROM offer_price_history')).rows[0].n,0);
 assert.equal((await admin.mutate('post',path)).status,200);assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='offer_refresh.cancelled'")).rows[0].n,1);
 const next=await admin.mutate('post','/api/admin/offer-refresh/run');assert.equal(next.status,202);assert.notEqual(next.body.id,run.id);assert.ok(new Date(next.body.next_item_at)>=new Date(cancelled.body.next_item_at));
 assert.equal((await admin.get('/api/admin/offer-refresh')).body.active.phase,'paused');
 assert.equal((await admin.get('/api/admin/offer-refresh')).body.active.pause_reason,'interval');
});

test('cancelamento recusa rodada concluída, valida ID e desfaz alterações quando auditoria falha',async t=>{
 const {db,admin}=await fixture(t);const completed=(await admin.mutate('post','/api/admin/offer-refresh/run')).body;
 assert.equal((await admin.mutate('post','/api/admin/offer-refresh/runs/'+completed.id+'/cancel')).status,409);
 assert.equal((await admin.mutate('post','/api/admin/offer-refresh/runs/invalid/cancel')).status,400);
 assert.equal((await admin.mutate('post','/api/admin/offer-refresh/runs/'+randomUUID()+'/cancel')).status,404);
 const offer=await seedOffer(db,{source:'scraped'}),run=(await admin.mutate('post','/api/admin/offer-refresh/run')).body;
 const uid=(await admin.get('/api/auth/session')).body.user.id;
 const wrapped={...db,connect:async()=>{const c=await db.connect();return {...c,query:(sql,args)=>{if(sql.includes('INSERT INTO audit_logs'))throw new Error('audit failed');return c.query(sql,args);}};}};
 await assert.rejects(()=>cancelOfferRefresh(wrapped,run.id,uid),/audit failed/);
 assert.equal((await db.query('SELECT status FROM offer_refresh_runs WHERE id=$1',[run.id])).rows[0].status,'queued');assert.equal((await db.query('SELECT status FROM offer_refresh_items WHERE run_id=$1 AND offer_id=$2',[run.id,offer])).rows[0].status,'queued');
 await db.query("UPDATE offer_refresh_runs SET next_item_at=now()-interval '1 second' WHERE id=$1",[run.id]);assert.equal((await admin.get('/api/admin/offer-refresh')).body.active.phase,'queued');
});
