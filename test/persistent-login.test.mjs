import request from 'supertest';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,client,createApp,identity} from './helpers.mjs';
import {newSession,AUTH_SESSION_MS,hash} from '../dist/security.js';
const cookie=(res,name)=>res.headers['set-cookie']?.find(c=>c.startsWith(name+'='));
async function fixture(t,options={}){const {db}=await testDatabase();t.after(()=>db.end());const config=testConfig(),app=createApp(db,config,{verifyGoogle:async token=>identity(token),...options}),user=client(app);return {db,config,app,user};}

test('sessão autenticada dura 30 dias com cookies persistentes e atributos de segurança',async t=>{
 const {db,user,config}=await fixture(t);const res=await user.login('alice');assert.equal(res.status,200);
 for(const name of ['espertinho.sid','XSRF-TOKEN']){const c=cookie(res,name);assert.match(c,/Max-Age=2592000/);assert.match(c,/Path=\//);assert.match(c,/SameSite=Lax/);}
 assert.match(cookie(res,'espertinho.sid'),/HttpOnly/);assert.doesNotMatch(cookie(res,'XSRF-TOKEN'),/HttpOnly/);
 const row=(await db.query("SELECT extract(epoch FROM (expires_at-clock_timestamp())) AS ttl FROM sessions WHERE user_id IS NOT NULL")).rows[0];assert.ok(Number(row.ttl)>30*86400-10&&Number(row.ttl)<=30*86400);
 const saved=[];await newSession(db,{cookie:(name,value,opts)=>saved.push({name,opts})},{...config,NODE_ENV:'production'},res.body.user.id);assert.ok(saved.every(c=>c.opts.secure&&c.opts.sameSite==='lax'&&c.opts.maxAge===AUTH_SESSION_MS));
});

test('sessões antigas de 12h migram durante o uso; renovação não troca SID/XSRF nem regrava em cada consulta',async t=>{
 const {db,user}=await fixture(t);const login=await user.login('alice'),sid=cookie(login,'espertinho.sid').split(';')[0],csrf=user.csrf;const sessionId=hash(sid.split('=')[1]);
 await db.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '12 hours' WHERE id=$1",[sessionId]);
 const renewed=await user.get('/api/me/favorites');assert.equal(renewed.status,200);assert.equal(cookie(renewed,'espertinho.sid').split(';')[0],sid);assert.equal(cookie(renewed,'XSRF-TOKEN').split(';')[0],'XSRF-TOKEN='+csrf);assert.match(renewed.headers['cache-control'],/no-store/);
 assert.ok(Number((await db.query('SELECT extract(epoch FROM (expires_at-clock_timestamp())) AS ttl FROM sessions WHERE id=$1',[sessionId])).rows[0].ttl)>30*86400-10);
 assert.equal((await user.get('/api/auth/session')).headers['set-cookie'],undefined);assert.equal(user.csrf,csrf);assert.equal((await user.mutate('post','/api/me/collections',{name:'Após renovar'})).status,201);
});

test('sessão expirada não é renovada; Google validado pode restaurar o acesso automaticamente',async t=>{
 const {db,user}=await fixture(t);await user.login('alice');await db.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id IS NOT NULL");
 assert.equal((await user.get('/api/me/favorites')).status,401);const anon=await user.init();assert.equal(anon.body.user,null);assert.equal(anon.body.autoSignInAllowed,true);
 const res=await user.mutate('post','/api/auth/google',{credential:'alice',automatic:true});assert.equal(res.status,200);assert.equal(res.body.user.email,'alice@gmail.com');assert.match(cookie(res,'espertinho.sid'),/Max-Age=2592000/);
});

test('sair revoga sessão, mantém navegação anônima e bloqueia login automático até nova entrada manual',async t=>{
 const {db,user}=await fixture(t);await user.login('alice');const logout=await user.mutate('post','/api/auth/logout');assert.equal(logout.status,200);assert.match(cookie(logout,'espertinho.signed_out'),/HttpOnly/);assert.match(cookie(logout,'espertinho.signed_out'),/Max-Age=2592000/);assert.equal((await db.query('SELECT * FROM sessions WHERE user_id IS NOT NULL')).rows.length,0);
 const session=await user.init();assert.equal(session.body.user,null);assert.equal(session.body.autoSignInAllowed,false);assert.match(cookie(logout,'espertinho.sid'),/Max-Age=43200/);
 assert.equal((await user.mutate('post','/api/auth/google',{credential:'alice',automatic:true})).status,409);assert.equal((await user.get('/api/me/favorites')).status,401);
 assert.equal((await user.agent.post('/api/auth/google').send({credential:'alice'})).status,403);
 const manual=await user.mutate('post','/api/auth/google',{credential:'alice'});assert.equal(manual.status,200);assert.match(cookie(manual,'espertinho.signed_out'),/Expires=Thu, 01 Jan 1970/);assert.equal((await user.init()).body.autoSignInAllowed,true);
});

test('retorno tardio do Google não ressuscita sessão revogada durante a validação do token',async t=>{
 let release,reached;const wait=new Promise(resolve=>release=resolve),started=new Promise(resolve=>reached=resolve);
 const {db,user}=await fixture(t,{verifyGoogle:async token=>{reached();await wait;return identity(token);}});await user.init();
 const pending=user.mutate('post','/api/auth/google',{credential:'alice',automatic:true});await started;await db.query('DELETE FROM sessions');release();const response=await pending;assert.equal(response.status,409);assert.equal((await db.query('SELECT * FROM sessions WHERE user_id IS NOT NULL')).rows.length,0);
});

test('excluir conta também bloqueia restauração automática e não recria o usuário',async t=>{
 const {db,user}=await fixture(t);await user.login('alice');assert.equal((await user.mutate('delete','/api/me/account')).status,200);assert.equal((await user.init()).body.autoSignInAllowed,false);assert.equal((await user.mutate('post','/api/auth/google',{credential:'alice',automatic:true})).status,409);assert.equal((await db.query("SELECT id FROM users WHERE email='alice@gmail.com'")).rows.length,0);
});


test('cookie de saída prevalece sobre sessão de resposta automática tardia em outra aba',async t=>{
 const {db,user,app,config}=await fixture(t);const login=await user.login('alice');await user.mutate('post','/api/auth/logout');
 const cookies=[];await newSession(db,{cookie:(name,value)=>cookies.push(name+'='+value)},config,login.body.user.id);
 const late=await request(app).get('/api/auth/session').set('Cookie',[...cookies,'espertinho.signed_out=1']);assert.equal(late.status,200);assert.equal(late.body.user,null);assert.equal(late.body.autoSignInAllowed,false);assert.equal((await db.query('SELECT * FROM sessions WHERE user_id IS NOT NULL')).rows.length,0);
});
