import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,client,createApp,identity,seedProduct} from './helpers.mjs';
import {categoryKey} from '../dist/enrichment-admin.js';
let db,admin,user,ids=[];
const base='/api/admin/discovery/enrichment';
before(async()=>{({db}=await testDatabase());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)});admin=client(app);user=client(app);await admin.login('admin');await user.login('alice');
 await db.query("INSERT INTO scraping_profiles(marketplace_id,rules,wait_timeout_ms,validity_minutes) VALUES('amazon',$1,15000,360) ON CONFLICT(marketplace_id) DO UPDATE SET rules=$1",[JSON.stringify([{field:'title',selectors:['h1'],mode:'text',required:true},{field:'price',selectors:['.price'],mode:'text',required:true}])]);
 for(let i=0;i<3;i++){const id=randomUUID();ids.push(id);await db.query("INSERT INTO discovery_links(id,marketplace_id,url) VALUES($1,'amazon',$2)",[id,'https://www.amazon.com.br/product/'+id]);}
});
after(async()=>db.end());
test('manual runs snapshot settings, prevent overlap, cancel idempotently and preserve data',async()=>{
 assert.equal((await admin.mutate('put',base+'/settings/amazon',{requestIntervalMs:100,categorySeparator:'>'})).status,200);
 const run=await admin.mutate('post',base+'/runs',{marketplaceId:'amazon',limit:2});assert.equal(run.status,202);assert.equal(run.body.total,2);
 assert.equal((await db.query('SELECT snapshot FROM enrichment_runs WHERE id=$1',[run.body.id])).rows[0].snapshot.requestIntervalMs,100);
 assert.equal((await admin.mutate('post',base+'/runs',{marketplaceId:'amazon'})).status,409);
 assert.equal((await admin.get(base+'/runs')).body.items[0].total,2);
 assert.equal((await admin.get(base+'/runs/'+run.body.id+'/items')).body.total,2);
 assert.equal((await admin.mutate('post',base+'/runs/'+run.body.id+'/cancel',{})).status,200);
 assert.equal((await admin.mutate('post',base+'/runs/'+run.body.id+'/cancel',{})).status,200);
 assert.equal((await db.query("SELECT count(*)::int n FROM enrichment_items WHERE run_id=$1 AND status='cancelled'",[run.body.id])).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n,0);
});
test('exact marketplace/full-path mappings only suggest; confirmation and mapping mutation are separate',async()=>{
 const path=['Eletrônicos','Áudio','Fones'],key=categoryKey(path);
 const nodes=(await db.query("SELECT * FROM register_category_path(ARRAY['Informática','Acessórios'])")).rows[0];const categoryId=nodes.ids.at(-1),otherId=nodes.ids[0];
 for(const id of ids)await db.query("UPDATE discovery_links SET extraction_status='completed',enrichment_data=$2,source_category_path=$3,source_category_key=$4,enrichment_version=1 WHERE id=$1",[id,JSON.stringify({title:'Fone',priceCents:1000}),path,key]);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[0]+'/category',{categoryId,version:1,saveMapping:true})).status,200);
 let links=(await admin.get(base+'/review')).body.items;const pending=links.find(l=>l.id===ids[1]);assert.equal(pending.suggested_category_id,categoryId);assert.equal(pending.confirmed_category_id,null);assert.deepEqual(pending.source_category_path,path);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[0]+'/category',{categoryId,version:1})).status,409);
 const mapping=(await admin.get(base+'/mappings')).body.items[0];assert.equal((await admin.mutate('put',base+'/mappings/'+mapping.id,{categoryId:otherId})).status,200);
 links=(await admin.get(base+'/review')).body.items;assert.equal(links.find(l=>l.id===ids[0]).confirmed_category_id,categoryId);assert.equal(links.find(l=>l.id===ids[1]).suggested_category_id,otherId);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[1]+'/category',{categoryId,version:1,saveMapping:false})).status,200);
 assert.equal((await admin.get(base+'/mappings')).body.items[0].category_id,otherId);
 await db.query("UPDATE discovery_links SET source_category_key=$2 WHERE id=$1",[ids[2],categoryKey(['Outros','Fones'])]);assert.equal((await admin.get(base+'/review')).body.items.find(l=>l.id===ids[2]).suggested_category_id,null);
 assert.equal((await admin.mutate('delete',base+'/mappings/'+mapping.id,{})).status,200);
 assert.equal((await admin.get(base+'/review')).body.items.find(l=>l.id===ids[0]).confirmed_category_id,categoryId);
});
test('missing origin allows item-only confirmation and permissions/XSRF/limits remain enforced',async()=>{
 await db.query("UPDATE discovery_links SET source_category_path='{}',source_category_key='' WHERE id=$1",[ids[2]]);
 const categoryId=(await db.query('SELECT id FROM category_nodes LIMIT 1')).rows[0].id;
 assert.equal((await admin.mutate('post',base+'/review/'+ids[2]+'/category',{categoryId,version:1,saveMapping:true})).status,400);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[2]+'/category',{categoryId,version:1})).status,200);
 assert.equal((await user.get(base+'/review')).status,403);
 assert.equal((await user.mutate('post',base+'/runs',{marketplaceId:'amazon'})).status,403);
 assert.equal((await admin.agent.post(base+'/runs').send({marketplaceId:'amazon'})).status,403);
 assert.equal((await admin.mutate('put',base+'/settings/amazon',{requestIntervalMs:99,categorySeparator:'>'})).status,400);
 assert.equal((await admin.mutate('post',base+'/runs',{marketplaceId:'amazon',schedule:true})).status,400);
 assert.equal((await admin.get(base+'/review?pageSize=51')).status,400);
});
test('review creates reusable category trees up to ten levels without assigning or publishing anything',async()=>{
 const before=(await db.query('SELECT id,confirmed_category_id FROM discovery_links ORDER BY id')).rows;
 const categoryPath=['  Nova   árvore  ',...Array.from({length:9},(_,i)=>'Nível '+(i+2))];
 const created=await admin.mutate('post',base+'/categories',{categoryPath});assert.equal(created.status,201);
 assert.equal(created.body.nodes.length,10);assert.equal(created.body.path[0],'Nova árvore');assert.equal(created.body.path.length,10);
 assert.equal(created.body.nodes[9].id,created.body.id);
 const reused=await admin.mutate('post',base+'/categories',{categoryPath:created.body.path.map(p=>p.toLowerCase())});assert.equal(reused.status,201);assert.equal(reused.body.id,created.body.id);assert.deepEqual(reused.body.path,created.body.path);
 assert.ok((await admin.get(base+'/categories')).body.some(n=>n.id===created.body.id));
 assert.deepEqual((await db.query('SELECT id,confirmed_category_id FROM discovery_links ORDER BY id')).rows,before);
 for(const table of ['products','offers'])assert.equal((await db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 for(const categoryPath of [[],[' '],['a'.repeat(81)],Array(11).fill('Categoria')])assert.equal((await admin.mutate('post',base+'/categories',{categoryPath})).status,400);
 assert.equal((await user.mutate('post',base+'/categories',{categoryPath:['Proibida']})).status,403);
 assert.equal((await admin.agent.post(base+'/categories').send({categoryPath:['Sem XSRF']})).status,403);
});

test('product assignment requires confirmed category, creates atomically and rejects stale retries',async()=>{
 const id=ids[0],url=base+'/review/'+id;
 const row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 const product={name:'Fone revisado',description:'Descrição editada',brand:'Marca editada',imageUrl:'https://example.com/fone.jpg'};
 const body={mode:'new',version:row.enrichment_version,product};
 assert.equal((await user.mutate('post',url+'/product',body)).status,403);
 assert.equal((await admin.agent.post(url+'/product').send(body)).status,403);
 const pending=randomUUID();await db.query("INSERT INTO discovery_links(id,marketplace_id,url) VALUES($1,'amazon',$2)",[pending,'https://example.com/'+pending]);
 assert.equal((await admin.mutate('post',base+'/review/'+pending+'/product',{...body,version:0})).status,409);
 assert.equal((await admin.get(base+'/review/'+pending+'/products')).status,409);
 assert.equal((await admin.mutate('post',url+'/product',{...body,product:{...product,imageUrl:'http://example.com/x'}})).status,400);
 const created=await admin.mutate('post',url+'/product',body);assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal(created.body.status,'ready_for_review');assert.equal(created.body.product.name,product.name);
 assert.equal(created.body.product.description,product.description);assert.equal(created.body.product.brand,product.brand);assert.equal(created.body.product.image_url,product.imageUrl);
 const category=(await db.query('SELECT path FROM category_nodes WHERE id=$1',[row.confirmed_category_id])).rows[0];assert.deepEqual(created.body.product.category_path,category.path);
 assert.equal((await admin.mutate('post',url+'/product',body)).status,409);
 assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n,1);
 const review=(await admin.get(base+'/review')).body.items.find(l=>l.id===id);assert.equal(review.product_id,created.body.product.id);assert.equal(review.product_name,product.name);
 assert.equal((await db.query('SELECT count(*)::int n FROM offers')).rows[0].n,0);
});

test('existing products are searched within category, preserved and invalidated on category changes',async()=>{
 const id=ids[1],url=base+'/review/'+id;
 let row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 const existing=(await db.query('SELECT * FROM products LIMIT 1')).rows[0];
 const unrelated=await seedProduct(db,{name:'Produto fora da categoria',category:'Casa'});
 const found=await admin.get(url+'/products?q=Fone&pageSize=1');assert.equal(found.status,200);assert.equal(found.body.total,1);assert.equal(found.body.items[0].id,existing.id);
 assert.equal((await admin.get(url+'/products?q=%25')).body.total,0);
 assert.equal((await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:unrelated})).status,409);
 assert.equal((await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:existing.id})).status,200);
 assert.deepEqual((await db.query('SELECT * FROM products WHERE id=$1',[existing.id])).rows[0],existing);
 row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 const root=existing.category_ids[0];assert.equal((await admin.mutate('post',url+'/category',{categoryId:root,version:row.enrichment_version})).status,200);
 assert.equal((await db.query('SELECT product_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_id,null);
 // Simulate worker invalidation after the source category changes.
 await db.query('UPDATE discovery_links SET confirmed_category_id=NULL WHERE id=$1',[ids[0]]);
 assert.equal((await db.query('SELECT product_id FROM discovery_links WHERE id=$1',[ids[0]])).rows[0].product_id,null);
 row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 assert.equal((await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:existing.id})).status,200);
 await db.query("UPDATE products SET category_path=ARRAY['Casa'] WHERE id=$1",[existing.id]);
 assert.equal((await db.query('SELECT product_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_id,null);
 await db.query("UPDATE discovery_links SET status='archived' WHERE id=$1",[id]);
 assert.equal((await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:existing.id})).status,409);
});

