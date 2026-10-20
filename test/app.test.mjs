import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,identity,client,seedOffer,seedProduct,createApp} from './helpers.mjs';
let db,app,config,admin,a,b,offer;
before(async()=>{
  ({db}=await testDatabase());config=testConfig();app=createApp(db,config,{verifyGoogle:async t=>identity(t)});
  admin=client(app);a=client(app);b=client(app);
  await admin.login('admin');await a.login('alice');await b.login('bob');offer=await seedOffer(db);
});
after(async()=>{await db.end();});
test('migration reserva o admin e login Google reconhece o e-mail verificado',async()=>{
  const res=await admin.get('/api/auth/session');assert.equal(res.status,200);assert.equal(res.body.user.role,'admin');assert.equal(res.body.user.email,'arnaldorolimportela@gmail.com');
  const normal=await a.get('/api/auth/session');assert.equal(normal.body.user.role,'user');
  const bad=client(app);assert.equal((await bad.login('unverified')).status,403);assert.equal((await bad.login('invalid')).status,401);
});
test('XSRF rejeita token ausente, inválido, de outra sessão e origem externa',async()=>{
  assert.equal((await a.agent.post('/api/me/collections').set('Origin',config.APP_ORIGIN).send({name:'Teste'})).status,403);
  assert.equal((await a.agent.post('/api/me/collections').set('Origin',config.APP_ORIGIN).set('X-XSRF-TOKEN','invalid').send({name:'Teste'})).status,403);
  assert.equal((await a.agent.post('/api/me/collections').set('Origin',config.APP_ORIGIN).set('X-XSRF-TOKEN',b.csrf).send({name:'Teste'})).status,403);
  assert.equal((await a.agent.post('/api/me/collections').set('Origin','https://evil.example').set('X-XSRF-TOKEN',a.csrf).send({name:'Teste'})).status,403);
});
test('login regenera sessão e logout invalida sessão autenticada',async()=>{
  const c=client(app);await c.init();const before=c.csrf;await c.login('carol');assert.notEqual(before,c.csrf);
  assert.equal((await c.mutate('post','/api/auth/logout')).status,200);assert.equal((await c.get('/api/me/favorites')).status,401);
});
test('rotas admin bloqueiam usuários comuns e visitantes',async()=>{
  assert.equal((await a.get('/api/admin/stats')).status,403);const visitor=client(app);await visitor.init();assert.equal((await visitor.get('/api/admin/stats')).status,401);
  assert.equal((await a.mutate('put','/api/admin/marketplaces/amazon',{enabled:true,credentials:{}})).status,403);
});
test('vitrine inclui somente publicadas e disponíveis, com busca e preço máximo',async()=>{
  const pending=await seedOffer(db,{status:'pending'}),expired=await seedOffer(db,{availability:'unavailable',expires:new Date(Date.now()-1000)});
  const res=await a.get('/api/offers?q=Monitor&maxPrice=100000');assert.equal(res.status,200);assert.ok(res.body.items.some(o=>o.id===offer));assert.ok(!res.body.items.some(o=>o.id===pending||o.id===expired));
  assert.equal((await a.get('/api/offers/'+pending)).status,404);assert.equal((await a.get('/api/offers?maxPrice=-1')).status,400);
  assert.equal((await a.get('/api/offers?q='+encodeURIComponent("' OR 1=1 --"))).body.total,0);
});
test('favoritos são idempotentes e privados',async()=>{
  assert.equal((await a.mutate('put','/api/me/favorites/'+offer)).status,200);assert.equal((await a.mutate('put','/api/me/favorites/'+offer)).status,200);
  assert.equal((await a.get('/api/me/favorites')).body.length,1);assert.equal((await b.get('/api/me/favorites')).body.length,0);
  await a.mutate('delete','/api/me/favorites/'+offer);assert.equal((await a.get('/api/me/favorites')).body.length,0);
});
test('catálogos CRUD bloqueiam acesso e alteração por outro usuário',async()=>{
  const r=await a.mutate('post','/api/me/collections',{name:'Meu escritório',description:'Plano pessoal'});assert.equal(r.status,201);const id=r.body.id;
  assert.equal((await a.mutate('put',`/api/me/collections/${id}/items/${offer}`)).status,200);
  assert.equal((await a.get('/api/me/collections/'+id)).body.items.length,1);
  assert.equal((await b.get('/api/me/collections/'+id)).status,404);
  assert.equal((await b.mutate('patch','/api/me/collections/'+id,{name:'Invadido'})).status,404);
  assert.equal((await b.mutate('put',`/api/me/collections/${id}/items/${offer}`)).status,404);
  assert.equal((await b.mutate('delete','/api/me/collections/'+id)).status,404);
  await a.mutate('patch','/api/me/collections/'+id,{name:'Novo nome',description:''});assert.equal((await a.get('/api/me/collections/'+id)).body.name,'Novo nome');
  await a.mutate('delete',`/api/me/collections/${id}/items/${offer}`);assert.equal((await a.get('/api/me/collections/'+id)).body.items.length,0);
  await a.mutate('delete','/api/me/collections/'+id);assert.equal((await a.get('/api/me/collections/'+id)).status,404);
});
test('filtros salvos persistem critérios, sem compartilhamento entre contas',async()=>{
  const r=await a.mutate('post','/api/me/filters',{name:'Monitores',filters:{q:'monitor',marketplace:'amazon',maxPrice:100000,category:'Tecnologia',sort:'price_asc'}});assert.equal(r.status,201);
  assert.equal((await a.get('/api/me/filters')).body[0].filters.maxPrice,100000);assert.equal((await b.get('/api/me/filters')).body.length,0);
  await b.mutate('delete','/api/me/filters/'+r.body.id);assert.equal((await a.get('/api/me/filters')).body.length,1);
  await a.mutate('delete','/api/me/filters/'+r.body.id);assert.equal((await a.get('/api/me/filters')).body.length,0);
});

