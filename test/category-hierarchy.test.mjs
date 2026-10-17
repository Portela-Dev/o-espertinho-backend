import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,identity,client,seedOffer,seedProduct,createApp} from './helpers.mjs';
let db,admin,visitor;
before(async()=>{({db}=await testDatabase());const app=createApp(db,testConfig(),{verifyGoogle:async t=>identity(t)});admin=client(app);visitor=client(app);await admin.login('admin');await visitor.init();});
after(async()=>db.end());
const hierarchy=['Informática','Acessórios','Áudio e vídeo','Fones de ouvido'];
async function create(path,name='Produto hierárquico'){const r=await admin.mutate('post','/api/admin/products',{name,categoryPath:path});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}

test('migration preserva identidades, SKU, links e categorias lembradas, inclusive sem produtos',async()=>{
 const {db:old,pg}=await testDatabase({through:'014_zz'});
 try{const id=await seedProduct(old,{name:'Preservado',category:'Casa',subcategory:'Cozinha'});const link=await seedOffer(old,{productId:id});const previous=(await old.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];await old.query("INSERT INTO offer_category_options(category,subcategory) VALUES('Esportes','Corrida') ON CONFLICT DO NOTHING");
 await pg.exec(await readFile(new URL('../migrations/015_category_hierarchy.sql',import.meta.url),'utf8'));
 const product=(await old.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];assert.equal(product.sku,previous.sku);assert.deepEqual(product.category_path,['Casa','Cozinha']);assert.equal(product.category_ids.length,2);const offer=(await old.query('SELECT * FROM offers WHERE id=$1',[link])).rows[0];assert.equal(offer.product_id,id);assert.deepEqual(offer.category_ids,product.category_ids);assert.equal(offer.price_cents,99990);assert.equal(offer.status,'published');assert.equal((await old.query('SELECT count(*)::int AS total FROM products')).rows[0].total,1);assert.equal((await old.query("SELECT * FROM category_nodes WHERE path=ARRAY['Esportes','Corrida']")).rows.length,1);
 }finally{await old.end();}
});

test('categoria obrigatória, níveis contíguos e limite de dez são validados na API e no banco',async()=>{
 for(const body of [{name:'Sem categoria'},{name:'Vazio',categoryPath:[]},{name:'Raiz vazia',categoryPath:[' ']},{name:'Lacuna',categoryPath:['Casa','','Cozinha']},{name:'Onze',categoryPath:Array.from({length:11},(_,i)=>'Nível '+i)}])assert.equal((await admin.mutate('post','/api/admin/products',body)).status,400);
 const path=Array.from({length:10},(_,i)=>'Profundidade '+(i+1));const p=await create(path);assert.deepEqual(p.category_path,path);assert.equal(new Set(p.category_ids).size,10);
 for(const invalid of [[],[''],['A',null],Array(11).fill('A')])await assert.rejects(()=>db.query('INSERT INTO products(id,name,category,category_path) VALUES($1,$2,$3,$4)',[randomUUID(),'Inválido','X',invalid]));
 assert.equal((await visitor.get('/api/admin/category-tree')).status,401);assert.equal((await admin.agent.post('/api/admin/products').send({name:'X',categoryPath:['Casa']})).status,403);
});

test('produto aparece em todos os ancestrais, sem duplicação por links e sem escapar para ramificações homônimas',async()=>{
 const p=await create(hierarchy,'Fone da árvore');await seedOffer(db,{productId:p.id});await seedOffer(db,{productId:p.id,marketplace:'mercadolivre'});
 const sibling=await create(['Outros ramos','Acessórios','Áudio e vídeo','Fones de ouvido']);await seedOffer(db,{productId:sibling.id});
 const empty=await create([...hierarchy,'Sem links']);
 for(const categoryId of p.category_ids){const r=await visitor.get('/api/products?categoryId='+categoryId);assert.equal(r.status,200);assert.deepEqual(r.body.items.map(x=>x.id),[p.id]);assert.equal(r.body.items[0].offer_count,2);assert.equal('sku' in r.body.items[0],false);assert.equal((await visitor.get('/api/offers?categoryId='+categoryId)).body.total,2);}
 assert.equal((await visitor.get('/api/products?categoryId='+p.category_ids[0]+'&maxPrice=100')).body.total,0);
 assert.equal((await visitor.get('/api/products?categoryId='+randomUUID())).body.total,0);assert.equal((await visitor.get('/api/products?categoryId=invalid')).status,400);
 const tree=(await visitor.get('/api/category-tree')).body;for(let i=0;i<hierarchy.length;i++)assert.deepEqual(tree.find(n=>n.id===p.category_ids[i]).path,hierarchy.slice(0,i+1));assert.ok(tree.some(n=>n.id===empty.category_ids.at(-1)));assert.equal((await visitor.get('/api/products/'+empty.id)).body.available,false);
 const saved=await admin.mutate('post','/api/me/filters',{name:'Fones',filters:{categoryId:p.category_ids.at(-1)}});assert.equal(saved.status,201);assert.equal(saved.body.filters.categoryId,p.category_ids.at(-1));
});

test('combos reutilizam nomes por ramificação e edição propaga todos os níveis e atualiza a vitrine',async()=>{
 const first=await create(['Equipamentos','  Áudio   profissional ','Fones']);const same=await create(['equipamentos','áudio profissional','fones']);assert.deepEqual(first.category_ids,same.category_ids);assert.deepEqual(same.category_path,['Equipamentos','Áudio profissional','Fones']);
 const other=await create(['Outra raiz','Áudio profissional','Fones']);assert.notEqual(other.category_ids[2],first.category_ids[2]);
 const link=await seedOffer(db,{productId:first.id});const r=await admin.mutate('put','/api/admin/products/'+first.id,{name:first.name,categoryPath:['Equipamentos','Conexões','Cabos','USB'],expectedUpdatedAt:first.updated_at});assert.equal(r.status,200);const o=(await db.query('SELECT * FROM offers WHERE id=$1',[link])).rows[0];assert.deepEqual(o.category_path,r.body.category_path);assert.deepEqual(o.category_ids,r.body.category_ids);assert.equal(o.status,'published');assert.equal(o.price_cents,99990);
 assert.equal((await visitor.get('/api/products?categoryId='+first.category_ids[1])).body.total,0);assert.equal((await visitor.get('/api/products?categoryId='+r.body.category_ids[1])).body.total,1);
 assert.equal((await admin.mutate('put','/api/admin/products/'+first.id,{name:first.name,categoryPath:['X'],expectedUpdatedAt:first.updated_at})).status,409);
 const tree=(await admin.get('/api/admin/category-tree')).body;assert.equal(tree.filter(n=>JSON.stringify(n.path)===JSON.stringify(first.category_path)).length,1);
 await db.query("UPDATE offers SET category_path=ARRAY['Falsa'],category_ids=ARRAY[$2]::uuid[] WHERE id=$1",[link,randomUUID()]);assert.deepEqual((await db.query('SELECT category_path FROM offers WHERE id=$1',[link])).rows[0].category_path,r.body.category_path);
});
