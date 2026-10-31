import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, link, drive } from './catalog-complete-helpers.mjs';
import { catalogFixture } from './catalog-helpers.mjs';
import { fallbackMatch, fallbackCategory, fallbackTitle } from '../dist/catalog-fallback.js';

test('alternativa distingue modelos e capacidades e reutiliza títulos equivalentes', () => {
  const choose = title => fallbackMatch({ offer: { title }, candidates: [{ id: 'a', title: 'Apple iPhone 12 128GB' }] }).productId;
  assert.equal(choose('Apple iPhone 12 128GB'), 'a');
  for (const title of ['Apple iPhone 13 128GB', 'Apple iPhone 12 256GB', 'Apple iPhone 12 Pro 128GB', 'Produto sem relação']) assert.equal(choose(title), null);
  assert.equal(fallbackTitle({url:'https://shop.test/Produto-sem-titulo?tracking=secret'}), 'Produto sem titulo');
  assert.equal(fallbackTitle({url:'bad'}), 'Produto da oferta');
  assert.equal(fallbackCategory({offer:{sourceCategory:'Eletrônicos > Fones'},categories:[{id:'a',path:['Eletronicos','Fones']}]}).categoryId, 'a');
  assert.deepEqual(fallbackCategory({offer:{},categories:[]}).path, ['Outros']);
  assert.equal(fallbackCategory({offer:{},mappedCategoryId:'a',categories:[{id:'a',path:['Áudio']}]}).categoryId,'a');
});
test('todos os links são catalogados e categorizados quando a IA falha sempre; replay não duplica e publicação continua manual',async t=>{
  const f=await catalogFixture(t); await setup(f);
  const cases=[
    {title:'Câmera Nova C100'}, {title:'Kit personalizado 2 câmeras'},
    {title:'Celular Modelo X 128GB',description:'Modelo Z 256GB'},
    {title:'Acessório sem marca'}, {}, {title:'Produto sem atributos',specifications:null,images:null},
  ];
  for(const data of cases) await link(f,data,{path:['Tecnologia','Diversos']});
  await link(f,{title:'Outro produto sem extração concluída'},{status:'failed'});
  const failure=()=>({error:'technical',errorCode:'analysis_failed',diagnostic:'invalid_response'});
  const products=await drive(f,'product',failure);
  assert.equal(products.stats.accepted,7);assert.equal(products.stats.failed,0);
  const categories=await drive(f,'category',failure);
  assert.equal(categories.stats.accepted,7);assert.equal(categories.stats.failed,0);
  const rows=(await f.db.query('SELECT * FROM discovery_links')).rows;
  for(const row of rows){assert.ok(row.product_id);assert.ok(row.confirmed_category_id);assert.equal(row.published_offer_id,null);assert.deepEqual(row.ai_resolution,{});}
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offers')).rows[0].n,0);
});
test('respostas de invalidação, política malformada e categoria vazia são substituídas por decisões completas',async t=>{
  const f=await catalogFixture(t);await setup(f);
  await link(f,{title:'Produto de tipo desconhecido'});
  const products=await drive(f,'product',()=>({decision:{action:'invalid',reason:'Sem informações'}}));
  assert.equal(products.stats.accepted,1);assert.equal(products.stats.fallback,1);
  const categories=await drive(f,'category',()=>({decision:{categoryId:null,path:[],reason:''}}));
  assert.equal(categories.stats.accepted,1);
  assert.deepEqual((await f.db.query('SELECT category_path FROM products')).rows[0].category_path,['Outros']);
});
test('títulos iguais compartilham rascunho e produto; kits preservam identidade própria',async t=>{
  const f=await catalogFixture(t);await setup(f);
  for(const title of ['Câmera Lumen C100','Câmera Lumen C100','Kit 2 câmeras','Kit 2 câmeras']) await link(f,{title});
  await drive(f,'product',()=>({error:'technical'}));
  const draftCount=(await f.db.query('SELECT count(*)::int AS n FROM review_ai_product_drafts')).rows[0].n;
  assert.equal(draftCount,3);
  await drive(f,'category',()=>({error:'technical'}));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,3);
});
