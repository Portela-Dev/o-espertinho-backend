import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import request from 'supertest';
import {testDatabase,testConfig,client,createApp,identity} from './helpers.mjs';
const extensionId='a'.repeat(32),base='http://localhost:3000';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)});const browser=client(app);await browser.login('admin');
 const post=(path,body,token)=>request(app).post('/api/extension'+path).set('Origin','chrome-extension://'+extensionId).set('X-Espertinho-Extension-Id',extensionId).set('Authorization',token?'Bearer '+token:'').send(body);
 const get=(path,token)=>request(app).get('/api/extension'+path).set('X-Espertinho-Extension-Id',extensionId).set('Authorization',token?'Bearer '+token:'');
 const start=async()=>{const verifier=randomBytes(32).toString('hex');const r=await post('/auth/start',{challenge:digest(verifier)});assert.equal(r.status,200);return {...r.body,verifier};};
 const approve=(pair,person=browser)=>person.agent.post('/api/extension/auth/approve').set('Origin',base).set('X-XSRF-TOKEN',person.csrf).send({code:pair.deviceCode});
 const login=async()=>{const pair=await start();assert.equal((await approve(pair)).status,200);const r=await post('/auth/poll',{deviceCode:pair.deviceCode,verifier:pair.verifier});assert.equal(r.status,200);return r.body;};
 return {db,app,browser,post,get,start,approve,login};
}
test('pareamento exige sessão real, XSRF, permissão e prova de posse de uso único',async t=>{
 const {app,browser,post,get,start,approve}=await fixture(t);const pair=await start();
 assert.equal((await get('/config')).status,401);
 assert.equal((await request(app).post('/api/extension/auth/approve').set('Origin',base).send({code:pair.deviceCode})).status,403);
 const alice=client(app);await alice.login('alice');assert.equal((await approve(pair,alice)).status,403);
 assert.equal((await post('/auth/poll',{deviceCode:pair.deviceCode,verifier:pair.verifier})).status,202);
 assert.equal((await post('/auth/poll',{deviceCode:pair.deviceCode,verifier:'0'.repeat(64)})).status,403);
 assert.equal((await approve(pair,browser)).status,200);
 const results=await Promise.all([post('/auth/poll',{deviceCode:pair.deviceCode,verifier:pair.verifier}),post('/auth/poll',{deviceCode:pair.deviceCode,verifier:pair.verifier})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);const token=results.find(r=>r.status===200).body.token;
 assert.equal((await get('/session',token)).body.user.permissions.includes('affiliate_links'),true);
 assert.equal((await request(app).get('/api/extension/session').set('X-Espertinho-Extension-Id','b'.repeat(32)).set('Authorization','Bearer '+token)).status,401);
});
test('perfil delegado pode conectar; remoção da permissão revoga o acesso imediatamente',async t=>{
 const {app,db,browser,start,approve,post,get}=await fixture(t);const alice=client(app);const logged=await alice.login('alice');
 const profile=await browser.mutate('post','/api/admin/access-profiles',{name:'Operador de links',permissions:['affiliate_links']});assert.equal(profile.status,201);
 await db.query('UPDATE users SET access_profile_id=$2 WHERE id=$1',[logged.body.user.id,profile.body.id]);
 const pair=await start();assert.equal((await approve(pair,alice)).status,200);const session=await post('/auth/poll',{deviceCode:pair.deviceCode,verifier:pair.verifier});
 assert.equal((await get('/config',session.body.token)).status,200);
 await db.query("UPDATE access_profiles SET permissions='{}' WHERE id=$1",[profile.body.id]);
 assert.equal((await get('/config',session.body.token)).status,403);
 assert.equal((await post('/auth/refresh',{refreshToken:session.body.refreshToken})).status,403);
});
test('lotes são reservados, resultados idempotentes e nenhum produto real é criado',async t=>{
 const {db,post,get,login}=await fixture(t),auth=await login(),config=await get('/config',auth.token);assert.equal(config.body.mock,true);
 const a=await post('/batches/claim',{marketplaceId:'demo'},auth.token),b=await post('/batches/claim',{marketplaceId:'demo'},auth.token);
 assert.equal(a.body.items.length,2);assert.ok(!b.body.items.some(i=>a.body.items.some(j=>j.id===i.id)));
 const results=a.body.items.map(item=>({id:item.id,affiliateUrl:item.originalUrl+'?affiliate=demo'}));
 assert.equal((await post('/batches/results',{leaseId:b.body.leaseId,results},auth.token)).status,409);
 assert.equal((await post('/batches/results',{leaseId:a.body.leaseId,results:[{...results[0],affiliateUrl:'https://evil.test/'}]},auth.token)).status,400);
 for(let i=0;i<2;i++)assert.equal((await post('/batches/results',{leaseId:a.body.leaseId,results},auth.token)).status,200);
 assert.equal((await get('/queue',auth.token)).body.items.filter(i=>i.state==='done').length,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM offers')).rows[0].n,0);
});
test('renovação gira o token; logout e saída do site invalidam a extensão',async t=>{
 const {browser,post,get,login}=await fixture(t),old=await login();
 const renewed=await post('/auth/refresh',{refreshToken:old.refreshToken});assert.equal(renewed.status,200);
 assert.equal((await post('/auth/refresh',{refreshToken:old.refreshToken})).status,401);
 assert.equal((await get('/session',old.token)).status,401);
 assert.equal((await get('/session',renewed.body.token)).status,200);
 assert.equal((await post('/auth/logout',{},renewed.body.token)).status,200);
 assert.equal((await get('/session',renewed.body.token)).status,401);
 const auth=await login();await browser.mutate('post','/api/auth/logout');assert.equal((await get('/session',auth.token)).status,401);
});
test('mocks ficam desativados em produção e podem ser desligados em desenvolvimento',async t=>{
 const {db}=await fixture(t);
 for(const config of [{...testConfig(),NODE_ENV:'production'},{...testConfig(),EXTENSION_MOCK_ENABLED:'false'}]){
  const app=createApp(db,config);assert.equal((await request(app).get('/api/extension/config')).status,404);
 }
});
