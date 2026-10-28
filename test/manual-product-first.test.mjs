import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {client,createApp,identity,testConfig,seedProduct} from './helpers.mjs';
const base='/api/admin/discovery/enrichment';
const details={name:'Identidade manual revisada',description:'Descrição revisada',brand:'Marca revisada',imageUrl:'https://images.example.com/manual.jpg'};
async function fixture(t){
 const f=await catalogFixture(t);
 await f.db.query("INSERT INTO scraping_profiles(marketplace_id,rules) VALUES('amazon',$1) ON CONFLICT DO NOTHING",[JSON.stringify([{field:'title',selectors:['h1']},{field:'price',selectors:['.price']}])]);
 const registered=(await f.db.query('SELECT ids FROM register_category_path($1::text[])',[['Tecnologia','Áudio']])).rows[0];
 return {...f,category:registered.ids.at(-1)};
}
async function addLink(f,resolution={}){
 const id=randomUUID(),url='https://www.amazon.com.br/p/'+id;
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,extracted_at,ai_resolution) VALUES($1,'amazon',$2,$3,'completed',$4,now(),$5)",[id,url,url+'?tag=test-20',JSON.stringify({title:'Oferta de teste',priceCents:32100,availability:'available',missing:[],images:[],description:'Descrição',brand:'Marca',specifications:[],conditions:''}),JSON.stringify(resolution)]);return id;
}
async function getLink(f,id){return (await f.db.query('SELECT * FROM discovery_links WHERE id=$1',[id])).rows[0];}
async function total(f,table){return (await f.db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n;}
test('rascunhos existentes aparecem somente em aguardando categoria e se resolvem sem recatalogar',async t=>{
 const f=await fixture(t),raw=await addLink(f),first=await addLink(f),second=await addLink(f),draft=randomUUID();
 await f.db.query("INSERT INTO review_ai_product_drafts(id,identity_key,name) VALUES($1,$2,'Identidade existente')",[draft,'test:'+draft]);
 await f.db.query('UPDATE discovery_links SET product_draft_id=$2 WHERE id=ANY($1::uuid[])',[[first,second],draft]);
 const products=(await f.browser.get(base+'/review?state=awaiting_product')).body;
 const categories=(await f.browser.get(base+'/review?state=awaiting_category')).body;
 assert.equal(products.total,1);assert.equal(products.items[0].id,raw);assert.equal(categories.total,2);assert.deepEqual(new Set(categories.items.map(row=>row.id)),new Set([first,second]));
 assert.equal((await f.browser.mutate('post',base+'/review/'+first+'/category',{categoryId:f.category,version:0})).status,200);
 assert.equal((await f.browser.get(base+'/review?state=awaiting_category')).body.total,0);
 assert.equal((await f.browser.get(base+'/review?state=ready')).body.total,2);assert.equal(await total(f,'products'),1);
});
test('catálogo manual aceita rascunho sem categoria, confirma categoria depois e só publica explicitamente',async t=>{
 const f=await fixture(t),id=await addLink(f,{product:{action:'needs_review',reason:'Identidade depende de revisão'}}),path=base+'/review/'+id;
 const response=await f.browser.mutate('post',path+'/product',{mode:'new',version:0,product:details});assert.equal(response.status,200,JSON.stringify(response.body));
 assert.equal(response.body.status,'awaiting_category');assert.equal(response.body.link.product_id,null);assert.equal(response.body.link.product_draft_id,response.body.draft.id);assert.equal(response.body.link.enrichment_version,1);
 for(const key of ['name','description','brand'])assert.equal(response.body.draft[key],details[key]);assert.equal(response.body.draft.image_url,details.imageUrl);
 assert.equal(await total(f,'products'),0);assert.equal(await total(f,'offers'),0);assert.equal((await f.browser.get(base+'/review?state=awaiting_product')).body.total,0);assert.equal((await f.browser.get(base+'/review?state=awaiting_category')).body.total,1);
 assert.equal((await f.browser.mutate('post',path+'/product',{mode:'new',version:0,product:details})).status,409);assert.equal(await total(f,'review_ai_product_drafts'),1);
 assert.equal((await f.browser.mutate('post',path+'/publish',{version:1,authorizedContent:true})).status,409);
 assert.equal((await f.browser.mutate('post',path+'/category',{categoryId:f.category,version:1})).status,200);
 const row=await getLink(f,id);assert.ok(row.product_id);assert.equal(row.product_draft_id,null);assert.equal(row.confirmed_category_id,f.category);assert.equal(await total(f,'products'),1);assert.equal(await total(f,'offers'),0);
 const product=(await f.db.query('SELECT * FROM products WHERE id=$1',[row.product_id])).rows[0];assert.deepEqual(product.category_path,['Tecnologia','Áudio']);assert.equal(product.image_url,details.imageUrl);assert.equal(product.description,details.description);assert.equal((await f.browser.get(base+'/review?state=ready')).body.total,1);
 assert.equal((await f.browser.mutate('post',path+'/publish',{version:row.enrichment_version,authorizedContent:true})).status,200);assert.equal(await total(f,'offers'),1);
});
test('revisão inválida pode criar rascunho manual sem categoria e não reaproveita outro produto por nome',async t=>{
 const f=await fixture(t),existing=await seedProduct(f.db,{name:details.name,category:'Casa'});await f.db.query('UPDATE products SET brand=$2 WHERE id=$1',[existing,details.brand]);
 const id=await addLink(f,{product:{action:'invalid',reason:'Conflito'},category:{action:'invalid',reason:'Conflito'}}),path=base+'/review/'+id;
 const created=await f.browser.mutate('post',path+'/product',{mode:'new',version:0,product:details});assert.equal(created.status,200);assert.equal(created.body.link.ai_resolution.product.action,'manual_confirmed');assert.equal(created.body.link.ai_resolution.category.action,'manual_confirmed');assert.equal(created.body.link.product_id,null);
 assert.equal((await f.browser.get(base+'/review?state=awaiting_category')).body.total,1);
 assert.equal((await f.browser.mutate('post',path+'/category',{categoryId:f.category,version:created.body.link.enrichment_version})).status,200);assert.notEqual((await getLink(f,id)).product_id,existing);assert.equal(await total(f,'products'),2);
});
test('rascunho mantém validação, permissão, XSRF e controle de versão',async t=>{
 const f=await fixture(t),id=await addLink(f),path=base+'/review/'+id+'/product',body={mode:'new',version:0,product:details};
 const other=client(f.app);await other.login('alice');assert.equal((await other.mutate('post',path,body)).status,403);assert.equal((await f.browser.agent.post(path).send(body)).status,403);
 for(const product of [{...details,name:''},{...details,imageUrl:'http://images.example.com/x'},{...details,imageUrl:'https://127.0.0.1/x'}])assert.equal((await f.browser.mutate('post',path,{...body,product})).status,400);
 assert.equal((await f.browser.mutate('post',path,{...body,version:10})).status,409);assert.equal(await total(f,'review_ai_product_drafts'),0);assert.equal((await getLink(f,id)).enrichment_version,0);
});
test('falha de auditoria desfaz rascunho, vínculo e substituição da decisão inválida',async t=>{
 const f=await fixture(t),id=await addLink(f,{product:{action:'invalid',reason:'Conflito'}});
 const badDb={...f.db,connect:async()=>{const c=await f.db.connect();return {...c,query:async(sql,args)=>{if(sql.startsWith('INSERT INTO audit_logs')&&args[2]==='discovery.product.drafted')throw Error('Audit unavailable');return c.query(sql,args);}};}};
 const app=createApp(badDb,testConfig(),{verifyGoogle:async token=>identity(token)}),browser=client(app);await browser.login('admin');
 assert.equal((await browser.mutate('post',base+'/review/'+id+'/product',{mode:'new',version:0,product:details})).status,500);
 const row=await getLink(f,id);assert.equal(row.product_draft_id,null);assert.equal(row.enrichment_version,0);assert.equal(row.ai_resolution.product.action,'invalid');assert.equal(await total(f,'review_ai_product_drafts'),0);assert.equal(await total(f,'products'),0);
});
