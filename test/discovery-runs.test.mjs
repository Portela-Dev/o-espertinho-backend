import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,client,createApp,identity} from './helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
let db,admin,user;
before(async()=>{({db}=await testDatabase());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)});admin=client(app);user=client(app);await admin.login('admin');await user.login('alice');});
after(async()=>db.end());
async function source(){const config=defaultDiscoveryConfig();config.extraction.itemSelector='.card';config.limits.maxPages=1;const p=await admin.mutate('post','/api/admin/discovery/profiles',{name:randomUUID(),marketplaceId:'amazon',config});assert.equal(p.status,201);const r=await admin.mutate('post','/api/admin/discovery/sources',{name:randomUUID(),marketplaceId:'amazon',profileId:p.body.id,url:'https://www.amazon.com.br/section/'+randomUUID(),enabled:false});assert.equal(r.status,201);return r.body;}
test('manual queue snapshots config and source, prevents overlap and leaves catalog and schedules untouched',async()=>{
 const s=await source();const r=await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{});assert.equal(r.status,202);assert.equal(r.body.status,'queued');
 const saved=(await db.query('SELECT snapshot FROM discovery_runs WHERE id=$1',[r.body.id])).rows[0].snapshot;assert.equal(saved.config.limits.maxPages,1);assert.equal(saved.url,s.url);assert.ok(saved.allowedHosts.includes('www.amazon.com.br'));
 assert.equal((await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{})).status,409);
 assert.equal((await admin.get('/api/admin/discovery/runs?pageSize=5')).body.items[0].id,r.body.id);
 assert.equal((await admin.get('/api/admin/discovery/runs/'+r.body.id)).body.source_id,s.id);
 assert.equal((await admin.mutate('delete','/api/admin/discovery/sources/'+s.id,{version:1})).status,409);
 for(const table of ['offers','products','offer_refresh_runs','sync_runs'])assert.equal((await db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
});
test('cancellation is idempotent, invalidates worker ownership and permits a new request',async()=>{
 const s=await source(),run=(await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{})).body;
 await db.query("UPDATE discovery_runs SET status='running',worker_id=$2,lease_until=clock_timestamp()+interval '1 minute',pages=1 WHERE id=$1",[run.id,randomUUID()]);
 const r=await admin.mutate('post','/api/admin/discovery/runs/'+run.id+'/cancel',{});assert.equal(r.status,200);assert.equal(r.body.status,'cancelled');assert.equal(r.body.pages,1);
 const saved=(await db.query('SELECT worker_id,lease_until FROM discovery_runs WHERE id=$1',[run.id])).rows[0];assert.equal(saved.worker_id,null);assert.equal(saved.lease_until,null);
 assert.equal((await admin.mutate('post','/api/admin/discovery/runs/'+run.id+'/cancel',{})).status,200);
 const next=await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{});assert.equal(next.status,202);
 await db.query("UPDATE discovery_runs SET status='completed' WHERE id=$1",[next.body.id]);assert.equal((await admin.mutate('post','/api/admin/discovery/runs/'+next.body.id+'/cancel',{})).status,409);
});
test('paused sections require explicit resume; links retain origins, pagination and archive identity',async()=>{
 const s=await source();await db.query("UPDATE discovery_sources SET paused_at=clock_timestamp(),pause_reason='blocked' WHERE id=$1",[s.id]);
 assert.equal((await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{})).status,409);
 const run=await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{resume:true});assert.equal(run.status,202);assert.equal((await db.query('SELECT paused_at FROM discovery_sources WHERE id=$1',[s.id])).rows[0].paused_at,null);
 const linkId=randomUUID();await db.query('INSERT INTO discovery_links(id,marketplace_id,url) VALUES($1,$2,$3)',[linkId,'amazon','https://www.amazon.com.br/product/test']);await db.query('INSERT INTO discovery_link_sources(link_id,source_id) VALUES($1,$2)',[linkId,s.id]);await db.query('INSERT INTO discovery_run_links(run_id,link_id,is_new) VALUES($1,$2,true)',[run.body.id,linkId]);
 const found=await admin.get('/api/admin/discovery/links?runId='+run.body.id+'&sourceId='+s.id+'&marketplaceId=amazon&pageSize=5');assert.equal(found.body.total,1);assert.equal(found.body.items[0].sources[0].name,s.name);
 assert.equal((await admin.get('/api/admin/discovery/links?marketplaceId=mercadolivre')).body.total,0);
 assert.equal((await admin.mutate('post','/api/admin/discovery/links/'+linkId+'/archive',{})).status,200);assert.equal((await admin.get('/api/admin/discovery/links?status=pending')).body.total,0);assert.equal((await admin.get('/api/admin/discovery/links?status=archived')).body.total,1);
 await db.query('INSERT INTO discovery_run_events(id,run_id,kind,message) VALUES($1,$2,$3,$4)',[randomUUID(),run.body.id,'blocked','Acesso bloqueado']);assert.equal((await admin.get('/api/admin/discovery/runs/'+run.body.id+'/events')).body.total,1);
});
test('permission, XSRF, recent confirmation and strict inputs protect manual discovery',async()=>{
 const s=await source();assert.equal((await user.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{})).status,403);
 assert.equal((await admin.agent.post('/api/admin/discovery/sources/'+s.id+'/run').set('Origin','http://localhost:4200').send({})).status,403);
 assert.equal((await admin.mutate('post','/api/admin/discovery/sources/'+s.id+'/run',{schedule:true})).status,400);
 assert.equal((await admin.get('/api/admin/discovery/runs?pageSize=51')).status,400);
 assert.equal((await admin.mutate('post','/api/admin/discovery/sources/'+randomUUID()+'/run',{})).status,404);
 assert.equal((await admin.get('/api/admin/discovery/runs/'+randomUUID())).status,404);
 assert.equal((await admin.mutate('post','/api/admin/discovery/runs/'+randomUUID()+'/cancel',{})).status,404);
 assert.equal((await admin.mutate('post','/api/admin/discovery/links/'+randomUUID()+'/archive',{})).status,404);
});
