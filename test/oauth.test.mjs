import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createHash} from 'node:crypto';
import {testDatabase,testConfig,identity,client,createApp} from './helpers.mjs';
import {ProviderService} from '../dist/providers.js';
import {decrypt} from '../dist/security.js';
let db,config,app,admin,calls=[],mode='ok';
const startPath='/api/admin/mercadolivre/oauth/start',complete='/api/admin/mercadolivre/oauth/complete';
const provider=new ProviderService(async(url,o)=>{
  calls.push({url,body:new URLSearchParams(o.body)});
  if(mode==='error')return new Response(JSON.stringify({error:'never-expose-secret'}),{status:400});
  return new Response(JSON.stringify({access_token:'private-access',refresh_token:mode==='missing'?undefined:'private-refresh',expires_in:21600}),{status:200});
});
const save=()=>admin.mutate('put','/api/admin/marketplaces/mercadolivre',{enabled:true,credentials:{clientId:'123456',clientSecret:'private-secret'}});
const start=async()=>{const res=await admin.mutate('post',startPath);assert.equal(res.status,200);return new URL(res.body.url);};
const callback=state=>complete+'?state='+state+'&code=one-time-code';
before(async()=>{({db}=await testDatabase());config={...testConfig(),MELI_REDIRECT_URI:'https://tunnel.example/api/admin/mercadolivre/callback',MELI_OAUTH_PKCE:'false'};app=createApp(db,config,{providers:provider,verifyGoogle:async t=>identity(t)});admin=client(app);await admin.login('admin');});
after(async()=>db.end());
test('OAuth exige admin e XSRF; duas credenciais bastam e token manual não é aceito',async()=>{
  const visitor=client(app);await visitor.init();assert.equal((await visitor.mutate('post',startPath)).status,401);
  await visitor.login('alice');assert.equal((await visitor.mutate('post',startPath)).status,403);
  assert.equal((await admin.agent.post(startPath).set('Origin',config.APP_ORIGIN).send({})).status,403);
  assert.equal((await admin.mutate('post',startPath)).status,400);
  assert.equal((await save()).status,200);
  const list=await admin.get('/api/admin/marketplaces'),m=list.body.find(x=>x.id==='mercadolivre');assert.equal(m.oauthConnected,false);assert.equal(m.oauthReady,true);assert.equal(m.fields.length,2);
  assert.equal((await admin.mutate('post','/api/admin/marketplaces/mercadolivre/test')).status,409);
});
test('ponte HTTPS retorna ao localhost; troca código, criptografa tokens e rejeita replay',async()=>{
  const url=await start(),state=url.searchParams.get('state');assert.equal(url.origin,'https://auth.mercadolivre.com.br');assert.equal(url.searchParams.get('client_id'),'123456');assert.equal(url.searchParams.get('redirect_uri'),config.MELI_REDIRECT_URI);assert.equal(url.searchParams.has('client_secret'),false);
  const bridge=await request(app).get('/api/admin/mercadolivre/callback?state='+state+'&code=one-time-code');assert.equal(bridge.status,303);assert.equal(bridge.headers['referrer-policy'],'no-referrer');assert.equal(new URL(bridge.headers.location).origin,config.APP_ORIGIN);
  const res=await admin.get(new URL(bridge.headers.location).pathname+new URL(bridge.headers.location).search);assert.equal(res.status,303);assert.ok(res.headers.location.endsWith('meli_oauth=success'));
  assert.equal(calls.at(-1).body.get('grant_type'),'authorization_code');assert.equal(calls.at(-1).body.get('redirect_uri'),config.MELI_REDIRECT_URI);
  const row=(await db.query("SELECT * FROM marketplaces WHERE id='mercadolivre'")).rows[0];assert.ok(!row.credentials_encrypted.includes('private-refresh'));const c=decrypt(row.credentials_encrypted,config.ENCRYPTION_KEY);assert.equal(c.refreshToken,'private-refresh');assert.equal(c.accessToken,'private-access');assert.ok(Number(c.accessTokenExpiresAt)>Date.now());
  const list=await admin.get('/api/admin/marketplaces');assert.equal(list.body.find(x=>x.id==='mercadolivre').oauthConnected,true);assert.ok(!list.text.includes('private-'));
  const count=calls.length;assert.ok((await admin.get(callback(state))).headers.location.endsWith('meli_oauth=invalid'));assert.equal(calls.length,count);
});
test('state bloqueia outra sessão, alteração, expiração e credenciais substituídas',async()=>{
  const state=(await start()).searchParams.get('state'),other=client(app);await other.login('admin');const count=calls.length;
  assert.ok((await other.get(callback(state))).headers.location.endsWith('meli_oauth=invalid'));
  assert.ok((await admin.get(callback('a'.repeat(64)))).headers.location.endsWith('meli_oauth=invalid'));assert.equal(calls.length,count);
  await db.query('UPDATE marketplace_oauth_states SET expires_at=$1',[new Date(Date.now()-1000)]);assert.ok((await admin.get(callback(state))).headers.location.endsWith('meli_oauth=invalid'));
  const next=(await start()).searchParams.get('state');await admin.mutate('put','/api/admin/marketplaces/mercadolivre',{enabled:true,credentials:{clientSecret:'new-secret'}});assert.ok((await admin.get(callback(next))).headers.location.endsWith('meli_oauth=failed'));assert.equal(calls.length,count);
  const m=(await admin.get('/api/admin/marketplaces')).body.find(x=>x.id==='mercadolivre');assert.equal(m.oauthConnected,false);await save();
});
test('cancelamento e falhas externas não apagam autorização anterior nem vazam erro remoto',async()=>{
  let state=(await start()).searchParams.get('state');assert.ok((await admin.get(callback(state))).headers.location.endsWith('success'));const original=(await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre'")).rows[0].credentials_encrypted;
  state=(await start()).searchParams.get('state');assert.ok((await admin.get(complete+'?state='+state+'&error=access_denied')).headers.location.endsWith('denied'));
  for(const value of ['error','missing']){mode=value;state=(await start()).searchParams.get('state');const res=await admin.get(callback(state));assert.ok(res.headers.location.endsWith('failed'));assert.ok(!res.text.includes('never-expose-secret'));assert.equal((await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre'")).rows[0].credentials_encrypted,original);}mode='ok';
});
test('PKCE S256 usa verificador protegido; URI insegura é recusada',async()=>{
  config.MELI_OAUTH_PKCE='true';const url=await start();assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=url.searchParams.get('state');assert.ok((await admin.get(callback(state))).headers.location.endsWith('success'));const verifier=calls.at(-1).body.get('code_verifier');assert.ok(verifier.length>=43);assert.equal(createHash('sha256').update(verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  config.MELI_REDIRECT_URI='http://localhost:3000/api/admin/mercadolivre/callback';assert.equal((await admin.mutate('post',startPath)).status,400);config.MELI_REDIRECT_URI='https://tunnel.example/api/admin/mercadolivre/callback';
});
test('renovação persiste no banco mesmo se a consulta falhar e reutiliza access token válido',async()=>{
  const before=(await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre'")).rows[0].credentials_encrypted;
  const secrets=decrypt(before,config.ENCRYPTION_KEY);secrets.accessTokenExpiresAt='0';
  const {encrypt}=await import('../dist/security.js');await db.query("UPDATE marketplaces SET credentials_encrypted=$1 WHERE id='mercadolivre'",[encrypt(secrets,config.ENCRYPTION_KEY)]);
  let refreshes=0;
  const rotating=new ProviderService(async url=>{if(url.endsWith('/oauth/token')){refreshes++;return new Response(JSON.stringify({access_token:'renewed-access',refresh_token:'renewed-refresh',expires_in:21600}),{status:200});}return new Response('{}',{status:403});});
  const isolated=createApp(db,config,{providers:rotating,verifyGoogle:async t=>identity(t)}),c=client(isolated);await c.login('admin');
  assert.equal((await c.mutate('post','/api/admin/marketplaces/mercadolivre/test')).status,502);
  const saved=decrypt((await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre'")).rows[0].credentials_encrypted,config.ENCRYPTION_KEY);assert.equal(saved.refreshToken,'renewed-refresh');
  assert.equal((await c.mutate('post','/api/admin/marketplaces/mercadolivre/test')).status,502);assert.equal(refreshes,1);
});
test('remoção de chaves invalida autorização em andamento',async()=>{
  const state=(await start()).searchParams.get('state'),count=calls.length;await admin.mutate('delete','/api/admin/marketplaces/mercadolivre/credentials');assert.ok((await admin.get(callback(state))).headers.location.endsWith('failed'));assert.equal(calls.length,count);
});
