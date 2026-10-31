import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {setup,link,drive} from './catalog-complete-helpers.mjs';
const base='/api/admin/discovery/enrichment';
async function category(f,path=['Tecnologia','Áudio']){return (await f.db.query('SELECT ids FROM register_category_path($1::text[])',[path])).rows[0].ids.at(-1);}

test('catalogação global reutiliza produto e herda categoria automaticamente, com replay idempotente e publicação manual',async t=>{
 const f=await catalogFixture(t);await setup(f);const categoryId=await category(f),productId=randomUUID(),id=await link(f,{title:'Headset Modelo X'});
 await f.db.query("INSERT INTO products(id,name,brand,category_path) VALUES($1,'Headset Modelo X','Marca',ARRAY['Tecnologia','Áudio'])",[productId]);
 const result=await drive(f,'product',()=>({error:'technical'}));assert.equal(result.stats.accepted,1);
 const row=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(row.product_id,productId);assert.equal(row.confirmed_category_id,categoryId);assert.equal(row.published_offer_id,null);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offers')).rows[0].n,0);
});

test('rascunho compartilhado evita duplicatas e categoriza todos os links',async t=>{
 const f=await catalogFixture(t);await setup(f);await category(f);
 await link(f,{title:'Headset Modelo X'});await link(f,{title:'Headset Modelo X'});
 await drive(f,'product',()=>({error:'technical'}));await drive(f,'category',()=>({decision:{categoryId:null,path:['Tecnologia','Áudio'],reason:''}}));
 const rows=(await f.db.query('SELECT product_id,confirmed_category_id,published_offer_id FROM discovery_links')).rows;
 assert.equal(new Set(rows.map(r=>r.product_id)).size,1);assert.ok(rows.every(r=>r.product_id&&r.confirmed_category_id&&!r.published_offer_id));
 const config=(await f.call('get','/catalog/ai/config?marketplaceId=amazon')).body;
 assert.deepEqual(config.product,{completed:2,total:2});assert.deepEqual(config.category,{completed:2,total:2});
});

test('catálogo amplo usa contexto limitado e categorias equivalentes são reutilizadas',async t=>{
 const f=await catalogFixture(t);await setup(f);
 await f.db.query("INSERT INTO category_nodes(path,normalized_path) SELECT ARRAY['Grupo '||n],ARRAY[lower('Grupo '||n)] FROM generate_series(1,135) n");
 const id=await category(f,['Eletrônicos','Fones']);await link(f,{title:'Fones de ouvido'});
 await drive(f,'product',()=>({error:'technical'}));await drive(f,'category',()=>({decision:{categoryId:null,path:['eletronico','fone'],reason:''}}));
 assert.equal((await f.db.query('SELECT confirmed_category_id FROM discovery_links')).rows[0].confirmed_category_id,id);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM category_nodes WHERE cardinality(path)=2')).rows[0].n,1);
});

test('flags independentes, sessão, CSRF e versões dos prompts continuam protegidos',async t=>{
 const f=await catalogFixture(t),path=base+'/ai/settings',original=(await f.browser.get(path)).body;
 const payload={...original,categoryEnabled:false,productEnabled:true,productPrompt:'Use o título',categoryPrompt:'Use a categoria de origem'};
 assert.equal((await f.browser.agent.put(path).send(payload)).status,403);
 const saved=await f.browser.mutate('put',path,payload);assert.equal(saved.status,200);
 assert.equal(saved.body.productEnabled,true);assert.equal(saved.body.categoryEnabled,false);
 assert.equal((await f.browser.mutate('put',path,payload)).status,409);
 assert.equal((await f.browser.mutate('put',path,{...saved.body,categoryPrompt:''})).status,400);
});

