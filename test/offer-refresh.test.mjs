import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,identity,client,seedOffer,seedProduct,createApp} from './helpers.mjs';
import {tickOfferRefresh,startOfferRefresh} from '../dist/offer-refresh.js';
import {workerTick} from '../dist/offers.js';
import {startWorker} from '../dist/worker-runtime.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {HttpError} from '../dist/security.js';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const config=testConfig(),app=createApp(db,config,{verifyGoogle:async token=>identity(token)}),admin=client(app),user=client(app);await admin.login('admin');await user.login('alice');const adminId=(await admin.get('/api/auth/session')).body.user.id;return {db,config,app,admin,user,adminId};}
const row=async(db,id)=>(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];
const runRow=async(db,id)=>(await db.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[id])).rows[0];
const due=async db=>db.query("UPDATE offer_refresh_runs SET next_item_at=now()-interval '1 minute' WHERE status IN ('queued','running')");
const extracted=(o,price=15000)=>({title:o.title,externalId:o.external_id,priceCents:price,originalPriceCents:20000,description:'Descrição',category:'Tecnologia',conditions:'Condições atualizadas',productUrl:o.product_url,images:[],specifications:[],warnings:[],missing:price===null?['price']:[],evidence:[],collectedAt:new Date().toISOString()});

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

test('atualiza preço automaticamente mantendo aprovação, produto, link e histórico de data',async t=>{
 const {db,config,adminId,user}=await fixture(t);const id=await seedOffer(db,{source:'scraped',price:32100}),o=await row(db,id),before=new Date('2020-01-01');await db.query('UPDATE offers SET data_updated_at=$2 WHERE id=$1',[id,before]);
 const run=await startOfferRefresh(db,adminId);let calls=0;await tickOfferRefresh(db,config,{}, {extract:async url=>{calls++;assert.equal(url,o.affiliate_url);return extracted(o,45000);}});
 const result=await row(db,id);assert.equal(calls,1);assert.equal(result.price_cents,45000);assert.equal(result.status,'published');assert.equal(result.refresh_status,'updated');assert.equal(result.availability_status,'available');assert.ok(result.data_updated_at>before);assert.equal(result.affiliate_url,o.affiliate_url);assert.equal(result.product_id,o.product_id);
 assert.equal((await user.get('/api/products/'+o.product_id)).body.min_price_cents,45000);assert.equal((await runRow(db,run.id)).status,'completed');
 // Unchanged price is also a successful data update.
 await db.query('UPDATE offers SET data_updated_at=$2 WHERE id=$1',[id,before]);await startOfferRefresh(db,adminId);await due(db);await tickOfferRefresh(db,config,{}, {extract:async()=>extracted(o,45000)});assert.ok((await row(db,id)).data_updated_at>before);
});

test('falha técnica mantém preço, data conhecida, publicação e exibição mesmo com validade antiga vencida',async t=>{
 const {db,config,adminId,user}=await fixture(t);const id=await seedOffer(db,{source:'scraped',price:32100,expires:new Date('2020-01-01')}),o=await row(db,id);await startOfferRefresh(db,adminId);
 await tickOfferRefresh(db,config,{}, {extract:async()=>{throw new HttpError(422,'O marketplace solicitou verificação de acesso.');}});
 const result=await row(db,id);assert.equal(result.price_cents,32100);assert.equal(result.status,'published');assert.equal(result.refresh_status,'pending');assert.equal(result.availability_status,'available');assert.equal(result.data_updated_at.getTime(),o.data_updated_at.getTime());assert.ok(result.last_refresh_attempt_at);assert.match(result.last_refresh_error,/verificação/);
 assert.equal((await user.get('/api/products')).body.total,1);assert.equal((await user.get('/api/offers/'+id)).status,200);assert.equal((await user.get('/api/products/'+o.product_id)).body.offers[0].refresh_status,'pending');
 await workerTick(db,config,{});assert.equal((await row(db,id)).status,'published');
});

