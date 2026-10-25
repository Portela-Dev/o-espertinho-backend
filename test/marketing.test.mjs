import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {registerPublicMarketing} from '../dist/marketing.js';
import {testDatabase,testConfig,createApp,client,identity} from './helpers.mjs';

test('pixel settings are protected, validated, versioned and audited; development never tracks', async t => {
 const {db}=await testDatabase(); t.after(()=>db.end());
 const app=createApp(db,testConfig(),{verifyGoogle:identity});
 const anon=client(app),admin=client(app),reader=client(app);
 await admin.login('admin'); await reader.login('reader');
 assert.equal((await anon.get('/api/admin/marketing')).status,401);
 assert.equal((await reader.get('/api/admin/marketing')).status,403);
 const settings=(await admin.get('/api/admin/marketing')).body;
 assert.equal(settings.pixelId,'1918844482826551');
 assert.deepEqual((await anon.get('/api/marketing')).body,{enabled:false,pixelId:null,allowedOrigin:'http://localhost:4200'});
 for(const bad of [{pixelId:'<script>'},{pixelId:'https://facebook.com'},{version:0},{secret:'no'}]) {
  assert.equal((await admin.mutate('put','/api/admin/marketing',{...settings,...bad})).status,400);
 }
 assert.equal((await admin.agent.put('/api/admin/marketing').send(settings)).status,403);
 assert.equal((await reader.mutate('put','/api/admin/marketing',settings)).status,403);
 const saved=await admin.mutate('put','/api/admin/marketing',{...settings,enabled:false});
 assert.equal(saved.status,200); assert.equal(saved.body.version,settings.version+1);
 assert.equal((await admin.mutate('put','/api/admin/marketing',settings)).status,409);
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE action='marketing.updated'")).rows[0].n,1);
 await db.query("UPDATE sessions SET admin_verified_at=now()-interval '1 hour'");
 assert.equal((await admin.mutate('put','/api/admin/marketing',saved.body)).body.code,'ADMIN_REAUTH_REQUIRED');
});

test('public configuration exposes only the enabled production pixel and its canonical origin',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());
 const app=express(); registerPublicMarketing(app,db,{...testConfig(),NODE_ENV:'production',APP_ORIGIN:'https://oespertinho.com.br'});
 assert.deepEqual((await request(app).get('/api/marketing')).body,{enabled:true,pixelId:'1918844482826551',allowedOrigin:'https://oespertinho.com.br'});
 await db.query('UPDATE meta_pixel_settings SET enabled=false');
 assert.equal((await request(app).get('/api/marketing')).body.pixelId,null);
});

test('catalog editors can manage marketing; unrelated profiles cannot',async t=>{
 const {db}=await testDatabase(); t.after(()=>db.end());
 const app=createApp(db,testConfig(),{verifyGoogle:identity}),editor=client(app);
 await editor.login('marketing-editor');
 await db.query("INSERT INTO access_profiles(id,name,permissions) VALUES('marketing-editor','Marketing editor',ARRAY['catalog'])");
 await db.query("UPDATE users SET access_profile_id='marketing-editor' WHERE email='marketing-editor@gmail.com'");
 const settings=(await editor.get('/api/admin/marketing')).body;
 assert.equal((await editor.mutate('put','/api/admin/marketing',settings)).status,200);
 await db.query("UPDATE access_profiles SET permissions=ARRAY['overview'] WHERE id='marketing-editor'");
 assert.equal((await editor.get('/api/admin/marketing')).status,403);
});
