import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {testDatabase,testConfig,client,createApp,identity} from './helpers.mjs';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const config=testConfig();const app=createApp(db,config,{verifyGoogle:async token=>{const [name,nonce]=token.split(':');return {...identity(name),nonce};}});const admin=client(app);await admin.login('admin');return {db,app,config,admin};}
test('sessão antiga mantém navegação mas exige desafio Google em alterações sensíveis',async t=>{
 const {db,admin}=await fixture(t);
 await db.query("UPDATE sessions SET admin_verified_at=clock_timestamp()-interval '16 minutes' WHERE user_id IS NOT NULL");
 assert.equal((await admin.get('/api/admin/users')).status,200);
 const blocked=await admin.mutate('post','/api/admin/access-profiles',{name:'Segurança',permissions:[]});assert.equal(blocked.status,403);assert.equal(blocked.body.code,'ADMIN_REAUTH_REQUIRED');
 assert.equal((await admin.mutate('post','/api/admin/ACCESS-PROFILES',{name:'Tentativa com maiúsculas',permissions:[]})).body.code,'ADMIN_REAUTH_REQUIRED');
 const challenge=await admin.mutate('post','/api/auth/reauth/challenge');assert.equal(challenge.status,200);
 assert.equal((await admin.mutate('post','/api/auth/reauth',{credential:'admin'})).status,403);
 assert.equal((await admin.mutate('post','/api/auth/reauth',{credential:'other:'+challenge.body.nonce})).status,403);
 assert.equal((await admin.mutate('post','/api/auth/reauth',{credential:'admin:'+challenge.body.nonce})).status,200);
 assert.equal((await admin.mutate('post','/api/auth/reauth',{credential:'admin:'+challenge.body.nonce})).status,403);
 assert.equal((await admin.mutate('post','/api/admin/access-profiles',{name:'Segurança',permissions:[]})).status,201);
});
test('desafio expira e login automático não confirma acesso administrativo',async t=>{
 const {db,admin}=await fixture(t);await admin.mutate('post','/api/auth/google',{credential:'admin',automatic:true});
 const r=await admin.mutate('put','/api/admin/catalog-marketplaces/amazon',{});assert.equal(r.body.code,'ADMIN_REAUTH_REQUIRED');
 const c=await admin.mutate('post','/api/auth/reauth/challenge');await db.query("UPDATE sessions SET reauth_nonce_expires_at=clock_timestamp()-interval '1 second'");
 assert.equal((await admin.mutate('post','/api/auth/reauth',{credential:'admin:'+c.body.nonce})).status,403);
 assert.equal((await admin.agent.post('/api/auth/reauth/challenge').send({})).status,403);
});
test('Swagger e OpenAPI em produção exigem administrador, inclusive assets',async t=>{
 const {db,config,admin}=await fixture(t);const user=client(createApp(db,config,{verifyGoogle:async token=>identity(token)}));const login=await user.login('alice');
 const prod=createApp(db,{...config,NODE_ENV:'production'});
 // Use cookies already issued by the test app; production correctly requires Secure on new cookies.
 const fresh=await admin.login('admin');const cookies=fresh.headers['set-cookie'].map(c=>c.split(';')[0]);
 const userCookies=login.headers['set-cookie'].map(c=>c.split(';')[0]);
 for(const path of ['/api/openapi.json','/api/docs/','/api/docs/swagger-ui-init.js','/api/docs/xsrf.js']){
  assert.equal((await request(prod).get(path)).status,401,path);
  assert.equal((await request(prod).get(path).set('Cookie',userCookies)).status,403,path);
  assert.equal((await request(prod).get(path).set('Cookie',cookies)).status,200,path);
 }
});
