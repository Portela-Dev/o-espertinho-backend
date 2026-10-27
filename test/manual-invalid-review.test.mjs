import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedProduct,client} from './helpers.mjs';
const base='/api/admin/discovery/enrichment';
const verdict={action:'invalid',reason:'Informações conflitantes.',automatic:false};
async function setup(t){
 const f=await catalogFixture(t);const product=await seedProduct(f.db,{name:'Produto revisado',category:'Tecnologia'});
 const category=(await f.db.query('SELECT category_ids FROM products WHERE id=$1',[product])).rows[0].category_ids.at(-1);
 await f.db.query("INSERT INTO scraping_profiles(marketplace_id,rules) VALUES('amazon',$1) ON CONFLICT(marketplace_id) DO NOTHING",[JSON.stringify([{field:'title',selectors:['h1']},{field:'price',selectors:['.price']}])]);
 return {...f,product,category};
}
async function link(f,resolution={product:verdict,category:verdict}){
 const id=randomUUID(),url='https://www.amazon.com.br/product/'+id;
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,ai_resolution,extracted_at) VALUES($1,'amazon',$2,$3,'completed',$4,$5,clock_timestamp())",[id,url,url+'?tag=test-20',JSON.stringify({title:'Produto extraído',priceCents:12345,availability:'available',missing:[],images:[],description:'Descrição',brand:'Marca',specifications:[],conditions:''}),JSON.stringify(resolution)]);return id;
}
async function row(f,id){return (await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];}
async function reviewed(f,id,previous,task){
 const current=await row(f,id);for(const key of ['product','category'])if(previous[key]?.action==='invalid'){
  assert.equal(current.ai_resolution[key].action,'manual_confirmed');assert.equal(current.ai_resolution[key].automatic,false);assert.equal(current.ai_resolution[key].confirmedTask,task);assert.deepEqual(current.ai_resolution[key].previousDecision,previous[key]);assert.ok(current.ai_resolution[key].reviewedBy);assert.ok(current.ai_resolution[key].reviewedAt);
 }
 assert.equal(current.enrichment_version,1);assert.equal(current.published_offer_id,null);
 assert.equal((await f.browser.get(base+'/review?state=invalid')).body.items.some(r=>r.id===id),false);
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='discovery.invalid.overridden' AND entity_id=$1",[id])).rows[0].n,1);
 return current;
}
test('manual assignment overrides either invalid verdict, preserves history and makes complete offers ready without publishing',async t=>{
 const f=await setup(t);
 for(const resolution of [{product:verdict},{category:verdict},{product:verdict,category:verdict}]){
  const id=await link(f,resolution);assert.equal((await f.browser.get(base+'/review/'+id+'/products')).status,200);
  const result=await f.browser.mutate('post',base+'/review/'+id+'/product',{mode:'existing',productId:f.product,version:0});assert.equal(result.status,200,JSON.stringify(result.body));
  await reviewed(f,id,resolution,'product');
  assert.equal((await f.browser.get(base+'/review?state=ready')).body.items.some(r=>r.id===id),true);
  assert.equal((await f.browser.mutate('post',base+'/review/'+id+'/product',{mode:'existing',productId:f.product,version:0})).status,409);
 }
 assert.equal((await f.db.query('SELECT count(*)::int n FROM offers')).rows[0].n,0);
});
test('manual category overrides invalid AI and finalizes a shared draft without clearing other invalid links',async t=>{
 const f=await setup(t),id=await link(f),other=await link(f),draft=randomUUID();
 await f.db.query("INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand) VALUES($1,$2,'Novo produto revisado','','Marca')",[draft,'manual-'+draft]);
 await f.db.query('UPDATE discovery_links SET product_draft_id=$2 WHERE id=ANY($1::uuid[])',[[id,other],draft]);
 const result=await f.browser.mutate('post',base+'/review/'+id+'/category',{categoryId:f.category,version:0});assert.equal(result.status,200,JSON.stringify(result.body));
 const current=await reviewed(f,id,{product:verdict,category:verdict},'category');assert.ok(current.product_id);assert.equal(current.confirmed_category_id,f.category);assert.equal((await row(f,other)).ai_resolution.product.action,'invalid');assert.equal((await row(f,other)).product_id,null);
 assert.equal((await f.browser.get(base+'/review?state=ready')).body.items.some(r=>r.id===id),true);
});
test('manual category without a product remains pending; failed or unauthorized edits do not clear invalidity',async t=>{
 const f=await setup(t),id=await link(f),normal=client(f.app);await normal.login('alice');
 const path=base+'/review/'+id;
 assert.equal((await normal.mutate('post',path+'/category',{categoryId:f.category,version:0})).status,403);
 assert.equal((await f.browser.agent.post(path+'/category').send({categoryId:f.category,version:0})).status,403);
 for(const body of [{categoryId:randomUUID(),version:0},{categoryId:f.category,version:9}])assert.ok([400,409].includes((await f.browser.mutate('post',path+'/category',body)).status));
 assert.equal((await f.browser.mutate('post',path+'/product',{mode:'existing',productId:randomUUID(),version:0})).status,404);
 assert.equal((await row(f,id)).ai_resolution.product.action,'invalid');
 const result=await f.browser.mutate('post',path+'/category',{categoryId:f.category,version:0});assert.equal(result.status,200,JSON.stringify(result.body));await reviewed(f,id,{product:verdict,category:verdict},'category');
 assert.equal((await f.browser.get(base+'/review?state=awaiting_product')).body.items.some(r=>r.id===id),true);
 assert.equal((await f.browser.mutate('post',path+'/publish',{version:1,authorizedContent:true})).status,409);
 const created=await f.browser.mutate('post',path+'/product',{mode:'new',version:1,product:{name:'Produto manual',description:'',brand:'',imageUrl:null}});assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal((await f.browser.get(base+'/review?state=ready')).body.items.some(r=>r.id===id),true);
});


test('creating a product manually also overrides invalidity and allows a separate explicit publication',async t=>{
 const f=await setup(t),id=await link(f,{product:verdict});
 await f.db.query('UPDATE discovery_links SET confirmed_category_id=$2 WHERE id=$1',[id,f.category]);
 const created=await f.browser.mutate('post',base+'/review/'+id+'/product',{mode:'new',version:0,product:{name:'Produto corrigido manualmente',description:'Descrição revisada',brand:'Marca',imageUrl:null}});assert.equal(created.status,200,JSON.stringify(created.body));
 await reviewed(f,id,{product:verdict},'product');assert.equal((await f.db.query('SELECT count(*)::int n FROM offers')).rows[0].n,0);
 const published=await f.browser.mutate('post',base+'/review/'+id+'/publish',{version:1,authorizedContent:true});assert.equal(published.status,200,JSON.stringify(published.body));assert.ok(published.body.offerId);
});