test('página identificada sem preço fica indisponível e uma próxima rodada pode recuperar o link',async t=>{
 const {db,config,adminId,user}=await fixture(t);const p=await seedProduct(db),id=await seedOffer(db,{productId:p,source:'scraped',price:20000}),other=await seedOffer(db,{productId:p,source:'scraped',price:30000});const o=await row(db,id),b=await row(db,other);
 const service={extract:async url=>url===o.affiliate_url?extracted(o,null):extracted(b,30000)};const run=await startOfferRefresh(db,adminId);await due(db);await tickOfferRefresh(db,config,{},service);await due(db);await tickOfferRefresh(db,config,{},service);
 assert.equal((await row(db,id)).availability_status,'unavailable');let product=(await user.get('/api/products/'+p)).body;assert.equal(product.available,true);assert.equal(product.offers.length,1);assert.equal(product.min_price_cents,30000);assert.equal((await runRow(db,run.id)).unavailable,1);
 await db.query("UPDATE offers SET availability_status='unavailable' WHERE id=$1",[other]);assert.equal((await user.get('/api/products')).body.total,0);assert.equal((await user.get('/api/products/'+p)).body.available,false);
 await startOfferRefresh(db,adminId);await due(db);const recovery={extract:async url=>url===o.affiliate_url?extracted(o,18000):extracted(b,30000)};await tickOfferRefresh(db,config,{},recovery);await due(db);await tickOfferRefresh(db,config,{},recovery);product=(await user.get('/api/products/'+p)).body;assert.equal(product.offers.length,2);assert.equal(product.min_price_cents,18000);
});

test('consultas são sequenciais, respeitam pausa e falhas técnicas ampliam a espera',async t=>{
 const {db,config,adminId}=await fixture(t);const first=await seedOffer(db,{source:'scraped'}),second=await seedOffer(db,{source:'scraped'});let calls=0;const service={extract:async url=>{calls++;return extracted(await row(db,url===(await row(db,first)).affiliate_url?first:second));}};
 const run=await startOfferRefresh(db,adminId);await due(db);await tickOfferRefresh(db,config,{},service);await tickOfferRefresh(db,config,{},service);assert.equal(calls,1);assert.equal((await runRow(db,run.id)).processed,1);
 await due(db);await tickOfferRefresh(db,config,{}, {extract:async()=>{throw new Error('secret-not-to-log');}});const done=await runRow(db,run.id);assert.equal(done.pending,1);assert.ok(new Date(done.next_item_at).getTime()-Date.now()>290000);assert.ok(!JSON.stringify((await db.query('SELECT error FROM offer_refresh_items')).rows).includes('secret-not-to-log'));
});

test('agendamento só inicia quando devido, respeita desativação e preserva as janelas fixas após concluir',async t=>{
 const {db,config}=await fixture(t);const id=await seedOffer(db,{source:'scraped'}),o=await row(db,id);let calls=0;const service={extract:async()=>{calls++;return extracted(o);}};
 await tickOfferRefresh(db,config,{},service);assert.equal(calls,0);
 await db.query("UPDATE offer_refresh_settings SET enabled=false,next_run_at=now()-interval '1 hour'");await tickOfferRefresh(db,config,{},service);assert.equal(calls,0);
 await db.query('UPDATE offer_refresh_settings SET enabled=true');await tickOfferRefresh(db,config,{},service);assert.equal(calls,1);
 const run=(await db.query('SELECT * FROM offer_refresh_runs')).rows[0];assert.equal(run.trigger,'scheduled');assert.equal(run.status,'completed');const next=(await db.query('SELECT next_run_at FROM offer_refresh_settings')).rows[0].next_run_at;assert.ok(next.getTime()-Date.now()>6.9*3600000);
});

test('ignora edições e encerramentos manuais sem republicar; fila recupera processamento interrompido',async t=>{
 const {db,config,adminId}=await fixture(t);const id=await seedOffer(db,{source:'scraped'}),o=await row(db,id);let calls=0;const service={extract:async()=>{calls++;return extracted(o);}};
 const run=await startOfferRefresh(db,adminId);await db.query("UPDATE offer_refresh_items SET status='running',attempt_id=$2,lease_until=now()+interval '1 hour' WHERE run_id=$1",[run.id,randomUUID()]);await tickOfferRefresh(db,config,{},service);assert.equal(calls,0);
 await db.query("UPDATE offer_refresh_items SET lease_until=now()-interval '1 minute' WHERE run_id=$1",[run.id]);await db.query("UPDATE offers SET status='expired',updated_at=now()+interval '1 second' WHERE id=$1",[id]);await tickOfferRefresh(db,config,{},service);assert.equal(calls,0);assert.equal((await row(db,id)).status,'expired');assert.equal((await runRow(db,run.id)).skipped,1);
});

