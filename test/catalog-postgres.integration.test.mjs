import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import request from 'supertest';
import {createDatabase} from '../dist/db.js';
import {migrate} from '../dist/migrate.js';
import {createApp} from '../dist/app.js';
import {hash} from '../dist/security.js';
import {testConfig} from './helpers.mjs';
import {defaultDiscoveryConfig} from '../dist/discovery-config.js';
const enabled=!!process.env.CATALOG_TEST_PG_URL;
test('PostgreSQL isolado: concorrência, cancelamento e backup/restauração com migrations reais',{skip:!enabled,timeout:60000},async()=>{
 const url=new URL(process.env.CATALOG_TEST_PG_URL),container=process.env.CATALOG_TEST_CONTAINER;
 assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/catalog_test_[a-f0-9]+$/);assert.match(container,/^espertinho-catalog-test-[a-f0-9]{12}$/);
 const db=createDatabase(url.href);let restored;
 try{
  await migrate(db);const user=(await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0].id,token=randomBytes(32).toString('hex'),sid=randomBytes(32).toString('hex'),extensionId='a'.repeat(32);
  await db.query("INSERT INTO sessions(id,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",[sid,user,hash('test-only')]);
  await db.query("INSERT INTO extension_sessions(id,user_id,browser_session_id,extension_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days')",[randomUUID(),user,sid,extensionId,hash(token),hash('test-only-refresh')]);
  const app=createApp(db,testConfig()),post=(path,body)=>request(app).post('/api/extension'+path).set('X-Espertinho-Extension-Id',extensionId).set('Authorization','Bearer '+token).send(body);
  await db.query("UPDATE marketplaces SET catalog_executor='extension',scraping_enabled=true,allowed_hosts=ARRAY['shop.example.com'] WHERE id='amazon'");
  const profile=randomUUID(),source=randomUUID(),config=defaultDiscoveryConfig();config.extraction.itemSelector='.card';
  await db.query("INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,'amazon','Fixture',$2)",[profile,JSON.stringify(config)]);
  await db.query("INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,enabled) VALUES($1,'amazon',$2,'Fixture','https://shop.example.com/list',true)",[source,profile]);
  const starts=await Promise.all([post('/catalog/runs',{marketplaceId:'amazon',step:'discover',requestKey:randomUUID()}),post('/catalog/runs',{marketplaceId:'amazon',step:'discover',requestKey:randomUUID()})]);
  assert.deepEqual(starts.map(r=>r.status).sort(),[201,409]);const run=starts.find(r=>r.status===201).body;
  const claims=await Promise.all([post(`/catalog/runs/${run.id}/claim`,{}),post(`/catalog/runs/${run.id}/claim`,{})]);assert.equal(claims.filter(r=>r.body.item).length,1);
  const item=claims.find(r=>r.body.item).body.item;await post(`/catalog/runs/${run.id}/action`,{action:'cancel'});
  assert.equal((await post(`/catalog/runs/${run.id}/results`,{itemId:item.id,leaseToken:item.lease_token,outcome:'success',links:['https://shop.example.com/p'],done:true})).status,409);
  const dump=spawnSync('docker',['exec',container,'pg_dump','-U','catalog_test_admin','-d',url.pathname.slice(1),'-Fc','--no-owner','--no-acl'],{windowsHide:true,maxBuffer:20*1024*1024});assert.equal(dump.status,0);
  const restoredName=url.pathname.slice(1)+'_restored';assert.equal(spawnSync('docker',['exec',container,'createdb','-U','catalog_test_admin',restoredName],{windowsHide:true}).status,0);
  assert.equal(spawnSync('docker',['exec','-i',container,'pg_restore','-U','catalog_test_admin','-d',restoredName,'--no-owner','--no-acl'],{input:dump.stdout,windowsHide:true}).status,0);
  const restoredUrl=new URL(url);restoredUrl.pathname='/'+restoredName;restored=createDatabase(restoredUrl.href);
  assert.equal((await restored.query('SELECT status FROM extension_catalog_runs WHERE id=$1',[run.id])).rows[0].status,'cancelled');await migrate(restored);
  assert.equal((await restored.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,31);
 }finally{await restored?.end();await db.end();}
});