test('oferta manual passa por revisão, rejeita URL externa e gera métricas anônimas',async()=>{
  const body={productId:await seedProduct(db,{category:'Casa'}),marketplaceId:'mercadolivre',externalId:'MLB12345',title:'Produto autorizado',category:'Casa',productUrl:'https://www.mercadolivre.com.br/produto',affiliateUrl:'https://www.mercadolivre.com.br/sec/exemplo',imageUrl:null,priceCents:19990,originalPriceCents:29990,expiresAt:new Date(Date.now()+3600000).toISOString(),authorizedContent:true};
  assert.equal((await admin.mutate('post','/api/admin/offers',body)).status,404);
  const id=await seedOffer(db,{marketplace:'mercadolivre',title:body.title,status:'pending',price:body.priceCents,affiliate:body.affiliateUrl,productId:body.productId});const r={body:(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0]};assert.equal((await a.get('/api/offers/'+id)).status,404);
  assert.equal((await admin.mutate('post',`/api/admin/offers/${id}/review`,{action:'publish',expectedUpdatedAt:r.body.updated_at.toISOString()})).status,200);assert.equal((await a.get('/api/offers/'+id)).status,200);
  assert.equal((await a.mutate('post',`/api/offers/${id}/click`,{placement:'detail',userId:'ignored'})).status,200);
  const click=(await db.query('SELECT * FROM click_events WHERE offer_id=$1',[id])).rows[0];assert.ok(!('user_id'in click));assert.ok(!('session_id'in click));
  const stats=await admin.get('/api/admin/stats');assert.equal(stats.status,200);assert.equal(stats.body.totalClicks,1);
  await admin.mutate('post',`/api/admin/offers/${id}/review`,{action:'expire'});assert.equal((await a.mutate('post',`/api/offers/${id}/click`,{placement:'detail'})).status,410);
  const renewed=await admin.mutate('patch',`/api/admin/offers/${id}`,{title:body.title,category:body.category,priceCents:18990,originalPriceCents:29990,expiresAt:new Date(Date.now()+86400000).toISOString()});assert.equal(renewed.status,200);
  const current=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];assert.equal(current.status,'pending');assert.equal(current.price_cents,18990);
  assert.equal((await admin.mutate('post',`/api/admin/offers/${id}/review`,{action:'publish',expectedUpdatedAt:current.updated_at.toISOString()})).status,200);
});


test('publicação exige revisar a versão atual sem consultar conector',async()=>{
 const id=await seedOffer(db,{source:'api',status:'pending'});const row=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];
 assert.equal((await admin.mutate('post',`/api/admin/offers/${id}/review`,{action:'publish',expectedUpdatedAt:new Date(0).toISOString()})).status,409);
 assert.equal((await admin.mutate('post',`/api/admin/offers/${id}/review`,{action:'publish',expectedUpdatedAt:row.updated_at.toISOString()})).status,200);
 assert.equal((await db.query('SELECT price_cents FROM offers WHERE id=$1',[id])).rows[0].price_cents,row.price_cents);
});

test('excluir conta remove dados pessoais e invalida a sessão',async()=>{
  const c=client(app);await c.login('delete-me');await c.mutate('put','/api/me/favorites/'+offer);await c.mutate('post','/api/me/collections',{name:'Privado'});
  assert.equal((await c.mutate('delete','/api/me/account')).status,200);assert.equal((await c.get('/api/me/collections')).status,401);assert.equal((await db.query("SELECT id FROM users WHERE email='delete-me@gmail.com'")).rows.length,0);
});