test('identificação divergente é falha técnica; API atualiza sem alterar link nem pedir nova aprovação',async t=>{
 const {db,config,adminId,admin}=await fixture(t);const id=await seedOffer(db,{source:'scraped'}),o=await row(db,id);await startOfferRefresh(db,adminId);await due(db);await tickOfferRefresh(db,config,{}, {extract:async()=>({...extracted(o),externalId:'outro-produto'})});assert.equal((await row(db,id)).refresh_status,'pending');assert.equal((await row(db,id)).availability_status,'available');
 await db.query("UPDATE offers SET status='expired' WHERE id=$1",[id]);const api=await seedOffer(db,{source:'api'}),a=await row(db,api);await admin.mutate('put','/api/admin/marketplaces/amazon',{enabled:false,credentials:{clientId:'test',clientSecret:'test',version:'3.1',partnerTag:'test-20'}});
 await startOfferRefresh(db,adminId);await due(db);await tickOfferRefresh(db,config,{refresh:async()=>({externalId:a.external_id,title:a.title,priceCents:77700,originalPriceCents:null,conditions:'API',expiresAt:new Date(Date.now()+3600000),affiliateUrl:'https://www.amazon.com.br/dp/OTHER'})});const result=await row(db,api);assert.equal(result.price_cents,77700);assert.equal(result.affiliate_url,a.affiliate_url);assert.equal(result.status,'published');
});


test('rodada manual preserva agenda; janelas vencidas durante extração são descartadas sem nova rodada',async t=>{
 const {db,config,adminId}=await fixture(t);const id=await seedOffer(db,{source:'scraped'}),o=await row(db,id);
 const next=(await db.query('SELECT next_run_at FROM offer_refresh_settings')).rows[0].next_run_at;
 const run=await startOfferRefresh(db,adminId);assert.equal((await db.query('SELECT next_run_at FROM offer_refresh_settings')).rows[0].next_run_at.getTime(),next.getTime());
 let calls=0;
 await tickOfferRefresh(db,config,{}, {extract:async()=>{
  calls++;await db.query("UPDATE offer_refresh_settings SET next_run_at=now()-interval '17 hours'");return extracted(o);
 }});
 const after=(await db.query('SELECT next_run_at FROM offer_refresh_settings')).rows[0].next_run_at;
 assert.ok(after.getTime()-Date.now()>6.9*3600000);assert.ok(after.getTime()-Date.now()<7.1*3600000);
 await tickOfferRefresh(db,config,{}, {extract:async()=>{calls++;return extracted(o);}});
 assert.equal(calls,1);assert.equal((await runRow(db,run.id)).status,'completed');assert.equal((await db.query('SELECT count(*)::int AS n FROM offer_refresh_runs')).rows[0].n,1);
});

test('janela agendada durante uma fila ativa é ignorada; salvar apenas a pausa mantém a agenda',async t=>{
 const {db,config,adminId,admin}=await fixture(t);await seedOffer(db,{source:'scraped'});const run=await startOfferRefresh(db,adminId);
 await db.query("UPDATE offer_refresh_settings SET next_run_at=now()-interval '1 hour'");
 await db.query("UPDATE offer_refresh_runs SET next_item_at=now()+interval '1 hour' WHERE id=$1",[run.id]);
 await tickOfferRefresh(db,config,{}, {extract:async()=>{assert.fail('Ainda em pausa');}});
 const s=(await admin.get('/api/admin/offer-refresh')).body.settings;assert.ok(new Date(s.next_run_at).getTime()-Date.now()>6.9*3600000);
 const saved=await admin.mutate('put','/api/admin/offer-refresh',{enabled:true,intervalHours:8,requestIntervalMs:100,expectedUpdatedAt:s.updated_at});assert.equal(saved.status,200);assert.equal(saved.body.next_run_at,s.next_run_at);assert.equal(saved.body.request_interval_ms,100);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM offer_refresh_runs')).rows[0].n,1);
});

test('worker processa pausa de 100 ms sem aguardar o ciclo de manutenção de 60 segundos',async t=>{
 const {db,config,adminId,admin}=await fixture(t);const ids=[await seedOffer(db,{source:'api'}),await seedOffer(db,{source:'api'})];
 await admin.mutate('put','/api/admin/marketplaces/amazon',{enabled:false,credentials:{clientId:'test',clientSecret:'test',version:'3.1',partnerTag:'test-20'}});
 await db.query('UPDATE offer_refresh_settings SET enabled=false,request_interval_ms=100');
 const run=await startOfferRefresh(db,adminId),times=[];
 const stop=startWorker(db,config,{refresh:async(_market,_secrets,id)=>{times.push(performance.now());return {externalId:id,priceCents:22200,originalPriceCents:null,conditions:'API',expiresAt:new Date(Date.now()+3600000)};}});
 try{
  const deadline=Date.now()+8000;while(times.length<2&&Date.now()<deadline)await sleep(20);
 }finally{await stop();}
 assert.equal(times.length,2);assert.ok(times[1]-times[0]>=95,'Pausa mínima não respeitada');assert.ok(times[1]-times[0]<2000,'Consultas aguardaram manutenção ou polling lento');
 assert.equal((await runRow(db,run.id)).status,'completed');for(const id of ids)assert.equal((await row(db,id)).price_cents,22200);
});
