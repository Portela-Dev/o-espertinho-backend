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

test('manual mapping confirms matching pending categories; later mapping edits preserve confirmations',async()=>{
 const path=['Eletrônicos','Áudio','Fones'],key=categoryKey(path);
 const nodes=(await db.query("SELECT * FROM register_category_path(ARRAY['Informática','Acessórios'])")).rows[0];const categoryId=nodes.ids.at(-1),otherId=nodes.ids[0];
 for(const id of ids)await db.query("UPDATE discovery_links SET extraction_status='completed',enrichment_data=$2,source_category_path=$3,source_category_key=$4,enrichment_version=1 WHERE id=$1",[id,JSON.stringify({title:'Fone',priceCents:1000}),path,key]);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[0]+'/category',{categoryId,version:1,saveMapping:true})).status,200);
 let links=(await admin.get(base+'/review')).body.items;const pending=links.find(l=>l.id===ids[1]);assert.equal(pending.suggested_category_id,categoryId);assert.equal(pending.confirmed_category_id,categoryId);assert.deepEqual(pending.source_category_path,path);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[0]+'/category',{categoryId,version:1})).status,409);
 const mapping=(await admin.get(base+'/mappings')).body.items[0];assert.equal((await admin.mutate('put',base+'/mappings/'+mapping.id,{categoryId:otherId})).status,200);
 links=(await admin.get(base+'/review')).body.items;assert.equal(links.find(l=>l.id===ids[0]).confirmed_category_id,categoryId);assert.equal(links.find(l=>l.id===ids[1]).suggested_category_id,otherId);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[1]+'/category',{categoryId,version:2,saveMapping:false})).status,200);
 assert.equal((await admin.get(base+'/mappings')).body.items[0].category_id,otherId);
 await db.query("UPDATE discovery_links SET source_category_key=$2 WHERE id=$1",[ids[2],categoryKey(['Outros','Fones'])]);assert.equal((await admin.get(base+'/review')).body.items.find(l=>l.id===ids[2]).suggested_category_id,null);
 assert.equal((await admin.mutate('delete',base+'/mappings/'+mapping.id,{})).status,200);
 assert.equal((await admin.get(base+'/review')).body.items.find(l=>l.id===ids[0]).confirmed_category_id,categoryId);
});
test('missing origin allows item-only confirmation and permissions/XSRF/limits remain enforced',async()=>{
 await db.query("UPDATE discovery_links SET source_category_path='{}',source_category_key='',confirmed_category_id=NULL,enrichment_version=1 WHERE id=$1",[ids[2]]);
 const categoryId=(await db.query('SELECT id FROM category_nodes LIMIT 1')).rows[0].id;
 assert.equal((await admin.mutate('post',base+'/review/'+ids[2]+'/category',{categoryId,version:1,saveMapping:true})).status,400);
 assert.equal((await admin.mutate('post',base+'/review/'+ids[2]+'/category',{categoryId,version:1})).status,200);
 assert.equal((await user.get(base+'/review')).status,403);
 assert.equal((await user.mutate('post',base+'/runs',{marketplaceId:'amazon'})).status,403);
 assert.equal((await admin.agent.post(base+'/runs').send({marketplaceId:'amazon'})).status,403);
 assert.equal((await admin.mutate('put',base+'/settings/amazon',{requestIntervalMs:99,categorySeparator:'>'})).status,404);
 assert.equal((await admin.mutate('post',base+'/runs',{marketplaceId:'amazon',schedule:true})).status,404);
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

test('manual product creation with confirmed category is atomic and rejects stale retries',async()=>{
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
 for(const imageUrl of ['https://127.0.0.1/image','https://router.local/image','https://example.com:8443/image','https://user:pass@example.com/image'])assert.equal((await admin.mutate('post',url+'/product',{...body,product:{...product,imageUrl}})).status,400,imageUrl);
 const created=await admin.mutate('post',url+'/product',body);assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal(created.body.status,'ready_for_review');assert.equal(created.body.product.name,product.name);
 assert.equal(created.body.product.description,product.description);assert.equal(created.body.product.brand,product.brand);assert.equal(created.body.product.image_url,product.imageUrl);
 const category=(await db.query('SELECT path FROM category_nodes WHERE id=$1',[row.confirmed_category_id])).rows[0];assert.deepEqual(created.body.product.category_path,category.path);
 assert.equal((await admin.mutate('post',url+'/product',body)).status,409);
 assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n,1);
 const review=(await admin.get(base+'/review')).body.items.find(l=>l.id===id);assert.equal(review.product_id,created.body.product.id);assert.equal(review.product_name,product.name);
 assert.equal((await db.query('SELECT count(*)::int n FROM offers')).rows[0].n,0);
});

test('existing products are searched globally and inherit category; product category edits preserve links',async()=>{
 const id=ids[1],url=base+'/review/'+id;
 let row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 const existing=(await db.query('SELECT * FROM products LIMIT 1')).rows[0];
 const unrelated=await seedProduct(db,{name:'Produto fora da categoria',category:'Casa'});
 const found=await admin.get(url+'/products?q=Fone&pageSize=1');assert.equal(found.status,200);assert.equal(found.body.total,1);assert.equal(found.body.items[0].id,existing.id);
 assert.equal((await admin.get(url+'/products?q=%25')).body.total,0);
 const outside=await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:unrelated});assert.equal(outside.status,200);
 row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.deepEqual((await db.query('SELECT path FROM category_nodes WHERE id=$1',[row.confirmed_category_id])).rows[0].path,['Casa']);
 assert.equal((await admin.mutate('post',url+'/product',{mode:'existing',version:row.enrichment_version,productId:existing.id})).status,200);
 assert.deepEqual((await db.query('SELECT * FROM products WHERE id=$1',[existing.id])).rows[0],existing);
 row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 const root=existing.category_ids[0];assert.equal((await admin.mutate('post',url+'/category',{categoryId:root,version:row.enrichment_version})).status,200);
 assert.equal((await db.query('SELECT product_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_id,existing.id);
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


test('saved manual mapping applies only to eligible matching links and finalizes catalog drafts',async()=>{
 const path=['Teste de propagação','Folha'],key=categoryKey(path);
 const category=(await db.query("SELECT * FROM register_category_path(ARRAY['Destino de propagação'])")).rows[0].ids.at(-1);
 const other=(await db.query("SELECT * FROM register_category_path(ARRAY['Preservada'])")).rows[0].ids.at(-1);
 const make=async(changes={})=>{const id=randomUUID();await db.query("INSERT INTO discovery_links(id,marketplace_id,url,source_category_path,source_category_key,extraction_status,enrichment_data) VALUES($1,'amazon',$2,$3,$4,'completed',$5)",[id,'https://www.amazon.com.br/product/'+id,path,key,JSON.stringify({title:'Item de propagação'})]);for(const [column,value] of Object.entries(changes))await db.query('UPDATE discovery_links SET '+column+'=$2 WHERE id=$1',[id,value]);return id;};
 const source=await make(),peer=await make(),confirmed=await make({confirmed_category_id:other}),archived=await make({status:'archived'}),failed=await make({extraction_status:'failed'}),pending=await make({extraction_status:'pending'}),invalid=await make({ai_resolution:JSON.stringify({product:{action:'invalid'}})}),differentPath=await make({source_category_key:categoryKey(['Outra árvore','Folha'])});
 await db.query("INSERT INTO marketplaces(id,name,website_url,allowed_hosts) VALUES('mapping-test','Outro marketplace','https://shop.example.com',ARRAY['shop.example.com'])");
 const differentMarket=await make({marketplace_id:'mapping-test'});
 const drafted=await make();const draft=randomUUID();await db.query("INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand) VALUES($1,$2,'Rascunho propagado','','')",[draft,'propagation-'+draft]);await db.query('UPDATE discovery_links SET product_draft_id=$2 WHERE id=$1',[drafted,draft]);
 const untouched=[confirmed,archived,failed,pending,invalid,differentPath,differentMarket];
 const before=(await db.query('SELECT * FROM discovery_links WHERE id=ANY($1::uuid[]) ORDER BY id',[untouched])).rows;
 assert.equal((await admin.mutate('post',base+'/review/'+source+'/category',{categoryId:category,version:0,saveMapping:false})).status,200);
 assert.equal((await db.query('SELECT confirmed_category_id FROM discovery_links WHERE id=$1',[peer])).rows[0].confirmed_category_id,null);
 assert.equal((await admin.mutate('post',base+'/review/'+source+'/category',{categoryId:category,version:1,saveMapping:true})).status,200);
 for(const id of [peer,drafted]){const row=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(row.confirmed_category_id,category);assert.ok(row.category_confirmed_by);assert.ok(row.category_confirmed_at);assert.equal(row.enrichment_version,1);if(id===drafted)assert.ok(row.product_id);assert.equal(row.published_offer_id,null);}
 assert.deepEqual((await db.query('SELECT * FROM discovery_links WHERE id=ANY($1::uuid[]) ORDER BY id',[untouched])).rows,before);
 assert.equal((await admin.mutate('post',base+'/review/'+peer+'/category',{categoryId:category,version:0})).status,409);
});
