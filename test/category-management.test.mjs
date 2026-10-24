import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,client,createApp,identity,seedOffer} from './helpers.mjs';
let db,admin,user,app;
const base='/api/admin/categories';
before(async()=>{({db}=await testDatabase());app=createApp(db,testConfig(),{verifyGoogle:async t=>identity(t)});admin=client(app);user=client(app);await admin.login('admin');await user.login('member');});
after(async()=>db.end());
async function product(path){const r=await admin.mutate('post','/api/admin/products',{name:'Produto '+randomUUID(),categoryPath:path});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
async function preview(input){const r=await admin.mutate('post',base+'/preview',input);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function apply(input){const p=await preview(input),r=await admin.mutate('post',base+'/apply',{...input,revision:p.revision,confirm:true});assert.equal(r.status,200,JSON.stringify(r.body));return p;}
async function current(id){return (await db.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];}
async function references(p){
 const link=randomUUID(),mapping=randomUUID(),filter=randomUUID();
 await db.query("INSERT INTO discovery_links(id,marketplace_id,url,confirmed_category_id) VALUES($1,'amazon',$2,$3)",[link,'https://www.amazon.com.br/product/'+link,p.category_ids.at(-1)]);
 await db.query('UPDATE discovery_links SET product_id=$2,product_assigned_at=now(),category_confirmed_at=now() WHERE id=$1',[link,p.id]);
 await db.query("INSERT INTO category_mappings(id,marketplace_id,source_path,source_key,category_id) VALUES($1,'amazon',ARRAY['Origem'],$3,$2)",[mapping,p.category_ids.at(-1),mapping]);
 const actor=(await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0];
 await db.query('INSERT INTO saved_filters(id,user_id,name,filters) VALUES($1,$2,$3,$4)',[filter,actor.id,'Filtro',{categoryId:p.category_ids.at(-1),q:'Teste'}]);
 return {link,mapping,filter};
}
async function assertReferences(ref,p){
 const link=(await db.query('SELECT * FROM discovery_links WHERE id=$1',[ref.link])).rows[0];
 assert.equal(link.product_id,p.id);assert.equal(link.confirmed_category_id,p.category_ids.at(-1));assert.ok(link.product_assigned_at);
 assert.equal((await db.query('SELECT category_id FROM category_mappings WHERE id=$1',[ref.mapping])).rows[0].category_id,p.category_ids.at(-1));
 const filters=(await db.query('SELECT filters FROM saved_filters WHERE id=$1',[ref.filter])).rows[0].filters;
 assert.equal(filters.categoryId,p.category_ids.at(-1));assert.equal(filters.q,'Teste');
}

test('renomear mantém IDs e propaga nomes aos produtos/ofertas sem alterar preços, publicação ou referências',async()=>{
 const p=await product(['Renomear','Som','Fones']),offer=await seedOffer(db,{productId:p.id}),refs=await references(p);
 const revision=(await db.query('SELECT revision FROM review_ai_inventory_state')).rows[0].revision;
 const result=await apply({action:'rename',sourceId:p.category_ids[1],name:'Áudio'});
 assert.equal(result.impact.products,1);assert.equal(result.impact.offers,1);
 const updated=await current(p.id);assert.deepEqual(updated.category_ids,p.category_ids);assert.deepEqual(updated.category_path,['Renomear','Áudio','Fones']);assert.equal(updated.sku,p.sku);
 const o=(await db.query('SELECT * FROM offers WHERE id=$1',[offer])).rows[0];assert.deepEqual(o.category_path,updated.category_path);assert.equal(o.status,'published');assert.equal(o.price_cents,99990);
 await assertReferences(refs,updated);assert.ok(Number((await db.query('SELECT revision FROM review_ai_inventory_state')).rows[0].revision)>Number(revision));
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE action='category.rename'")).rows[0].n,1);
});

test('mover mantém a subárvore e os vínculos mesmo quando a confirmação apontava para o ancestral antigo',async()=>{
 const p=await product(['Mover origem','Som','Fones']),target=await product(['Mover destino']);const ref=await references(p);
 await db.query('UPDATE discovery_links SET confirmed_category_id=$2 WHERE id=$1',[ref.link,p.category_ids[0]]);
 await db.query('UPDATE discovery_links SET product_id=$2,product_assigned_at=now() WHERE id=$1',[ref.link,p.id]);
 await apply({action:'move',sourceId:p.category_ids[1],parentId:target.category_ids[0]});
 const updated=await current(p.id);assert.deepEqual(updated.category_path,['Mover destino','Som','Fones']);assert.equal(updated.category_ids[1],p.category_ids[1]);assert.equal(updated.category_ids[2],p.category_ids[2]);await assertReferences(ref,updated);
});

test('unir consolida descendentes homônimos e preserva os exclusivos e as referências',async()=>{
 const a=await product(['Unir origem','Som','Fones']),b=await product(['Unir destino','Som','Fones']),extra=await product(['Unir origem','Cabos']);const ref=await references(a);
 const result=await apply({action:'merge',sourceId:a.category_ids[0],targetId:b.category_ids[0]});assert.equal(result.impact.removedCategories,3);
 const updated=await current(a.id);assert.deepEqual(updated.category_ids,b.category_ids);await assertReferences(ref,updated);
 const moved=await current(extra.id);assert.deepEqual(moved.category_path,['Unir destino','Cabos']);assert.equal(moved.category_ids.at(-1),extra.category_ids.at(-1));
 assert.equal((await db.query('SELECT count(*)::int n FROM category_nodes WHERE id=ANY($1::uuid[])',[a.category_ids])).rows[0].n,0);
});

test('unir com ancestral suporta a reutilização de um caminho removido sem colisão transitória',async()=>{
 const p=await product(['Ancestral','Filho','Filho','Final']);await apply({action:'merge',sourceId:p.category_ids[1],targetId:p.category_ids[0]});
 const updated=await current(p.id);assert.deepEqual(updated.category_path,['Ancestral','Filho','Final']);assert.equal(updated.category_ids[1],p.category_ids[2]);
});

test('excluir exige substituição quando há vínculos e remove só as categorias depois de realocar dependências',async()=>{
 const p=await product(['Excluir árvore','Filho']),target=await product(['Realocação']),refs=await references(p);await seedOffer(db,{productId:p.id});
 assert.equal((await admin.mutate('post',base+'/preview',{action:'delete',sourceId:p.category_ids[0]})).status,400);
 await apply({action:'delete',sourceId:p.category_ids[0],targetId:target.category_ids[0]});const updated=await current(p.id);assert.deepEqual(updated.category_path,['Realocação']);await assertReferences(refs,updated);
 assert.equal((await db.query('SELECT count(*)::int n FROM offers WHERE product_id=$1',[p.id])).rows[0].n,1);
 const empty=(await db.query("SELECT * FROM register_category_path(ARRAY['Árvore vazia','Folha'])")).rows[0];await apply({action:'delete',sourceId:empty.ids[0]});assert.equal((await db.query('SELECT count(*)::int n FROM category_nodes WHERE id=ANY($1::uuid[])',[empty.ids])).rows[0].n,0);
});

test('recusa ciclos, colisões, onze níveis, prévia obsoleta e confirmação ausente sem mudanças parciais',async()=>{
 const p=await product(['Proteção','Filho']),other=await product(['Colisão']);
 for(const input of [{action:'move',sourceId:p.category_ids[0],parentId:p.category_ids[1]},{action:'merge',sourceId:p.category_ids[0],targetId:p.category_ids[0]}])assert.equal((await admin.mutate('post',base+'/preview',input)).status,400);
 assert.equal((await admin.mutate('post',base+'/preview',{action:'rename',sourceId:p.category_ids[0],name:'Colisão'})).status,409);
 const deep=await product(Array.from({length:10},(_,i)=>'Prof '+i));assert.equal((await admin.mutate('post',base+'/preview',{action:'move',sourceId:p.category_ids[0],parentId:deep.category_ids.at(-1)})).status,400);
 const input={action:'rename',sourceId:p.category_ids[0],name:'Atualizada'},pre=await preview(input);
 assert.equal((await admin.mutate('post',base+'/apply',{...input,revision:pre.revision})).status,400);
 await product(['Mudança concorrente']);assert.equal((await admin.mutate('post',base+'/apply',{...input,revision:pre.revision,confirm:true})).status,409);
 assert.deepEqual((await current(p.id)).category_path,p.category_path);
});

test('listagem paginada e operações exigem sessão, catalog, XSRF e confirmação administrativa recente',async()=>{
 const p=await product(['Busca única','Filho']);const input={action:'rename',sourceId:p.category_ids[0],name:'Nova busca'};
 const list=await admin.get(base+'?page=1&pageSize=1&q=Busca%20única');assert.equal(list.status,200);assert.equal(list.body.total,2);assert.equal(list.body.items.length,1);assert.equal(list.body.items[0].product_count,1);
 assert.equal((await user.get(base)).status,403);assert.equal((await user.mutate('post',base+'/preview',input)).status,403);
 assert.equal((await admin.agent.post(base+'/preview').send(input)).status,403);
 const editor=client(app);await editor.login('editor-categories');const uid=(await db.query("SELECT id FROM users WHERE email='editor-categories@gmail.com'")).rows[0].id;
 const profile=randomUUID();await db.query("INSERT INTO access_profiles(id,name,permissions) VALUES($1,'Editor de categorias',ARRAY['catalog'])",[profile]);await db.query('UPDATE users SET access_profile_id=$2 WHERE id=$1',[uid,profile]);
 assert.equal((await editor.get(base)).status,200);assert.equal((await editor.mutate('post',base+'/preview',input)).status,200);
 await db.query('UPDATE sessions SET admin_verified_at=NULL WHERE user_id=$1',[uid]);assert.equal((await editor.mutate('post',base+'/preview',input)).body.code,'ADMIN_REAUTH_REQUIRED');
});

test('falha durante exclusão desfaz realocação, referências, opções e auditoria',async()=>{
 const p=await product(['Rollback categoria','Folha']),target=await product(['Rollback destino']),refs=await references(p);
 const remembered=(await db.query('SELECT * FROM offer_category_options ORDER BY category,subcategory')).rows;
 const input={action:'delete',sourceId:p.category_ids[0],targetId:target.category_ids[0]},pre=await preview(input);
 const faulty={...db,connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(sql,args)=>{if(sql.startsWith('INSERT INTO offer_category_options'))throw new Error('Falha simulada no banco');return c.query(sql,args);}};}};
 const isolated=client(createApp(faulty,testConfig(),{verifyGoogle:async t=>identity(t)}));await isolated.login('admin');
 const result=await isolated.mutate('post',base+'/apply',{...input,revision:pre.revision,confirm:true});assert.equal(result.status,500);
 const updated=await current(p.id);assert.deepEqual(updated.category_path,p.category_path);assert.deepEqual(updated.category_ids,p.category_ids);await assertReferences(refs,updated);
 assert.deepEqual((await db.query('SELECT * FROM offer_category_options ORDER BY category,subcategory')).rows,remembered);
 assert.equal((await db.query('SELECT count(*)::int n FROM category_nodes WHERE id=ANY($1::uuid[])',[p.category_ids])).rows[0].n,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action='category.delete'",[p.category_ids[0]])).rows[0].n,0);
});

test('união reaproveita a grafia do pai existente também nos descendentes exclusivos',async()=>{
 const a=await product(['Grafia origem','som','Cabos']),b=await product(['Grafia destino','Som']);
 await apply({action:'merge',sourceId:a.category_ids[0],targetId:b.category_ids[0]});
 assert.deepEqual((await current(a.id)).category_path,['Grafia destino','Som','Cabos']);
 const child=(await db.query('SELECT path FROM category_nodes WHERE id=$1',[a.category_ids.at(-1)])).rows[0];assert.deepEqual(child.path,['Grafia destino','Som','Cabos']);
});
