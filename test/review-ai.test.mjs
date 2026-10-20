import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
const base='/api/admin/discovery/enrichment';
async function seed(f){const id=randomUUID();await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,extraction_status,enrichment_data,source_category_path) VALUES($1,'amazon',$2,'completed',$3,ARRAY['Tecnologia','Áudio'])",[id,'https://www.amazon.com.br/p/'+id,JSON.stringify({title:'Headset Modelo X',brand:'Marca',description:'Descrição',images:['https://example.com/image.jpg']})]);return id;}
async function settings(f,changes={}){const current=(await f.browser.get(base+'/ai/settings')).body;const r=await f.browser.mutate('put',base+'/ai/settings',{...current,categoryEnabled:true,productEnabled:true,...changes});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
const suggestion=(category,changes={})=>({action:'needs_review',category,productId:null,product:null,reason:'Mesmo modelo e árvore adequada.',...changes});

test('IA salva apenas sugestões; categoria e produto só mudam com confirmação administrativa',async t=>{
 const f=await catalogFixture(t),id=await seed(f);await settings(f);
 const category=(await f.db.query("SELECT ids FROM register_category_path(ARRAY['Tecnologia','Áudio'])")).rows[0].ids.at(-1);
 let queue=await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=category');assert.equal(queue.status,200,JSON.stringify(queue.body));assert.equal(queue.body.items[0].id,id);
 const context=await f.call('post','/catalog/ai/context',{id,task:'category'});assert.equal(context.status,200,JSON.stringify(context.body));assert.ok(context.body.categories.includes('Tecnologia > Áudio'));
 const result=await f.call('post','/catalog/ai/suggestions',{requestId:context.body.requestId,model:'fixture',suggestion:suggestion('Tecnologia > Áudio')});assert.equal(result.status,200,JSON.stringify(result.body));
 let link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(link.confirmed_category_id,null);assert.equal(link.product_id,null);
 await settings(f,{productEnabled:false});
 const review=await f.browser.get(base+'/review');assert.equal(review.body.items[0].ai_category.categoryId,category);await settings(f);
 assert.equal((await f.call('get','/catalog/ai/queue?marketplaceId=amazon&task=category')).body.items.length,0);
 let confirmation=await f.browser.mutate('post',base+'/review/'+id+'/category',{categoryId:category,version:link.enrichment_version});assert.equal(confirmation.status,200,JSON.stringify(confirmation.body));
 const existing=randomUUID();await f.db.query("INSERT INTO products(id,name,brand,category_path) VALUES($1,'Headset Modelo X','Marca',ARRAY['Tecnologia','Áudio'])",[existing]);
 const productContext=await f.call('post','/catalog/ai/context',{id,task:'product'});assert.equal(productContext.status,200,JSON.stringify(productContext.body));assert.equal(productContext.body.products[0].id,existing);
 const p=await f.call('post','/catalog/ai/suggestions',{requestId:productContext.body.requestId,model:'fixture',suggestion:suggestion('Tecnologia > Áudio',{action:'link_existing',productId:existing})});assert.equal(p.status,200,JSON.stringify(p.body));
 link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];assert.equal(link.product_id,null);assert.equal((await f.browser.get(base+'/review')).body.items[0].ai_product.matchedProduct.name,'Headset Modelo X');
 confirmation=await f.browser.mutate('post',base+'/review/'+id+'/product',{mode:'existing',version:link.enrichment_version,productId:existing});assert.equal(confirmation.status,200,JSON.stringify(confirmation.body));
 assert.equal((await f.db.query('SELECT product_id FROM discovery_links WHERE id=$1',[id])).rows[0].product_id,existing);
 const config=(await f.call('get','/catalog/ai/config?marketplaceId=amazon')).body;assert.deepEqual(config.category,{completed:1,total:1});assert.deepEqual(config.product,{completed:1,total:1});
});

test('flags independentes, exclusividade, configurações e dados obsoletos bloqueiam respostas; criação exige confirmação',async t=>{
 const f=await catalogFixture(t),id=await seed(f);
 assert.equal((await f.call('post','/catalog/ai/context',{id,task:'category'})).status,409);
 await settings(f,{productEnabled:false});let context=(await f.call('post','/catalog/ai/context',{id,task:'category'})).body;
 assert.equal((await f.call('post','/catalog/ai/context',{id,task:'category'})).status,409);
 await settings(f,{productEnabled:false,categoryPrompt:'Instrução alterada'});
 let save=await f.call('post','/catalog/ai/suggestions',{requestId:context.requestId,model:'fixture',suggestion:suggestion('Nova > Árvore')});assert.equal(save.status,409);
 context=(await f.call('post','/catalog/ai/context',{id,task:'category'})).body;
 save=await f.call('post','/catalog/ai/suggestions',{requestId:context.requestId,model:'fixture',suggestion:suggestion('Nova > Árvore')});assert.equal(save.status,200,JSON.stringify(save.body));
 assert.equal((await f.db.query("SELECT id FROM category_nodes WHERE path=ARRAY['Nova','Árvore']")).rows.length,0);
 assert.equal((await f.call('post','/catalog/ai/context',{id,task:'product'})).status,409);
 const category=(await f.db.query("SELECT ids FROM register_category_path(ARRAY['Tecnologia','Áudio'])")).rows[0].ids.at(-1);let link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];
 await f.browser.mutate('post',base+'/review/'+id+'/category',{categoryId:category,version:link.enrichment_version});await settings(f);
 context=(await f.call('post','/catalog/ai/context',{id,task:'product'})).body;
 save=await f.call('post','/catalog/ai/suggestions',{requestId:context.requestId,model:'fixture',suggestion:suggestion('Tecnologia > Áudio',{action:'link_existing',productId:randomUUID()})});assert.equal(save.status,400);
 const proposed=suggestion('Tecnologia > Áudio',{action:'create_new',product:{name:'Modelo X',brand:'Marca',description:'Descrição'}});
 save=await f.call('post','/catalog/ai/suggestions',{requestId:context.requestId,model:'fixture',suggestion:proposed,token:'not-accepted'});assert.equal(save.status,400);
 const before=(await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n;
 save=await f.call('post','/catalog/ai/suggestions',{requestId:context.requestId,model:'fixture',suggestion:proposed});assert.equal(save.status,200,JSON.stringify(save.body));
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,before);
 link=(await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];const confirmed=await f.browser.mutate('post',base+'/review/'+id+'/product',{mode:'new',version:link.enrichment_version,product:{...proposed.product,imageUrl:'https://example.com/image.jpg'}});assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,before+1);
});
