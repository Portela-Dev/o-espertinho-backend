import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
const base='/api/admin/discovery/enrichment';
async function seed(f,title='Headset Modelo X'){
 const id=randomUUID(),url='https://www.amazon.com.br/product/'+id,data={title,brand:'Marca',description:'Descrição',priceCents:12345,originalPriceCents:null,images:['https://example.com/photo.jpg'],missing:[],conditions:'',specifications:[],availability:'available'};
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,source_category_path,extracted_at) VALUES($1,'amazon',$2,$3,'completed',$4,ARRAY['Tecnologia','Áudio'],clock_timestamp())",[id,url,url+'?tag=test-20',JSON.stringify(data)]);return id;
}
async function settings(f,changes={}){const value=(await f.browser.get(base+'/ai/settings')).body;const r=await f.browser.mutate('put',base+'/ai/settings',{...value,categoryEnabled:true,productEnabled:true,...changes});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function revision(f){return (await f.db.query('SELECT revision::text AS r FROM review_ai_inventory_state')).rows[0].r;}
async function context(f,id,task){const r=await f.call('post','/catalog/ai/context',{id,task,inventoryRevision:await revision(f)});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
const decision=(action,extra={})=>({action,category:'',categoryId:null,productId:null,product:null,reason:'Identidade verificada nos candidatos.',...extra});
async function save(f,ctx,suggestion){const body={requestId:ctx.requestId,model:'fixture',suggestion};const r=await f.call('post','/catalog/ai/suggestions',body);assert.equal(r.status,200,JSON.stringify(r.body));return {result:r.body,body};}
async function category(f,path=['Tecnologia','Áudio']){return (await f.db.query('SELECT ids FROM register_category_path($1::text[])',[path])).rows[0].ids.at(-1);}

test('catalogação global reutiliza produto e herda categoria automaticamente, com replay idempotente e publicação manual',async t=>{
 const f=await catalogFixture(t);await settings(f);const categoryId=await category(f),productId=randomUUID(),id=await seed(f);
 await f.db.query("INSERT INTO products(id,name,brand,category_path) VALUES($1,'Headset Modelo X','Marca',ARRAY['Tecnologia','Áudio'])",[productId]);
 const ctx=await context(f,id,'product'),{result,body}=await save(f,ctx,decision('link_existing',{productId}));assert.equal(result.outcome,'linked');assert.equal(result.applied,true);
 const row=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(row.product_id,productId);assert.equal(row.confirmed_category_id,categoryId);assert.equal(row.published_offer_id,null);
 const replay=await f.call('post','/catalog/ai/suggestions',body);assert.deepEqual(replay.body,result);
 assert.equal((await f.call('post','/catalog/ai/suggestions',{...body,suggestion:decision('needs_review')})).status,409);
 assert.equal((await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=category')).body.items.length,0);
 const published=await f.browser.mutate('post',base+'/review/'+id+'/publish',{version:row.enrichment_version,authorizedContent:true});assert.equal(published.status,200,JSON.stringify(published.body));assert.ok(published.body.offerId);
});

test('rascunho compartilhado evita duplicatas e categorização cria um único produto para todos os links',async t=>{
 const f=await catalogFixture(t);await settings(f);const categoryId=await category(f),ids=[await seed(f),await seed(f,'Outro título do mesmo modelo')];
 let ctx=await context(f,ids[0],'product');const first=await save(f,ctx,decision('create_new',{product:{name:'Headset Modelo X',brand:'Marca',description:'Descrição canônica'}}));
 assert.equal(first.result.outcome,'drafted');const draftId=first.result.inventory.drafts[0].id;assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,0);
 ctx=await context(f,ids[1],'product');await save(f,ctx,decision('link_existing',{productId:draftId}));
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM review_ai_product_drafts')).rows[0].n,1);
 const queue=await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=category');assert.equal(queue.body.items.length,1);
 ctx=await context(f,queue.body.items[0].id,'category');const before=(await f.db.query('SELECT count(*)::int AS n FROM category_nodes')).rows[0].n;
 const done=await save(f,ctx,decision('use_category',{categoryId,category:'Tecnologia > Áudio'}));assert.equal(done.result.outcome,'categorized');assert.deepEqual(done.result.inventory.removeDraftIds,[draftId]);
 const rows=(await f.db.query('SELECT product_id,confirmed_category_id,published_offer_id FROM discovery_links ORDER BY id')).rows;assert.equal(new Set(rows.map(r=>r.product_id)).size,1);assert.ok(rows[0].product_id);assert.ok(rows.every(r=>r.confirmed_category_id===categoryId&&r.published_offer_id===null));
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM category_nodes')).rows[0].n,before);
 const config=(await f.call('get','/catalog/ai/config?marketplaceId=amazon')).body;assert.deepEqual(config.product,{completed:2,total:2});assert.deepEqual(config.category,{completed:2,total:2});
});

test('inventário percorre todas as páginas sem limite oculto e invalida snapshots após mudanças; ambiguidades não são aplicadas',async t=>{
 const f=await catalogFixture(t);await settings(f);await f.db.query("INSERT INTO category_nodes(path,normalized_path) SELECT ARRAY['Grupo '||n],ARRAY[lower('Grupo '||n)] FROM generate_series(1,135) n");
 let cursor,rev,ids=[];do{const page=await f.call('get','/catalog/ai/inventory?kind=categories&limit=25'+(cursor?'&cursor='+cursor:'')+(rev?'&revision='+rev:''));assert.equal(page.status,200,JSON.stringify(page.body));rev=page.body.revision;ids.push(...page.body.items.map(c=>c.id));cursor=page.body.nextCursor;}while(cursor);
 assert.ok(ids.length>=135);assert.equal(new Set(ids).size,ids.length);
 const id=await seed(f),ctx=await context(f,id,'product');await category(f,['Criada depois']);
 let response=await f.call('post','/catalog/ai/suggestions',{requestId:ctx.requestId,model:'fixture',suggestion:decision('create_new',{product:{name:'Não criar',description:'',brand:''}})});assert.equal(response.status,409);
 assert.equal((await f.call('get','/catalog/ai/inventory?kind=categories&revision='+rev)).status,409);
 // A failed request remains reserved only until release, without modifying the catalogue.
 await f.call('post','/catalog/ai/release',{requestId:ctx.requestId});const current=await context(f,id,'product');
 response=await f.call('post','/catalog/ai/suggestions',{requestId:current.requestId,model:'fixture',suggestion:decision('link_existing',{productId:randomUUID()})});assert.equal(response.status,400);
 const pending=await save(f,current,decision('needs_review'));assert.equal(pending.result.applied,false);assert.equal((await f.db.query('SELECT product_id,product_draft_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_id,null);
 assert.equal((await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=product')).body.items.length,0);
 assert.equal((await f.browser.mutate('post',base+'/ai/suggestions/'+current.requestId+'/discard',{})).status,200);
 assert.equal((await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=product')).body.items.length,1);
});

test('flags independentes, IDs inventados, versão do prompt e campos extras são validados; categorias semelhantes são reaproveitadas',async t=>{
 const f=await catalogFixture(t),id=await seed(f);
 assert.equal((await f.call('post','/catalog/ai/context',{id,task:'product',inventoryRevision:await revision(f)})).status,409);
 await settings(f,{categoryEnabled:false});let ctx=await context(f,id,'product');await settings(f,{categoryEnabled:true});
 const draft=await save(f,ctx,decision('create_new',{product:{name:'Modelo X',description:'',brand:'Marca'}}));const categoryId=await category(f,['Tecnologia','Fones']);
 ctx=await context(f,id,'category');let bad=await f.call('post','/catalog/ai/suggestions',{requestId:ctx.requestId,model:'fixture',suggestion:decision('use_category',{categoryId:randomUUID()})});assert.equal(bad.status,409);
 await save(f,ctx,decision('create_category',{category:'tecnologia > Fone'}));assert.equal((await f.db.query('SELECT confirmed_category_id FROM discovery_links WHERE id=$1',[id])).rows[0].confirmed_category_id,categoryId);
 const other=await seed(f,'Novo modelo');ctx=await context(f,other,'product');await settings(f,{productPrompt:'Novo prompt de produto'});
 bad=await f.call('post','/catalog/ai/suggestions',{requestId:ctx.requestId,model:'fixture',suggestion:decision('needs_review')});assert.equal(bad.status,409);
 bad=await f.call('post','/catalog/ai/suggestions',{requestId:ctx.requestId,model:'fixture',suggestion:decision('needs_review'),token:'não aceito'});assert.equal(bad.status,400);assert.ok(draft.result.applied);
});

test('mudança da identidade extraída invalida rascunho antes da categorização',async t=>{
 const f=await catalogFixture(t);await settings(f);const id=await seed(f),ctx=await context(f,id,'product');
 await save(f,ctx,decision('create_new',{product:{name:'Modelo X',description:'',brand:'Marca'}}));
 await f.db.query("UPDATE discovery_links SET enrichment_data=jsonb_set(enrichment_data,'{title}','\"Outro modelo\"'::jsonb) WHERE id=$1",[id]);
 const row=(await f.db.query('SELECT product_draft_id,product_id FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(row.product_draft_id,null);assert.equal(row.product_id,null);
 assert.equal((await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=product')).body.items.length,1);
});
