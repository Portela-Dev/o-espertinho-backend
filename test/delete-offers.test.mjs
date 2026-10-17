import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,identity,client,seedOffer,createApp} from './helpers.mjs';
let db,config,app,admin,user;
const snapshot=async id=>(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];
const version=offer=>({expectedUpdatedAt:new Date(offer.updated_at).toISOString()});
before(async()=>{({db}=await testDatabase());config=testConfig();app=createApp(db,config,{verifyGoogle:async t=>identity(t)});admin=client(app);user=client(app);await admin.login('admin');await user.login('alice');});
after(async()=>db.end());

test('exclusão exige admin e XSRF e rejeita ofertas que não estão encerradas',async()=>{
 const id=await seedOffer(db,{status:'expired'}),body=version(await snapshot(id));
 const visitor=client(app);await visitor.init();assert.equal((await visitor.mutate('delete','/api/admin/offers/'+id,body)).status,401);
 assert.equal((await user.mutate('delete','/api/admin/offers/'+id,body)).status,403);
 assert.equal((await admin.agent.delete('/api/admin/offers/'+id).set('Origin',config.APP_ORIGIN).send(body)).status,403);
 for(const status of ['pending','published','rejected']){
  const other=await seedOffer(db,{status,expires:new Date(Date.now()-1000)});
  assert.equal((await admin.mutate('delete','/api/admin/offers/'+other,version(await snapshot(other)))).status,409);
  assert.ok(await snapshot(other));
 }
 assert.ok(await snapshot(id));
});

test('exclusão remove dependências e prévias, mantém auditoria e permite cadastrar o produto novamente',async()=>{
 const owner=(await user.get('/api/auth/session')).body.user.id;
 for(const source of ['manual','api','scraped']){
  const externalId='delete-'+randomUUID(),id=await seedOffer(db,{status:'expired',source,externalId}),collection=randomUUID(),preview=randomUUID();
  await db.query('INSERT INTO favorites(user_id,offer_id) VALUES($1,$2)',[owner,id]);
  await db.query("INSERT INTO collections(id,user_id,name) VALUES($1,$2,'Catálogo de teste')",[collection,owner]);
  await db.query('INSERT INTO collection_items(collection_id,offer_id) VALUES($1,$2)',[collection,id]);
  await db.query("INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,'amazon','detail')",[randomUUID(),id]);
  await db.query("INSERT INTO offer_import_previews(id,user_id,marketplace_id,affiliate_url,source_url,result,profile_version,expires_at,offer_id,product_id,product_updated_at) VALUES($1,$2,'amazon','https://www.amazon.com.br/dp/B012345678','https://www.amazon.com.br/dp/B012345678','{}',1,$3,$4,(SELECT product_id FROM offers WHERE id=$4),now())",[preview,owner,new Date(Date.now()+60000),id]);
  const response=await admin.mutate('delete','/api/admin/offers/'+id,version(await snapshot(id)));assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(await snapshot(id),undefined);
  for(const table of ['favorites','collection_items','click_events','offer_import_previews'])assert.equal((await db.query(`SELECT count(*) AS total FROM ${table} WHERE offer_id=$1`,[id])).rows[0].total,0,table);
  assert.equal((await db.query('SELECT id FROM collections WHERE id=$1',[collection])).rows.length,1);
  assert.equal((await db.query("SELECT * FROM audit_logs WHERE entity_id=$1 AND action='offer.deleted'",[id])).rows.length,1);
  assert.equal((await user.get('/api/offers/'+id)).status,404);
  assert.equal((await admin.mutate('delete','/api/admin/offers/'+id,{expectedUpdatedAt:new Date().toISOString()})).status,404);
  assert.ok(await seedOffer(db,{source,externalId,status:'pending'}));
 }
});

test('exclusão bloqueia dados antigos ou reativados e exige a versão da oferta',async()=>{
 const id=await seedOffer(db,{status:'expired'}),old=version(await snapshot(id));
 assert.equal((await admin.mutate('delete','/api/admin/offers/'+id,{})).status,400);
 await db.query('UPDATE offers SET updated_at=$2 WHERE id=$1',[id,new Date(Date.now()+1000)]);
 assert.equal((await admin.mutate('delete','/api/admin/offers/'+id,old)).status,409);
 const current=version(await snapshot(id));await db.query("UPDATE offers SET status='pending' WHERE id=$1",[id]);
 assert.equal((await admin.mutate('delete','/api/admin/offers/'+id,current)).status,409);assert.ok(await snapshot(id));
});

test('falha na auditoria desfaz a exclusão e preserva os dados associados',async()=>{
 const id=await seedOffer(db,{status:'expired'}),owner=(await user.get('/api/auth/session')).body.user.id;
 await db.query('INSERT INTO favorites(user_id,offer_id) VALUES($1,$2)',[owner,id]);
 const broken={...db,connect:async()=>{const connection=await db.connect();return {...connection,query:async(sql,args)=>{if(sql.startsWith('INSERT INTO audit_logs'))throw new Error('Falha simulada');return connection.query(sql,args);}};}};
 const failing=client(createApp(broken,config,{verifyGoogle:async t=>identity(t)}));await failing.login('admin');
 assert.equal((await failing.mutate('delete','/api/admin/offers/'+id,version(await snapshot(id)))).status,500);
 assert.ok(await snapshot(id));assert.equal((await db.query('SELECT * FROM favorites WHERE offer_id=$1',[id])).rows.length,1);
});