test('targeted retries preserve history, exclude resolved/archived links and reject overlapping runs',async()=>{
 const actor=(await db.query("SELECT id FROM users WHERE email='arnaldorolimportela@gmail.com'")).rows[0].id;
 const runId=randomUUID(),links=Array.from({length:5},()=>randomUUID());
 await db.query("INSERT INTO enrichment_runs(id,marketplace_id,created_by,snapshot,total,status) VALUES($1,'amazon',$2,'{}',4,'completed')",[runId,actor]);
 for(let i=0;i<links.length;i++){
  await db.query("INSERT INTO discovery_links(id,marketplace_id,url,status,extraction_status,extraction_error) VALUES($1,'amazon',$2,$3,$4,'incomplete')",[links[i],'https://www.amazon.com.br/product/'+links[i],i===2?'archived':'pending',i===1?'completed':i===3?'pending':'failed']);
  if(i<4)await db.query("INSERT INTO enrichment_items(run_id,link_id,status,error) VALUES($1,$2,'failed','incomplete')",[runId,links[i]]);
 }
 const retry=base+'/runs/'+runId+'/retry';
 assert.equal((await user.mutate('post',retry,{})).status,403);
 assert.equal((await admin.agent.post(retry).send({})).status,403);
 assert.equal((await admin.mutate('post',retry,{marketplaceId:'other'})).status,400);
 await db.query("UPDATE scraping_profiles SET version=7 WHERE marketplace_id='amazon'");
 const queued=await admin.mutate('post',retry,{});assert.equal(queued.status,202,JSON.stringify(queued.body));assert.equal(queued.body.total,1);
 assert.deepEqual((await db.query('SELECT link_id FROM enrichment_items WHERE run_id=$1',[queued.body.id])).rows.map(r=>r.link_id),[links[0]]);
 assert.equal((await db.query('SELECT snapshot FROM enrichment_runs WHERE id=$1',[queued.body.id])).rows[0].snapshot.profileVersion,7);
 assert.equal((await admin.mutate('post',retry,{})).status,409);
 assert.equal((await admin.mutate('post',base+'/review/'+links[4]+'/retry',{})).status,409);
 assert.equal((await db.query('SELECT count(*)::int n FROM enrichment_items WHERE run_id=$1 AND status=\'failed\'',[runId])).rows[0].n,4);
 assert.equal((await admin.mutate('post',base+'/runs/'+queued.body.id+'/cancel',{})).status,200);
 for(const id of [links[1],links[2],links[3]])assert.equal((await admin.mutate('post',base+'/review/'+id+'/retry',{})).status,409);
 assert.equal((await admin.mutate('post',base+'/review/'+randomUUID()+'/retry',{})).status,404);
 assert.equal((await admin.mutate('post',base+'/runs/'+randomUUID()+'/retry',{})).status,404);
 const single=await admin.mutate('post',base+'/review/'+links[4]+'/retry',{});assert.equal(single.status,202);assert.equal(single.body.total,1);
 assert.deepEqual((await db.query('SELECT link_id FROM enrichment_items WHERE run_id=$1',[single.body.id])).rows.map(r=>r.link_id),[links[4]]);
 assert.equal((await db.query('SELECT extraction_error FROM discovery_links WHERE id=$1',[links[4]])).rows[0].extraction_error,'incomplete');
 await admin.mutate('post',base+'/runs/'+single.body.id+'/cancel',{});
 await db.query("UPDATE discovery_links SET extraction_status='completed' WHERE id=$1",[links[0]]);
 assert.equal((await admin.mutate('post',retry,{})).status,409);
});