test('mudança de identidade extraída solta o rascunho para catalogação atualizada',async t=>{
 const f=await catalogFixture(t);await setup(f);const id=await link(f,{title:'Headset Modelo X'});
 await drive(f,'product',()=>({error:'technical'}));assert.ok((await f.db.query('SELECT product_draft_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_draft_id);
 await f.db.query("UPDATE discovery_links SET enrichment_data=jsonb_set(enrichment_data,'{title}','\"Headset Modelo Y\"') WHERE id=$1",[id]);
 assert.equal((await f.db.query('SELECT product_draft_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_draft_id,null);
 await drive(f,'product',()=>({error:'technical'}));assert.ok((await f.db.query('SELECT product_draft_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_draft_id);
});

test('prompts configurados chegam ao contexto e uma tarefa desativada não grava',async t=>{
 const f=await catalogFixture(t);await setup(f);const path=base+'/ai/settings',settings=(await f.browser.get(path)).body;
 await f.browser.mutate('put',path,{...settings,productPrompt:'Minha política por título.'});await link(f,{title:'Câmera Modelo A'});
 const run=(await f.call('post','/catalog/resolver/start',{marketplaceId:'amazon',task:'product',limit:1,requestKey:randomUUID()})).body;
 const item=(await f.call('post','/catalog/resolver/claim',{runId:run.id})).body.item;assert.equal(item.context.prompt,'Minha política por título.');
 await f.db.query('UPDATE review_ai_settings SET product_enabled=false');
 const result=await f.call('post','/catalog/resolver/complete',{runId:run.id,itemId:item.id,leaseId:item.leaseId,error:'technical'});assert.equal(result.status,409);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM review_ai_product_drafts')).rows[0].n,0);
});

test('retomada recupera falhas antigas sem perder métricas nem misturar marketplaces',async t=>{
 const f=await catalogFixture(t);await setup(f);await link(f,{title:'Modelo X'});
 const run=(await f.call('post','/catalog/resolver/start',{marketplaceId:'amazon',task:'product',limit:1,requestKey:randomUUID()})).body;
 await f.db.query("UPDATE catalog_resolver_items SET status='failed',attempts=3,calls=3 WHERE run_id=$1",[run.id]);
 await f.call('post','/catalog/resolver/action',{runId:run.id,action:'pause'});
 await f.call('post','/catalog/resolver/action',{runId:run.id,action:'resume'});
 const item=(await f.call('post','/catalog/resolver/claim',{runId:run.id})).body.item;assert.ok(item);
 const done=await f.call('post','/catalog/resolver/complete',{runId:run.id,itemId:item.id,leaseId:item.leaseId,error:'technical'});assert.equal(done.status,200);
 assert.equal((await f.db.query('SELECT calls FROM catalog_resolver_items WHERE id=$1',[item.id])).rows[0].calls,3);
 assert.equal((await f.call('get','/catalog/ai/config?marketplaceId=mercadolivre')).body.product.completed,0);
});

test('contradições e antigas propostas de invalidação são resolvidas pelo título',async t=>{
 const f=await catalogFixture(t);await setup(f);const id=await link(f,{title:'Celular Modelo X 128 GB',description:'Modelo Z de 256 GB'});
 await drive(f,'product',()=>({decision:{action:'invalid',reason:'Contradição'}}));await drive(f,'category',()=>({error:'technical'}));
 const row=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.ok(row.product_id);assert.ok(row.confirmed_category_id);assert.deepEqual(row.ai_resolution,{});
 const product=(await f.db.query('SELECT name FROM products WHERE id=$1',[row.product_id])).rows[0];assert.equal(product.name,'Celular Modelo X 128 GB');
});

test('kits personalizados preservam produtos próprios mesmo com nomes iguais',async t=>{
 const f=await catalogFixture(t);await setup(f);
 for(let i=0;i<2;i++)await link(f,{title:'Kit personalizado A + B'});
 await drive(f,'product',()=>({error:'technical'}));await drive(f,'category',()=>({error:'technical'}));
 const products=(await f.db.query('SELECT id,personalized_kit FROM products')).rows;assert.equal(products.length,2);assert.ok(products.every(p=>p.personalized_kit));
});
