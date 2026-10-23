import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,createApp,client,identity} from './helpers.mjs';

test('sharing defaults, permissions, persistence, public filtering and optimistic locking',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:identity});
 const anon=client(app),admin=client(app),user=client(app);await admin.login('admin');await user.login('reader');
 const initial=await anon.get('/api/sharing');assert.equal(initial.status,200);assert.equal(initial.body.channels.length,6);assert.equal(initial.body.version,undefined);
 assert.ok(initial.body.channels.every(c=>c.logoUrl.startsWith('/brand/social/')&&c.textTemplate));
 assert.equal((await anon.get('/api/admin/sharing')).status,401);
 assert.equal((await user.get('/api/admin/sharing')).status,403);
 const settings=(await admin.get('/api/admin/sharing')).body;
 assert.equal((await user.mutate('put','/api/admin/sharing',settings)).status,403);
 settings.channels[0].textTemplate='Confira {titulo}: {preco} em {loja}. {url}';settings.channels[1].enabled=false;
 const saved=await admin.mutate('put','/api/admin/sharing',settings);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.version,settings.version+1);
 const publicSettings=(await anon.get('/api/sharing')).body;assert.equal(publicSettings.channels.length,5);assert.ok(!publicSettings.channels.some(c=>c.id==='telegram'));assert.equal(publicSettings.channels[0].textTemplate,settings.channels[0].textTemplate);
 assert.equal((await admin.mutate('put','/api/admin/sharing',settings)).status,409);
 const disabled=await admin.mutate('put','/api/admin/sharing',{...saved.body,enabled:false});assert.equal(disabled.status,200);assert.deepEqual((await anon.get('/api/sharing')).body,{enabled:false,channels:[]});
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE action='sharing.updated'")).rows[0].n,2);
});

test('sharing rejects unsafe templates and duplicate ids; catalog profile needs recent authentication to write',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:identity});const admin=client(app),editor=client(app);await admin.login('admin');await editor.login('editor-sharing');
 await db.query("INSERT INTO access_profiles(id,name,permissions) VALUES('sharing-editor','Sharing editor',ARRAY['catalog'])");
 await db.query("UPDATE users SET access_profile_id='sharing-editor' WHERE email='editor-sharing@gmail.com'");
 const config=(await editor.get('/api/admin/sharing')).body;assert.equal(config.channels.length,6);
 for(const change of [{urlTemplate:'javascript:alert(1)'},{urlTemplate:'https://example.com/?url={segredo}'},{logoUrl:'data:image/svg+xml,<svg/>'},{textTemplate:'token {segredo}'}]){
  const invalid={...config,channels:[{...config.channels[0],...change}]};assert.equal((await admin.mutate('put','/api/admin/sharing',invalid)).status,400,JSON.stringify(change));
 }
 assert.equal((await admin.mutate('put','/api/admin/sharing',{...config,channels:[config.channels[0],config.channels[0]]})).status,400);
 await db.query("UPDATE sessions SET admin_verified_at=now()-interval '1 hour' WHERE user_id=(SELECT id FROM users WHERE email='editor-sharing@gmail.com')");
 const expired=await editor.mutate('put','/api/admin/sharing',config);assert.equal(expired.status,403);assert.equal(expired.body.code,'ADMIN_REAUTH_REQUIRED');
});
