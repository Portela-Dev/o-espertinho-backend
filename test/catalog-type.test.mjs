import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogFixture } from './catalog-helpers.mjs';
import { catalogIdentity, titleProvesIdentity } from '../dist/catalog-type.js';
import { defaultPolicies, sourceData, deterministicIdentity } from '../dist/catalog-identity.js';
const definition={name:'Câmeras digitais',terms:['Câmera Digital'],attributes:[
 {key:'model',label:'Modelo',required:true,aliases:['modelo'],unit:'text',values:{}},
 {key:'resolution',label:'Resolução',required:true,aliases:['resolução'],unit:'text',values:{}}
],exclusive:false,categoryId:null,priority:0};
const offer={title:'Câmera Digital Lumen C100 24 MP',brand:'Lumen',description:'Câmera para fotografia.',specifications:[],images:[],priceCents:15000,availability:'available'};
const facts={model:{value:'C100',evidence:'C100'},resolution:{value:'24 MP',evidence:'24 MP'}};
const typeDecision={policyId:null,policy:definition,facts,name:offer.title,reason:'Câmera identificada pelo título'};
const api='/catalog/resolver';
async function active(f) {await f.db.query("UPDATE review_ai_settings SET product_enabled=true,category_enabled=true");await f.db.query("UPDATE catalog_resolver_settings SET mode='active'");}
async function seed(f,market='amazon',data=offer) {
 const id=randomUUID();await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data) VALUES($1,$2,$3,$3,'completed',$4)",[id,market,'https://example.com/'+id,JSON.stringify(data)]);return id;
}
async function start(f,task='product',marketplaceId='amazon') {
 await f.db.query("UPDATE review_ai_settings SET product_enabled=true,category_enabled=true");
 const r=await f.call('post',api+'/start',{marketplaceId,task,limit:100,requestKey:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
async function claim(f,run) {const r=await f.call('post',api+'/claim',{runId:run.id});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function complete(f,run,item,decision) {
 const r=await f.call('post',api+'/complete',{runId:run.id,itemId:item.id,leaseId:item.leaseId,decision,model:'fixture'});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
test('IA cria tipo sem política e cataloga/categoriza; outro marketplace reutiliza o tipo e produto',async t=>{
 const f=await catalogFixture(t);await active(f);
 const link=await seed(f),run=await start(f),first=await claim(f,run);assert.equal(first.item.context.stage,'type');assert.equal(first.run.stats.excluded,0);
 const done=await complete(f,run,first.item,typeDecision);assert.equal(done.outcome,'drafted');assert.ok(done.identity.fingerprint);assert.equal(done.identity.partial,false);
 assert.equal((await claim(f,run)).run.status,'completed');
 const policy=(await f.db.query("SELECT * FROM catalog_identity_policies WHERE definition->>'name'=$1",[definition.name])).rows[0];assert.ok(policy.id.startsWith('ai-'));
 const cats=await start(f,'category'),c=await claim(f,cats);await complete(f,cats,c.item,{categoryId:null,path:['Fotografia','Câmeras digitais'],reason:'Tipo do produto'});await claim(f,cats);
 const product=(await f.db.query('SELECT product_id,confirmed_category_id FROM discovery_links WHERE id=$1',[link])).rows[0];assert.ok(product.product_id);assert.ok(product.confirmed_category_id);
 const fingerprint=(await f.db.query('SELECT fingerprint FROM catalog_product_identities WHERE product_id=$1',[product.product_id])).rows[0].fingerprint;
 await f.call('post',api+'/prepare',{});assert.equal((await f.db.query('SELECT fingerprint FROM catalog_product_identities WHERE product_id=$1',[product.product_id])).rows[0].fingerprint,fingerprint);
 await f.db.query("INSERT INTO marketplaces(id,name) VALUES('market-b','Outro marketplace')");const second=await seed(f,'market-b'),r2=await start(f,'product','market-b'),i2=await claim(f,r2);
 assert.equal(i2.item.context.stage,'identity');assert.equal(i2.item.context.policy.id,policy.id);
 const linked=await complete(f,r2,i2.item,{policyId:policy.id,facts,name:offer.title,reason:'Mesma identidade'});assert.equal(linked.productId,product.product_id);
 assert.equal((await f.db.query('SELECT product_id FROM discovery_links WHERE id=$1',[second])).rows[0].product_id,product.product_id);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,1);
});
test('simulação identifica tipo novo sem persistir política, produto ou categoria',async t=>{
 const f=await catalogFixture(t);await seed(f);const run=await start(f),first=await claim(f,run),done=await complete(f,run,first.item,typeDecision);assert.equal(done.applied,false);assert.equal(done.outcome,'drafted');await claim(f,run);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM catalog_identity_policies')).rows[0].n,3);
 const cats=await start(f,'category'),c=await claim(f,cats);const result=await complete(f,cats,c.item,{categoryId:null,path:['Fotografia'],reason:'Título'});assert.equal(result.applied,false);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,0);
});
test('nova política não reenfileira todo o catálogo e uma alteração afeta só produtos daquele tipo',async t=>{
 const f=await catalogFixture(t);await active(f);await f.db.query("INSERT INTO products(id,name,category_path) VALUES($1,'Produto antigo',ARRAY['Casa'])",[randomUUID()]);await f.call('post',api+'/prepare',{});
 await seed(f);const run=await start(f),i=await claim(f,run);await complete(f,run,i.item,typeDecision);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM catalog_identity_pending')).rows[0].n,0);
});
test('política inválida não fica órfã e a oferta é catalogada por título',async t=>{
 const f=await catalogFixture(t);await active(f);await seed(f);const run=await start(f),first=await claim(f,run);
 const result=await complete(f,run,first.item,{...typeDecision,policy:{...definition,attributes:[]}});
 assert.equal(result.outcome,'drafted');assert.equal(result.fallback.diagnostic,'invalid_response');
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM catalog_identity_policies WHERE definition->>'name'=$1",[definition.name])).rows[0].n,0);
 assert.ok((await f.db.query('SELECT product_draft_id FROM discovery_links')).rows[0].product_draft_id);
});

test('título tem prioridade: dados ausentes geram identidade sem inventar RAM ou marca',()=>{
 const policy=defaultPolicies.find(p=>p.id==='smartphone'),source=sourceData({title:'Celular Modelo A28 128 GB',brand:'',description:'Modelo A28B 256 GB',specifications:[]});
 const identity=catalogIdentity({policyId:'smartphone',facts:{model:{value:'A28',evidence:'A28'},storage:{value:'128 GB',evidence:'128 GB'}},name:'Celular Modelo A28 128 GB',reason:'Título prioritário'},source,policy,'link');
 assert.equal(identity.partial,true);assert.equal(identity.attrs.storage,'128');assert.equal(identity.attrs.brand,undefined);assert.equal(identity.attrs.ram,undefined);assert.ok(identity.fingerprint);
 const wrong=deterministicIdentity(sourceData({...source,brand:'Marca',specifications:[{name:'Modelo',value:'A28B'},{name:'Armazenamento',value:'256 GB'},{name:'RAM',value:'8 GB'}]}),policy);
 assert.equal(titleProvesIdentity(wrong,source),false);
});
test('resposta antiga de exclusão não gera estado negativo nem bloqueia o cadastro',()=>{
 const p=defaultPolicies.find(p=>p.id==='smartphone');const value=catalogIdentity({policyId:p.id,facts:{},exclude:true,reason:'Dados ausentes'},sourceData({title:'Celular sem especificações'}),p,'link');assert.ok(value.fingerprint);assert.equal(value.exclude,false);
});
test('política equivalente por nome é reutilizada sem sobrescrever a regra já cadastrada',async t=>{
 const f=await catalogFixture(t);await active(f);await seed(f);const run=await start(f),{item}=await claim(f,run);
 const result=await complete(f,run,item,{...typeDecision,policy:{...definition,name:'smartphones'}});
 assert.equal(result.identity.policyId,'smartphone');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM catalog_identity_policies')).rows[0].n,3);
 const policy=(await f.db.query("SELECT definition FROM catalog_identity_policies WHERE id='smartphone'")).rows[0].definition;
 assert.equal(policy.name,'Smartphones');assert.ok(policy.attributes.some(a=>a.key==='ram'));
});
test('comparação limitada reutiliza rascunhos recém-criados antes da categorização',async t=>{
 const f=await catalogFixture(t);await active(f);
 const data={...offer,title:'Celular Modelo X Azul',brand:'',description:'',specifications:[]};
 await seed(f,'amazon',data);const run=await start(f),first=await claim(f,run);
 const one=await complete(f,run,first.item,{policyId:'smartphone',facts:{model:{value:'Modelo X',evidence:'Modelo X'}},name:'Celular Modelo X',reason:'Título'});await claim(f,run);
 await seed(f,'amazon',{...data,title:'Modelo X Celular Preto'});const secondRun=await start(f),second=await claim(f,secondRun);
 const two=await complete(f,secondRun,second.item,{policyId:'smartphone',facts:{model:{value:'Modelo X',evidence:'Modelo X'}},name:'Modelo X Celular',reason:'Título'});assert.equal(two.outcome,'matching');
 const matching=await claim(f,secondRun);const candidate=matching.item.context.candidates.find(p=>p.id===one.draftId);assert.equal(candidate.kind,'draft');
 const chosen=await complete(f,secondRun,matching.item,{productId:one.draftId,reason:'Mesmo modelo, cor não diferencia'});assert.equal(chosen.draftId,one.draftId);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM review_ai_product_drafts')).rows[0].n,1);
});
