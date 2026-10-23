import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,testConfig,client,createApp,identity} from './helpers.mjs';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}),admin=client(app),alice=client(app);await admin.login('admin');const user=(await alice.login('alice')).body.user;return {db,app,admin,alice,user};}
const change=(admin,u,profileId,blocked=false)=>admin.mutate('patch','/api/admin/users/'+u.id,{profileId,blocked,expectedProfileId:u.access_profile_id??'user',expectedBlocked:u.blocked??false});

test('lista usuários com filtros e paginação, sem expor identidade Google ou sessões',async t=>{
 const {admin,alice}=await fixture(t);assert.equal((await alice.get('/api/admin/users')).status,403);
 const r=await admin.get('/api/admin/users?q=ALICE&status=active&profile=user');assert.equal(r.status,200);assert.equal(r.body.total,1);assert.equal(r.body.items[0].email,'alice@gmail.com');assert.equal(r.body.pageSize,25);assert.equal(r.body.items[0].google_sub,undefined);
 assert.equal((await admin.get('/api/admin/users?page=0')).status,400);assert.equal((await admin.get('/api/admin/users?page=2')).body.items.length,0);
 const profiles=await admin.get('/api/admin/access-profiles');assert.equal(profiles.body.permissions.length,10);assert.ok(profiles.body.permissions.some(p=>p.id==='affiliate_links'));assert.ok(profiles.body.permissions.some(p=>p.id==='purge'));assert.ok(profiles.body.profiles.some(p=>p.id==='admin'&&p.system));
});
test('editor recebe acesso apenas ao catálogo; alterações de perfil afetam a sessão já aberta',async t=>{
 const {admin,alice,user}=await fixture(t);assert.equal((await change(admin,user,'editor')).status,200);
 const session=await alice.init();assert.deepEqual(session.body.user.permissions,['catalog']);assert.equal(session.body.user.role,'user');
 for(const path of ['products','category-tree','catalog-marketplaces','offers','link-imports'])assert.equal((await alice.get('/api/admin/'+path)).status,200,path);
 for(const path of ['users','access-profiles','audit','stats','offer-refresh','selectors/amazon','marketplaces','rules'])assert.equal((await alice.get('/api/admin/'+path)).status,403,path);
 assert.equal((await alice.mutate('post','/api/admin/catalog-marketplaces',{})).status,403);
 assert.equal((await alice.mutate('post','/api/admin/access-profiles',{name:'Escalada',permissions:['users']})).status,403);
 assert.equal((await change(admin,{...user,access_profile_id:'editor'},'user')).status,200);assert.equal((await alice.get('/api/admin/products')).status,403);
});
test('perfis personalizados: validação, edição versionada, auditoria e exclusão protegida',async t=>{
 const {admin,alice,user,db}=await fixture(t);
 assert.equal((await admin.mutate('post','/api/admin/access-profiles',{name:'Inválido',permissions:['root']})).status,400);
 const created=await admin.mutate('post','/api/admin/access-profiles',{name:'Operação',permissions:['updates','updates']});assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await admin.mutate('post','/api/admin/access-profiles',{name:'operação',permissions:[]})).status,409);
 assert.equal((await change(admin,user,id)).status,200);assert.equal((await alice.get('/api/admin/extension-catalog/runs')).status,200);assert.equal((await alice.get('/api/admin/products')).status,403);
 assert.equal((await admin.mutate('delete','/api/admin/access-profiles/'+id)).status,409);
 const p=(await admin.get('/api/admin/access-profiles')).body.profiles.find(p=>p.id===id);
 const updated=await admin.mutate('put','/api/admin/access-profiles/'+id,{name:'Métricas',permissions:['overview'],expectedUpdatedAt:p.updated_at});assert.equal(updated.status,200,JSON.stringify(updated.body));
 assert.equal((await alice.get('/api/admin/extension-catalog/runs')).status,403);assert.equal((await alice.get('/api/admin/stats')).status,200);
 assert.equal((await admin.mutate('put','/api/admin/access-profiles/'+id,{name:'Antigo',permissions:[],expectedUpdatedAt:p.updated_at})).status,409);
 assert.equal((await change(admin,{...user,access_profile_id:id},'user')).status,200);assert.equal((await admin.mutate('delete','/api/admin/access-profiles/'+id)).status,200);
 assert.ok((await db.query("SELECT id FROM audit_logs WHERE action='profile.updated'")).rows.length);
 for(const id of ['admin','user']){assert.equal((await admin.mutate('delete','/api/admin/access-profiles/'+id)).status,409);assert.equal((await admin.mutate('put','/api/admin/access-profiles/'+id,{name:'Troca',permissions:[],expectedUpdatedAt:new Date().toISOString()})).status,409);}
});
test('bloqueio revoga sessões e impede login Google; desbloqueio permite novo login',async t=>{
 const {admin,alice,user,db}=await fixture(t);assert.equal((await change(admin,user,'user',true)).status,200);assert.equal((await db.query('SELECT id FROM sessions WHERE user_id=$1',[user.id])).rows.length,0);assert.equal((await alice.get('/api/me/favorites')).status,401);assert.equal((await alice.login('alice')).status,403);
 assert.equal((await admin.get('/api/admin/users?status=blocked')).body.total,1);
 assert.equal((await change(admin,{...user,blocked:true},'user')).status,200);assert.equal((await alice.login('alice')).status,200);
});
test('protege próprio acesso, último administrador, conflitos e XSRF',async t=>{
 const {admin,alice,user}=await fixture(t);const own=(await admin.init()).body.user;
 assert.equal((await change(admin,own,'user')).status,409);assert.equal((await change(admin,own,'admin',true)).status,409);
 assert.equal((await change(admin,user,'inexistente')).status,400);
 assert.equal((await admin.agent.patch('/api/admin/users/'+user.id).send({profileId:'admin',blocked:false})).status,403);
 assert.equal((await change(admin,user,'admin')).status,200);assert.equal((await change(admin,user,'editor')).status,409);
 const promoted={...user,access_profile_id:'admin'};assert.equal((await change(alice,own,'user')).status,200);
 assert.equal((await change(admin,promoted,'user')).status,403);assert.equal((await change(alice,promoted,'user')).status,409);
});
test('gestor delegado não consegue remover ou bloquear o último administrador ativo',async t=>{
 const {admin,alice,user}=await fixture(t),own=(await admin.init()).body.user;
 const p=await admin.mutate('post','/api/admin/access-profiles',{name:'Gestor de acessos',permissions:['users']});
 assert.equal((await change(admin,user,p.body.id)).status,200);
 assert.equal((await alice.get('/api/admin/users')).status,200);
 assert.equal((await change(alice,own,'user')).status,409);
 assert.equal((await change(alice,own,'admin',true)).status,409);
});
